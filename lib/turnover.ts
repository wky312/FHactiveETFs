import { supabase, supabaseReady } from './supabase';

/* 經理人換手率（周轉率）— 用共用 Supabase 的每日全量持股快照差分估算。
   ──────────────────────────────────────────────────────────────────
   作法：對每檔 ETF，取區間內每日持股快照（含區間前最後一筆當差分起點），
   逐日對相鄰快照差分：
     買進金額 = Σ max(0, 今日股數 − 昨日股數) × 當日成本基準價(avg，缺則 close)
     賣出金額 = Σ max(0, 昨日股數 − 今日股數) × 當日成本基準價
     當日AUM  = Σ 今日股數 × 當日收盤
   期間換手率 = min(Σ買進, Σ賣出) / 平均AUM（SEC 周轉率口徑，取買賣較小邊）
   年化換手率 = 期間換手率 × (365 / 首末快照日曆天)
   高換手＝頻繁擇時/調倉；低換手＝買進持有。報酬未涉入，純倉位變動。 */

export interface TurnoverRow {
  ticker: string;
  name: string;
  issuer: string;
  holdingDate: string | null;   // 採用的最新持股日
  firstDate: string | null;     // 區間內首個持股快照日（掛牌覆蓋判斷用）
  nSnapshots: number;           // 區間內快照數
  spanDays: number;             // 首末快照日曆天
  avgAumE: number | null;       // 平均AUM（億）
  buyValueE: number | null;     // 期間總買進（億）
  sellValueE: number | null;    // 期間總賣出（億）
  turnoverPeriod: number | null;  // 期間換手率 %
  turnoverAnnual: number | null;  // 年化換手率 %
}

export interface TurnoverResult {
  startDate: string;
  endDate: string;
  rows: TurnoverRow[];
}

const TTL_MS = 10 * 60 * 1000;
const _cache = new Map<string, { ts: number; data: TurnoverResult }>();
const ID_CHUNK = 150;
const PAGE = 1000;
const FUND_CONCURRENCY = 4;

async function latestPriceDate(onOrBefore?: string): Promise<string | null> {
  let q = supabase!.from('price').select('date').order('date', { ascending: false }).limit(1);
  if (onOrBefore) q = q.lte('date', onOrBefore);
  const { data } = await q.maybeSingle();
  return (data?.date as string) ?? null;
}

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await build(from, from + PAGE - 1);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i]); }
  }));
  return out;
}

interface HoldRow { date: string; stockid: string; qshare: number | null }

async function priceWindow(ids: string[], startDate: string, endDate: string): Promise<Map<string, Map<string, { avg: number | null; close: number | null }>>> {
  const out = new Map<string, Map<string, { avg: number | null; close: number | null }>>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const batch = ids.slice(i, i + ID_CHUNK);
    const rows = await fetchAll<{ stockid: string; date: string; avg: number | null; close: number | null }>((from, to) =>
      supabase!.from('price').select('stockid,date,avg,close')
        .in('stockid', batch).gte('date', startDate).lte('date', endDate).range(from, to));
    for (const r of rows) {
      if (!out.has(r.stockid)) out.set(r.stockid, new Map());
      out.get(r.stockid)!.set(r.date, {
        avg: r.avg == null ? null : Number(r.avg),
        close: r.close == null ? null : Number(r.close),
      });
    }
  }
  return out;
}

// 某檔基金在 [start,end] 的快照（含區間前 baseline 當差分起點）
async function fundSnapshots(ticker: string, startDate: string, endDate: string): Promise<{ byDate: Map<string, Map<string, number>>; dates: string[]; ids: Set<string>; baselineDate: string | null }> {
  const { data: base } = await supabase!
    .from('holding').select('date').eq('ticker', ticker).lt('date', startDate)
    .order('date', { ascending: false }).limit(1).maybeSingle();
  const baselineDate = (base?.date as string) ?? null;
  const fetchFrom = baselineDate ?? startDate;

  const rows = await fetchAll<HoldRow>((from, to) =>
    supabase!.from('holding').select('date,stockid,qshare')
      .eq('ticker', ticker).gte('date', fetchFrom).lte('date', endDate)
      .order('date', { ascending: true }).range(from, to));

  const byDate = new Map<string, Map<string, number>>();
  const ids = new Set<string>();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, new Map());
    byDate.get(r.date)!.set(r.stockid, Number(r.qshare ?? 0));
    ids.add(r.stockid);
  }
  return { byDate, dates: [...byDate.keys()].sort(), ids, baselineDate };
}

