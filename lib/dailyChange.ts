import { supabase, supabaseReady } from './supabase';
import { fetchAll, mapLimit, isCashLike, closesByDate } from './consensus';

/* 同業當日加減碼 — 全 19 檔主動式 ETF「最新持股日 vs 前一個持股日」的個股股數變動。
   ──────────────────────────────────────────────────────────────────
   口徑＝「全部異動」：原始 Δqshare，不扣除申購贖回造成的等比例稀釋。
   每檔 ETF 各自取自己的最新持股日與其前一個持股日（各檔揭露日不一定同步，所以日期是逐檔回傳）。
   前端依使用者勾選的 ETF 在本地彙總，切換不需重打 API，故這裡一律回傳全 19 檔。

   金額 = Δ股數 × 最新持股日收盤價（沿用共識持股的「往前回溯」收盤窗口，休市日也有價）。
   沒有報價的個股（如海外股）close 為 null，前端顯示「—」、不計入金額合計。 */

export interface DailyChangeFund {
  ticker: string;
  name: string;
  curDate: string | null;
  prevDate: string | null;
}
export interface DailyChangeEntry {
  ticker: string;
  prev: number;   // 前一持股日股數（新倉為 0）
  cur: number;    // 最新持股日股數（清倉為 0）
}
export interface DailyChangeStock {
  stockid: string;
  stockname: string;
  close: number | null;
  changes: DailyChangeEntry[];   // 只含股數有變動的 ETF
}
export interface DailyChangeResult {
  asOf: string;
  funds: DailyChangeFund[];
  stocks: DailyChangeStock[];
}

interface HoldRow { stockid: string; stockname: string; qshare: number | string | null }

const TTL_MS = 10 * 60 * 1000;
let _cache: { ts: number; data: DailyChangeResult } | null = null;
const FUND_CONCURRENCY = 4;

async function loadSnapshot(ticker: string, date: string): Promise<Map<string, { name: string; q: number }>> {
  const rows = await fetchAll<HoldRow>((from, to) =>
    supabase!.from('holding').select('stockid,stockname,qshare')
      .eq('ticker', ticker).eq('date', date).range(from, to));
  const m = new Map<string, { name: string; q: number }>();
  for (const r of rows) {
    const id = String(r.stockid ?? '').trim();
    const name = String(r.stockname ?? '').trim();
    if (isCashLike(id, name) || m.has(id)) continue;   // 同檔同日去重
    const q = r.qshare == null ? NaN : Number(r.qshare);
    if (isNaN(q)) continue;
    m.set(id, { name, q });
  }
  return m;
}

export async function computeDailyChange(): Promise<DailyChangeResult> {
  if (!supabaseReady || !supabase) throw new Error('Supabase 未設定（缺 NEXT_PUBLIC_SUPABASE_URL / KEY）');
  if (_cache && Date.now() - _cache.ts < TTL_MS) return _cache.data;

  const { data: etfs } = await supabase
    .from('etf').select('ticker,name')
    .eq('market', 'tw').eq('type', 'equity').order('ticker');
  const etfList = (etfs ?? []) as { ticker: string; name: string }[];
  if (!etfList.length) throw new Error('查無 ETF 清單');

  const perFund = await mapLimit(etfList, FUND_CONCURRENCY, async (e) => {
    const { data: cur } = await supabase!.from('holding').select('date')
      .eq('ticker', e.ticker).order('date', { ascending: false }).limit(1).maybeSingle();
    const curDate = (cur?.date as string) ?? null;
    if (!curDate) return { e, curDate: null, prevDate: null, curMap: null, prevMap: null };
    const { data: prv } = await supabase!.from('holding').select('date')
      .eq('ticker', e.ticker).lt('date', curDate).order('date', { ascending: false }).limit(1).maybeSingle();
    const prevDate = (prv?.date as string) ?? null;
    const curMap = await loadSnapshot(e.ticker, curDate);
    const prevMap = prevDate ? await loadSnapshot(e.ticker, prevDate) : null;
    return { e, curDate, prevDate, curMap, prevMap };
  });

  // 逐檔算 Δ，彙整成 stockid → 各 ETF 變動
  const agg = new Map<string, { stockname: string; changes: DailyChangeEntry[] }>();
  for (const { e, curMap, prevMap } of perFund) {
    if (!curMap || !prevMap) continue;   // 沒有前一日可比就不算（避免整份持股被當成新倉）
    for (const id of new Set([...curMap.keys(), ...prevMap.keys()])) {
      const cur = curMap.get(id)?.q ?? 0;
      const prev = prevMap.get(id)?.q ?? 0;
      if (cur === prev) continue;
      const a = agg.get(id) ?? { stockname: curMap.get(id)?.name || prevMap.get(id)?.name || id, changes: [] };
      a.changes.push({ ticker: e.ticker, prev, cur });
      agg.set(id, a);
    }
  }

  // 只替「有變動」的個股補收盤價
  const dates = [...new Set(perFund.map(f => f.curDate).filter((d): d is string => !!d))];
  const ids = [...agg.keys()];
  const closes = dates.length && ids.length ? await closesByDate(dates, ids) : new Map<string, Map<string, number>>();
  const asOf = dates.reduce((mx, d) => (d > mx ? d : mx), '');
  // 同一個股在各 ETF 的最新持股日通常相同；取 asOf 那天的收盤，抓不到再退而取其他日期
  const closeOf = (id: string): number | null => {
    const primary = closes.get(asOf)?.get(id);
    if (primary != null) return primary;
    for (const m of closes.values()) { const c = m.get(id); if (c != null) return c; }
    return null;
  };

  const stocks: DailyChangeStock[] = [...agg.entries()].map(([stockid, a]) => ({
    stockid, stockname: a.stockname, close: closeOf(stockid), changes: a.changes,
  }));

  const funds: DailyChangeFund[] = perFund.map(({ e, curDate, prevDate }) => ({
    ticker: e.ticker, name: e.name, curDate, prevDate,
  }));

  const data: DailyChangeResult = { asOf, funds, stocks };
  _cache = { ts: Date.now(), data };
  return data;
}
