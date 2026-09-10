import { supabase, supabaseReady } from './supabase';

/* 全 19 檔主動式 ETF「同區間選股」總覽 — 進場成本(window-buy VWAP)口徑
   ──────────────────────────────────────────────────────────────────
   資料源＝共用 Supabase（twActiveETFs 的 holding / price 表，每日全量快照）。

   口徑（評「這個區間的選股/進場」，不是現有持股的收盤漲跌）：
   1. 對每檔基金，用「每日持股快照」差分，找出區間 [startDate, endDate] 內每天
      「加碼/新進的股數」(delta = max(0, 今日股數 − 昨日股數))。holding 是全量快照，
      某日未列出該股即視為 0 股（賣光），故重新進場也能正確抓到。
   2. 每筆加碼股數 × 當日成本基準價(price.avg 成交均價) 加總 →「本期進場 VWAP」。
   3. 跟現價(endDate 收盤)比 → 賺/賠。例：某股整體持倉均價被歷史便宜成本稀釋到 100，
      但本區間加碼 VWAP=200、現價150 → 算「賠錢」(評的是這段期間的進場決策)。
   4. 只評估「本區間有買進」的個股(Σdelta>0)；加權報酬以「本期投入金額」為權重。

   注意：每檔各取「自身最新持股日(≤endDate)」當 as-of；baseline(區間前最後一筆快照)
   用來界定「區間內才加碼」的部分，避免把進場前就持有的部位誤算成本期進場。報酬未還原息。*/

export interface FundComparisonRow {
  ticker: string;
  name: string;
  issuer: string;
  holdingDate: string | null;    // 該檔採用的最新持股日(as-of)
  nPicks: number;                // 本區間有加碼/新進的個股數(可評估)
  nWin: number;
  nLoss: number;
  winRate: number | null;        // 進場後賺錢的檔數比例
  weightedReturn: number | null; // 依「本期投入金額」加權的「進場至今」報酬 %
  avgWin: number | null;
  avgLoss: number | null;
  payoff: number | null;
  investedK: number | null;      // 本期投入金額估計(仟元) = Σ(加碼股數×當日avg)/1000
}

export interface MarketComparison {
  startDate: string;
  endDate: string;
  funds: FundComparisonRow[];
}

const TTL_MS = 10 * 60 * 1000;
const _cache = new Map<string, { ts: number; data: MarketComparison }>();
const ID_CHUNK = 150;      // in() URL 長度上限保護
const PAGE = 1000;         // PostgREST 單頁列數
const FUND_CONCURRENCY = 4;

const mean = (xs: number[]): number | null => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;

async function latestPriceDate(onOrBefore?: string): Promise<string | null> {
  let q = supabase!.from('price_adj').select('date').order('date', { ascending: false }).limit(1);
  if (onOrBefore) q = q.lte('date', onOrBefore);
  const { data } = await q.maybeSingle();
  return (data?.date as string) ?? null;
}

// 對單一 query builder 分頁抓全部列（PostgREST 預設 1000 列上限）。
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

interface HoldRow { date: string; stockid: string; qshare: number | null }
interface AddEvent { stockid: string; date: string; delta: number }

// 某檔基金在 [start, end] 區間的「每日加碼事件」(含區間前 baseline 作為差分起點)。
async function fundAdditions(ticker: string, startDate: string, endDate: string): Promise<AddEvent[]> {
  // baseline：區間起日「之前」最後一筆快照日，作為差分起點(避免把進場前就持有的部位當成本期加碼)
  const { data: base } = await supabase!
    .from('holding_adj').select('date').eq('ticker', ticker).lt('date', startDate)
    .order('date', { ascending: false }).limit(1).maybeSingle();
  const baselineDate = (base?.date as string) ?? null;
  const fetchFrom = baselineDate ?? startDate;

  // holding_adj：qshare 已依 corp_action 還原到最新股數基準，跨除權日的股數差分不會灌出假加碼
  const rows = await fetchAll<HoldRow>((from, to) =>
    supabase!.from('holding_adj').select('date,stockid,qshare')
      .eq('ticker', ticker).gte('date', fetchFrom).lte('date', endDate)
      .order('date', { ascending: true }).range(from, to));

  // 重建 Map<date, Map<stockid, qshare>> 與排序後的日期列
  const byDate = new Map<string, Map<string, number>>();
  const stockUniverse = new Set<string>();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, new Map());
    byDate.get(r.date)!.set(r.stockid, Number(r.qshare ?? 0));
    stockUniverse.add(r.stockid);
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length === 0) return [];

  // baseline 那一天只當差分起點，不計入加碼；之後每個區間內交易日逐日差分。
  const hasBaseline = baselineDate != null && dates[0] === baselineDate;
  const windowDates = hasBaseline ? dates.slice(1) : dates;
  const prev = new Map<string, number>();
  if (hasBaseline) for (const [s, q] of byDate.get(baselineDate!)!) prev.set(s, q);

  const events: AddEvent[] = [];
  for (const d of windowDates) {
    const snap = byDate.get(d)!;
    for (const s of stockUniverse) {
      const q = snap.get(s) ?? 0;               // 全量快照：未列出 = 0 股
      const delta = q - (prev.get(s) ?? 0);
      if (delta > 0) events.push({ stockid: s, date: d, delta });
      prev.set(s, q);
    }
  }
  return events;
}