export async function computeTurnover(fromReq: string, toReq?: string): Promise<TurnoverResult> {
  if (!supabaseReady || !supabase) throw new Error('Supabase 未設定（缺 NEXT_PUBLIC_SUPABASE_URL / KEY）');

  const cacheKey = `${fromReq}|${toReq ?? ''}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

  const endDate = await latestPriceDate(toReq);
  const startDate = await latestPriceDate(fromReq);
  if (!endDate || !startDate) throw new Error('查無股價資料');
  if (startDate >= endDate) throw new Error('區間太短（起訖日相同），請拉長區間');

  const { data: etfs } = await supabase
    .from('etf').select('ticker,name,issuer')
    .eq('market', 'tw').eq('type', 'equity').order('ticker');
  const etfList = (etfs ?? []) as { ticker: string; name: string; issuer: string }[];

  const rows = await mapLimit(etfList, FUND_CONCURRENCY, async (e): Promise<TurnoverRow> => {
    const { byDate, dates, ids, baselineDate } = await fundSnapshots(e.ticker, startDate, endDate);
    const firstInWindow = dates.find(d => d >= startDate) ?? null;
    const empty: TurnoverRow = {
      ticker: e.ticker, name: e.name, issuer: e.issuer, holdingDate: dates.length ? dates[dates.length - 1] : null,
      firstDate: firstInWindow,
      nSnapshots: 0, spanDays: 0, avgAumE: null, buyValueE: null, sellValueE: null, turnoverPeriod: null, turnoverAnnual: null,
    };
    if (dates.length < 2) return empty;

    const prices = await priceWindow([...ids], startDate, endDate);
    const basisOf = (s: string, d: string) => {
      const p = prices.get(s)?.get(d);
      return p?.avg ?? p?.close ?? null;
    };

    // 統一：dates[0] 當差分起點(baseline 或首個快照，其持倉不計為買進)，對 dates[1..] 逐日差分。
    // baseline 存在時 dates[0]=區間前快照，dates[1] 起為區間內交易；無 baseline 時 dates[0]=首個區間內快照。
    void baselineDate;
    const iterDates = dates.slice(1);
    const prev = new Map(byDate.get(dates[0])!);

    let buyVal = 0, sellVal = 0;
    const aumByDate: number[] = [];
    for (const d of iterDates) {
      const snap = byDate.get(d)!;
      let aum = 0;
      for (const s of ids) {
        const q = snap.get(s) ?? 0;
        const pq = prev.get(s) ?? 0;
        const delta = q - pq;
        const basis = basisOf(s, d);
        if (basis != null && delta !== 0) {
          if (delta > 0) buyVal += delta * basis;
          else sellVal += -delta * basis;
        }
        const close = prices.get(s)?.get(d)?.close ?? null;
        if (close != null) aum += q * close;
        prev.set(s, q);
      }
      if (aum > 0) aumByDate.push(aum);
    }

    const avgAum = aumByDate.length ? aumByDate.reduce((s, x) => s + x, 0) / aumByDate.length : null;
    // 觀測到交易的窗口跨度＝首個差分日(iterDates[0]) 到最後一日
    const spanDays = Math.max(1, Math.round((new Date(dates[dates.length - 1]).getTime() - new Date(iterDates[0]).getTime()) / 86400000));
    const turnoverPeriod = (avgAum && avgAum > 0) ? Math.min(buyVal, sellVal) / avgAum * 100 : null;
    const turnoverAnnual = turnoverPeriod != null ? turnoverPeriod * (365 / spanDays) : null;

    return {
      ticker: e.ticker, name: e.name, issuer: e.issuer, holdingDate: dates[dates.length - 1],
      firstDate: firstInWindow,
      nSnapshots: iterDates.length, spanDays,
      avgAumE: avgAum != null ? avgAum / 1e8 : null,
      buyValueE: buyVal / 1e8, sellValueE: sellVal / 1e8,
      turnoverPeriod, turnoverAnnual,
    };
  });

  rows.sort((a, b) => (b.turnoverAnnual ?? -Infinity) - (a.turnoverAnnual ?? -Infinity));
  const data: TurnoverResult = { startDate, endDate, rows };
  _cache.set(cacheKey, { ts: Date.now(), data });
  return data;
}
