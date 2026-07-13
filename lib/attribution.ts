/**
 * 兩檔台股主動式 ETF 的「績效差異歸因」——把報酬差距拆解到每一檔個股。
 *
 *   R_A − R_B = Σ_t Σ_i ( w^A_{i,t-1} − w^B_{i,t-1} ) · r_{i,t}
 *
 * w_{i,t-1} = 個股 i 前一交易日權重（prate/100，避免 look-ahead；缺報的日子沿用前值）
 * r_{i,t}   = 個股 i 當日報酬（收盤對收盤 close，退日均價 avg）
 *             ── 用收盤而非日均價(VWAP)：基金 NAV／官方報酬以收盤結算，個股報酬同用收盤
 *                才能與基金實際報酬對齊；日均價會讓 Σw·r 對不上 NAV。盤中執行損益屬另一種
 *                分析(需逐筆成交資料)，每日快照歸因本就無法涵蓋。
 * 每檔貢獻：gap = Σ(w^A−w^B)·r、ca = Σ w^A·r、cb = Σ w^B·r。
 *
 * 資料來自 active-etf-tracker 的 Supabase（19 檔台股主動式股票 ETF 的逐日持股／均價／股息）。
 * 這是 scripts/attribution.py 的忠實 TypeScript 移植版本（含息走 dividend 表）。
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const PAGE = 1000;
const SID_RE = /^[0-9]{4,6}$/;

function getDb(): SupabaseClient {
  const url = process.env.ATTR_SUPABASE_URL;
  const key = process.env.ATTR_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('未設定 ATTR_SUPABASE_URL / ATTR_SUPABASE_ANON_KEY 環境變數');
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** PostgREST 單次最多回 1000 列，這裡用 range 翻頁取完整資料。 */
async function pageAll<T>(
  db: SupabaseClient,
  table: string,
  columns: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apply: (q: any) => any,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await apply(db.from(table).select(columns)).range(from, from + PAGE - 1);
    if (error) throw new Error(`讀取 ${table} 失敗：${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export interface FundOption { ticker: string; name: string; }

/** 可比較標的（給下拉選單）：台股主動式股票 ETF ＋ 被動指數對標（0050 等 type='index'）。 */
export async function listFunds(): Promise<FundOption[]> {
  const db = getDb();
  const { data, error } = await db
    .from('etf').select('ticker,name')
    .eq('market', 'tw').in('type', ['equity', 'index']).order('ticker');
  if (error) throw new Error(`讀取基金清單失敗：${error.message}`);
  return (data ?? []).map((r: { ticker: string; name: string }) => ({ ticker: r.ticker, name: r.name }));
}

export interface StockAttr {
  stockid: string; name: string;
  gap: number;   // 差距貢獻 Σ(wA−wB)·r
  ca: number;    // 對 A 自身報酬的貢獻 Σ wA·r
  cb: number;    // 對 B 自身報酬的貢獻 Σ wB·r
  avgA: number;  // 期間 A 的平均權重
  avgB: number;  // 期間 B 的平均權重
  sret: number;  // 個股期間報酬（純價差，僅供參考）
}

export interface AttrResult {
  fundA: string; fundB: string; start: string; end: string;
  days: number; totalReturn: boolean;
  retA_geo: number; retA_arith: number;
  retB_geo: number; retB_arith: number;
  gap_geo: number; gap_arith: number;
  check: number; stocks: StockAttr[];
  warning?: string;            // 區間尾端缺報價、已自動截短時的提醒
  requestedEnd?: string;       // 使用者要求的結束日（可能晚於有報價的最後一日）
}

type Hold = { ticker: string; date: string; stockid: string; stockname: string; prate: number | string };
type Px = { stockid: string; date: string; close: number | string | null; avg: number | string | null };
type Div = { stockid: string; ex_date: string; cash: number | string };

const num = (v: unknown): number => (v == null ? NaN : Number(v));

export async function compute(
  fundA: string, fundB: string, start: string,
  totalReturn = false, end?: string,
): Promise<AttrResult | { error: string }> {
  const A = fundA.toUpperCase(), B = fundB.toUpperCase();
  const startD = start;
  const endD = end || '2999-01-01';
  if (endD < startD) return { error: '結束日不能早於起始日。' };

  const db = getDb();

  const hold = (await pageAll<Hold>(db, 'holding', 'ticker,date,stockid,stockname,prate',
    q => q.in('ticker', [A, B]).gte('date', startD).lte('date', endD)
          .order('date').order('ticker').order('stockid')))
    .filter(r => SID_RE.test(r.stockid));
  if (!hold.length) return { error: `查無 ${A} 或 ${B} 在此區間的持股資料。` };

  const sids = [...new Set(hold.map(r => r.stockid))].sort();

  const px = await pageAll<Px>(db, 'price', 'stockid,date,close,avg',
    q => q.in('stockid', sids).gte('date', startD).lte('date', endD).order('date').order('stockid'));

  const div = new Map<string, number>();
  if (totalReturn) {
    const dv = await pageAll<Div>(db, 'dividend', 'stockid,ex_date,cash',
      q => q.in('stockid', sids).gte('ex_date', startD).lte('ex_date', endD));
    for (const r of dv) div.set(`${r.stockid}|${r.ex_date}`, num(r.cash));
  }

  // 建表
  const names = new Map<string, string>();
  const weight: Record<string, Map<string, Map<string, number>>> = { [A]: new Map(), [B]: new Map() };
  const datesSet = new Set<string>();
  for (const r of hold) {
    const d = r.date.slice(0, 10);
    let dm = weight[r.ticker].get(d);
    if (!dm) { dm = new Map(); weight[r.ticker].set(d, dm); }
    dm.set(r.stockid, num(r.prate) / 100);
    names.set(r.stockid, r.stockname);
    datesSet.add(d);
  }
  const price = new Map<string, Map<string, number>>();
  for (const r of px) {
    const p = r.close != null ? num(r.close) : (r.avg != null ? num(r.avg) : NaN);
    if (!Number.isFinite(p)) continue;
    const d = r.date.slice(0, 10);
    let pm = price.get(r.stockid);
    if (!pm) { pm = new Map(); price.set(r.stockid, pm); }
    pm.set(d, p);
  }

  const dates = [...datesSet].sort();
  if (dates.length < 2) return { error: '期間內交易日不足 2 天。' };

  const gap = new Map<string, number>();
  const contribA = new Map<string, number>();
  const contribB = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

  let retA = 0, retB = 0, compA = 1, compB = 1;
  let lastA = new Map(weight[A].get(dates[0]) ?? []);
  let lastB = new Map(weight[B].get(dates[0]) ?? []);
  let prev = dates[0];
  let lastPriced = '';   // 最後一個「真的有報價、能算出報酬」的交易日

  for (let i = 1; i < dates.length; i++) {
    const d = dates[i];
    let dayA = 0, dayB = 0, priced = false;
    const universe = new Set([...lastA.keys(), ...lastB.keys()]);
    for (const sid of universe) {
      const pm = price.get(sid);
      const p0 = pm?.get(prev), p1 = pm?.get(d);
      if (p0 == null || p1 == null || p0 === 0) continue;
      priced = true;
      const r = (p1 + (div.get(`${sid}|${d}`) ?? 0)) / p0 - 1;
      const wa = lastA.get(sid) ?? 0;
      const wb = lastB.get(sid) ?? 0;
      dayA += wa * r; dayB += wb * r;
      add(gap, sid, (wa - wb) * r);
      add(contribA, sid, wa * r);
      add(contribB, sid, wb * r);
    }
    retA += dayA; retB += dayB; compA *= 1 + dayA; compB *= 1 + dayB;
    if (priced) lastPriced = d;
    if (weight[A].has(d)) lastA = new Map(weight[A].get(d)!);
    if (weight[B].has(d)) lastB = new Map(weight[B].get(d)!);
    prev = d;
  }

  const requestedEnd = dates[dates.length - 1];
  // 整段區間都沒有可用報價 → 明白報錯，而不是回一堆 0 讓人以為壞掉。
  if (!lastPriced) {
    return { error: `此區間（${dates[0]} → ${requestedEnd}）查無個股報價，無法計算。`
      + `最近交易日的價格可能尚未更新，請改用較早的結束日或稍後再試。` };
  }
  // 尾端有交易日缺報價 → 自動截短到最後有報價日，並附上提醒（避免「以為算到 6/26、其實只到 6/24」）。
  const warning = lastPriced !== requestedEnd
    ? `價格資料僅更新至 ${lastPriced}，${requestedEnd} 之前部分交易日尚無報價；`
      + `結果已自動截短至 ${lastPriced}。`
    : undefined;

  const avgWeight = (fund: string, sid: string): number => {
    const days = weight[fund];
    if (days.size === 0) return 0;
    let s = 0;
    for (const dm of days.values()) s += dm.get(sid) ?? 0;
    return s / days.size;
  };

  const stocks: StockAttr[] = [];
  for (const sid of new Set([...gap.keys(), ...contribA.keys(), ...contribB.keys()])) {
    const pm = price.get(sid);
    let sret = 0;
    if (pm && pm.size >= 2) {
      const ds = [...pm.keys()].sort();
      const first = pm.get(ds[0])!, last = pm.get(ds[ds.length - 1])!;
      sret = first ? last / first - 1 : 0;
    }
    stocks.push({
      stockid: sid, name: names.get(sid) ?? '',
      gap: gap.get(sid) ?? 0, ca: contribA.get(sid) ?? 0, cb: contribB.get(sid) ?? 0,
      avgA: avgWeight(A, sid), avgB: avgWeight(B, sid), sret,
    });
  }
  stocks.sort((a, b) => b.gap - a.gap);

  let check = 0;
  for (const v of gap.values()) check += v;

  return {
    fundA: A, fundB: B, start: dates[0], end: lastPriced,
    days: dates.indexOf(lastPriced) + 1, totalReturn,
    retA_geo: compA - 1, retA_arith: retA,
    retB_geo: compB - 1, retB_arith: retB,
    gap_geo: (compA - 1) - (compB - 1), gap_arith: retA - retB,
    check, stocks, warning, requestedEnd,
  };
}