// 一組個股在 [start,end] 區間的價格表：Map<stockid, Map<date, {avg, close}>>。
async function priceWindow(ids: string[], startDate: string, endDate: string): Promise<Map<string, Map<string, { avg: number | null; close: number | null }>>> {
  const out = new Map<string, Map<string, { avg: number | null; close: number | null }>>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const batch = ids.slice(i, i + ID_CHUNK);
    const rows = await fetchAll<{ stockid: string; date: string; avg: number | null; close: number | null }>((from, to) =>
      supabase!.from('price_adj').select('stockid,date,avg,close')
        .in('stockid', batch).gte('date', startDate).lte('date', endDate)
        .range(from, to));
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

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export async function computeMarketComparison(fromReq: string, toReq?: string): Promise<MarketComparison> {
  if (!supabaseReady || !supabase) throw new Error('Supabase 未設定（缺 NEXT_PUBLIC_SUPABASE_URL / KEY）');

  const cacheKey = `v2|${fromReq}|${toReq ?? ''}`;
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

  // 1) 每檔的「本區間加碼事件」+ 自身最新持股日(as-of 顯示用)
  const perFund = await mapLimit(etfList, FUND_CONCURRENCY, async (e) => {
    const [events, latest] = await Promise.all([
      fundAdditions(e.ticker, startDate, endDate),
      supabase!.from('holding_adj').select('date').eq('ticker', e.ticker).lte('date', endDate)
        .order('date', { ascending: false }).limit(1).maybeSingle(),
    ]);
    return { e, events, holdingDate: (latest.data?.date as string) ?? null };
  });

  // 2) 取所有被加碼的個股，一次抓區間價格表
  const ids = [...new Set(perFund.flatMap((f) => f.events.map((ev) => ev.stockid)))];
  const prices = await priceWindow(ids, startDate, endDate);

  // 3) 逐檔結算：每股 進場VWAP vs 現價
  const funds: FundComparisonRow[] = perFund.map(({ e, events, holdingDate }) => {
    // 彙總同股多日加碼 → Σ(delta) 與 Σ(delta×當日avg)
    const agg = new Map<string, { shares: number; cost: number }>();
    for (const ev of events) {
      const pAvg = prices.get(ev.stockid)?.get(ev.date)?.avg;
      const basis = pAvg ?? prices.get(ev.stockid)?.get(ev.date)?.close;  // avg 缺則退收盤
      if (basis == null) continue;
      const a = agg.get(ev.stockid) ?? { shares: 0, cost: 0 };
      a.shares += ev.delta;
      a.cost += ev.delta * basis;
      agg.set(ev.stockid, a);
    }

    const items = [...agg.entries()].map(([stockid, a]) => {
      const vwap = a.shares > 0 ? a.cost / a.shares : null;
      const cur = prices.get(stockid)?.get(endDate)?.close;
      const ret = (vwap != null && vwap > 0 && cur != null) ? (cur - vwap) / vwap * 100 : null;
      return { invested: a.cost, ret };
    }).filter((i) => i.ret != null) as { invested: number; ret: number }[];

    const wins = items.filter((i) => i.ret > 0);
    const losses = items.filter((i) => i.ret < 0);
    const avgWin = mean(wins.map((i) => i.ret));
    const avgLoss = mean(losses.map((i) => i.ret));
    const sumInv = items.reduce((s, i) => s + i.invested, 0);
    return {
      ticker: e.ticker, name: e.name, issuer: e.issuer, holdingDate,
      nPicks: items.length, nWin: wins.length, nLoss: losses.length,
      winRate: items.length ? wins.length / items.length * 100 : null,
      weightedReturn: sumInv > 0 ? items.reduce((s, i) => s + i.invested * i.ret, 0) / sumInv : null,
      avgWin, avgLoss,
      payoff: (avgWin != null && avgLoss != null && avgLoss !== 0) ? avgWin / Math.abs(avgLoss) : null,
      investedK: sumInv > 0 ? sumInv / 1000 : null,
    };
  });

  funds.sort((a, b) => (b.weightedReturn ?? -Infinity) - (a.weightedReturn ?? -Infinity));
  const data: MarketComparison = { startDate, endDate, funds };
  _cache.set(cacheKey, { ts: Date.now(), data });
  return data;
}
