import { supabase, supabaseReady } from './supabase';

/* 共識持股 / 獨家壓注 — 全 19 檔主動式 ETF 最新持股的橫向統計。
   ──────────────────────────────────────────────────────────────────
   對每檔 ETF 取自身最新持股快照(≤ asOf)，彙總每一檔個股「被幾檔 ETF 同時持有」、
   合計/平均/最大權重。被最多檔持有＝市場共識(crowding)；只被 1 檔持有＝該檔獨家壓注。
   資料源＝共用 Supabase holding 表(含 stockname/prate 佔比)。 */

export interface ConsensusStock {
  stockid: string;
  stockname: string;
  heldBy: number;          // 持有檔數
  holders: string[];       // 持有的 ETF ticker
  sumWeight: number;       // 各檔佔比合計 %
  avgWeight: number;       // 持有者平均佔比 %
  maxWeight: number;       // 單檔最大佔比 %
  maxHolder: string;       // 最大佔比的 ETF
}
export interface ConsensusFund {
  ticker: string;
  name: string;
  holdingDate: string | null;
  nHoldings: number;
  nSolo: number;           // 該檔的獨家持股數(只有它持有)
}
export interface ConsensusResult {
  asOf: string;
  nFunds: number;
  funds: ConsensusFund[];
  stocks: ConsensusStock[];
}

const TTL_MS = 10 * 60 * 1000;
const _cache = new Map<string, { ts: number; data: ConsensusResult }>();
const PAGE = 1000;
const FUND_CONCURRENCY = 4;

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

function isCashLike(stockid: string, stockname: string): boolean {
  if (!stockid.trim()) return true;
  return /^(CASH|現金|TWD|NTD)$|現金|存款|期貨|AFTER DEDUCTING/i.test(stockname.trim());
}

interface HoldRow { stockid: string; stockname: string; prate: number | string | null }

export async function computeConsensus(asOfReq?: string): Promise<ConsensusResult> {
  if (!supabaseReady || !supabase) throw new Error('Supabase 未設定（缺 NEXT_PUBLIC_SUPABASE_URL / KEY）');

  const cacheKey = asOfReq ?? 'latest';
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

  const { data: etfs } = await supabase
    .from('etf').select('ticker,name')
    .eq('market', 'tw').eq('type', 'equity').order('ticker');
  const etfList = (etfs ?? []) as { ticker: string; name: string }[];
  if (!etfList.length) throw new Error('查無 ETF 清單');

  // 每檔取自身最新持股日(≤ asOf)的整份快照
  const perFund = await mapLimit(etfList, FUND_CONCURRENCY, async (e) => {
    let dq = supabase!.from('holding').select('date').eq('ticker', e.ticker).order('date', { ascending: false }).limit(1);
    if (asOfReq) dq = dq.lte('date', asOfReq);
    const { data: latest } = await dq.maybeSingle();
    const holdingDate = (latest?.date as string) ?? null;
    if (!holdingDate) return { e, holdingDate: null, rows: [] as HoldRow[] };
    const rows = await fetchAll<HoldRow>((from, to) =>
      supabase!.from('holding').select('stockid,stockname,prate')
        .eq('ticker', e.ticker).eq('date', holdingDate).range(from, to));
    return { e, holdingDate, rows };
  });

  // 彙總每檔個股的橫向持有情形
  const agg = new Map<string, { stockname: string; holders: { ticker: string; w: number }[] }>();
  const fundHoldStocks = new Map<string, Set<string>>();
  for (const { e, rows } of perFund) {
    const seen = new Set<string>();
    for (const r of rows) {
      const stockid = String(r.stockid ?? '').trim();
      const stockname = String(r.stockname ?? '').trim();
      if (isCashLike(stockid, stockname)) continue;
      if (seen.has(stockid)) continue;       // 同檔同日去重
      seen.add(stockid);
      const w = r.prate == null ? 0 : Number(r.prate);
      const a = agg.get(stockid) ?? { stockname, holders: [] };
      if (!a.stockname && stockname) a.stockname = stockname;
      a.holders.push({ ticker: e.ticker, w: isNaN(w) ? 0 : w });
      agg.set(stockid, a);
    }
    fundHoldStocks.set(e.ticker, seen);
  }

  // solo（獨家壓注）股票集合：只被 1 檔持有
  const soloStocks = new Set<string>();
  for (const [stockid, a] of agg) if (a.holders.length === 1) soloStocks.add(stockid);

  const stocks: ConsensusStock[] = [...agg.entries()].map(([stockid, a]) => {
    const ws = a.holders.map(h => h.w);
    const sumWeight = ws.reduce((s, x) => s + x, 0);
    const maxIdx = ws.reduce((mi, x, i, arr) => x > arr[mi] ? i : mi, 0);
    return {
      stockid, stockname: a.stockname,
      heldBy: a.holders.length,
      holders: a.holders.map(h => h.ticker),
      sumWeight,
      avgWeight: a.holders.length ? sumWeight / a.holders.length : 0,
      maxWeight: ws.length ? ws[maxIdx] : 0,
      maxHolder: a.holders.length ? a.holders[maxIdx].ticker : '',
    };
  }).sort((x, y) => y.heldBy - x.heldBy || y.sumWeight - x.sumWeight);

  const funds: ConsensusFund[] = perFund.map(({ e, holdingDate }) => {
    const held = fundHoldStocks.get(e.ticker) ?? new Set();
    let nSolo = 0;
    for (const s of held) if (soloStocks.has(s)) nSolo++;
    return { ticker: e.ticker, name: e.name, holdingDate, nHoldings: held.size, nSolo };
  });

  const asOf = perFund.reduce((mx, f) => (f.holdingDate && f.holdingDate > mx ? f.holdingDate : mx), '');

  const data: ConsensusResult = { asOf, nFunds: etfList.length, funds, stocks };
  _cache.set(cacheKey, { ts: Date.now(), data });
  return data;
}
