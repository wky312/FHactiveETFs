import {
  isOrdinary, fetchTwseLatest, fetchTpexLatest, fetchTwseShares, fetchTpexShares, sanitizeShares,
} from './marketCapRanking';
import { fetchAdjCloseSeries, type CloseBar } from './yahooFinance';
import { fetchAll, mapLimit } from './consensus';
import { TW_ACTIVE_FUNDS } from './twActiveFunds';
import { supabase, supabaseReady } from './supabase';
import { readPageCache, writePageCache } from './pageCache';

/* 目前市值前 350 大普通股：近期股價表現（YTD／近五日／近一月／近一季）＋ 台股主動式 ETF 持有狀況。
   ──────────────────────────────────────────────────────────────────
   市值 = 最新原始收盤 × 已發行普通股數（口徑同 lib/marketCapRanking.ts），取全市場前 350 大。

   報酬口徑 = 還原權息收盤 + 先進位（兩端各 round2 再相除），對齊券商，同 lib/top300Ytd.ts / peer-performance。
   終點一律釘在 TWSE/TPEX「最新已收盤交易日」（不用即時報價），起點為「目標日當天或之前最近一根 K 棒」：
     YTD = 去年 12/31、近五日 = 往前 5 個交易日、近一月 = 終點日往前 1 個月、近一季 = 往前 3 個月。
   這樣同一個收盤日內結果固定，才能快取（key 帶最新收盤日）。

   持股 = 共用 Supabase holding 表（twActiveETFs 同一個），每檔 ETF 取自身最新申報日。
   holding.qshare 是股數 → 持股金額 = qshare × 最新收盤；佔公司市值 % = qshare ÷ 已發行股數。
   各 ETF 的 qshare/prate 全部回傳，前端自由勾選要看哪幾檔（預設 00981A/00992A/00991A）。 */

export const TOP_N = 350;
const BATCH = 8;
const MEM_TTL_MS = 10 * 60 * 1000;

export interface EtfHolder {
  t: string;   // ETF 代號
  q: number;   // 持有股數
  w: number | null; // 佔該 ETF 淨資產 %
}

export interface Top350Row {
  rank: number;
  code: string;
  name: string;
  market: '上市' | '上櫃';
  shares: number;           // 已發行普通股數
  close: number;            // 最新原始收盤
  mktcap: number;           // 元
  ytd: number | null;       // 還原權息報酬 %
  q3: number | null;
  m1: number | null;
  d5: number | null;        // 近五日（5 個交易日前收盤）
  holders: EtfHolder[];     // 全部台股主動式 ETF 的持有明細（未持有者不在內）
}

export interface Top350Fund {
  ticker: string;
  name: string;
  holdingDate: string | null;
}

export interface Top350Result {
  latestDate: string;
  total: number;
  funds: Top350Fund[];
  rows: Top350Row[];
  cacheSource?: 'memory' | 'supabase' | 'fresh';
}

interface PerfRow { ytd: number | null; q3: number | null; m1: number | null; d5: number | null }
type BaseRow = Omit<Top350Row, 'holders' | 'ytd' | 'q3' | 'm1' | 'd5'>;
interface Core { latestDate: string; rows: (BaseRow & PerfRow)[] }

let _core: { ts: number; key: string; data: Core } | null = null;
let _hold: { ts: number; data: { funds: Top350Fund[]; byCode: Map<string, EtfHolder[]> } } | null = null;

const round2 = (x: number) => Math.round(x * 100) / 100;
function pct(curr: number | undefined, base: number | undefined): number | null {
  if (!curr || !base) return null;
  const c = round2(curr), b = round2(base);
  return b > 0 ? ((c - b) / b) * 100 : null;
}

// 'YYYY-MM-DD' 往前推 n 個月／n 天 → 'YYYY/MM/DD'（與 fetchAdjCloseSeries 的日期字串同格式，可直接字串比較）
function shiftMonths(iso: string, months: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() - months);
  if (d.getUTCDate() !== day) d.setUTCDate(0); // 月底溢位（如 5/31 → 2/31）退回上月最後一天
  return d.toISOString().slice(0, 10).replace(/-/g, '/');
}
function onOrBefore(bars: CloseBar[], target: string): CloseBar | undefined {
  let hit: CloseBar | undefined;
  for (const b of bars) { if (b.date <= target) hit = b; else break; } // bars 已升冪
  return hit;
}

async function computeCore(): Promise<Core> {
  const [twseLatest, tpexLatest, twseShares, tpexShares] = await Promise.all([
    fetchTwseLatest(), fetchTpexLatest(), fetchTwseShares(), fetchTpexShares(),
  ]);
  const latestDate = twseLatest.date || tpexLatest.date;

  const cand: Omit<BaseRow, 'rank'>[] = [];
  for (const code of new Set<string>([...twseLatest.prices.keys(), ...tpexLatest.prices.keys()])) {
    const isTwse = twseLatest.prices.has(code);
    const close = isTwse ? twseLatest.prices.get(code)! : tpexLatest.prices.get(code)!;
    const info = (isTwse ? twseShares.get(code) : tpexShares.get(code)) ?? twseShares.get(code) ?? tpexShares.get(code);
    if (!info || !isOrdinary(code, info.name)) continue;
    const shares = sanitizeShares(info);
    if (shares <= 0) continue;
    cand.push({ code, name: info.name, market: isTwse ? '上市' : '上櫃', shares, close, mktcap: close * shares });
  }
  cand.sort((a, b) => b.mktcap - a.mktcap);
  const top = cand.slice(0, TOP_N);

  const year = Number(latestDate.slice(0, 4));
  const from = new Date(Date.UTC(year - 1, 11, 15)); // 涵蓋去年底往前的連假
  const to = new Date(`${latestDate}T00:00:00`);
  const tYtd = `${year - 1}/12/31`;
  const tQ3 = shiftMonths(latestDate, 3);
  const tM1 = shiftMonths(latestDate, 1);
  const endKey = latestDate.replace(/-/g, '/');

  const perf = await mapLimit(top, BATCH, async (e): Promise<PerfRow> => {
    const primary  = e.market === '上市' ? `${e.code}.TW`  : `${e.code}.TWO`;
    const fallback = e.market === '上市' ? `${e.code}.TWO` : `${e.code}.TW`;
    const bars = await fetchAdjCloseSeries(primary, from, to, '1d', fallback);
    const end = onOrBefore(bars, endKey);
    if (!end) return { ytd: null, q3: null, m1: null, d5: null };
    const r = (t: string) => pct(end.close, onOrBefore(bars, t)?.close);
    const endIdx = bars.indexOf(end);
    const d5 = endIdx >= 5 ? pct(end.close, bars[endIdx - 5].close) : null;
    return { ytd: r(tYtd), q3: r(tQ3), m1: r(tM1), d5 };
  });

  return { latestDate, rows: top.map((e, i) => ({ ...e, rank: i + 1, ...perf[i] })) };
}

async function getCore(): Promise<Core & { source: 'memory' | 'supabase' | 'fresh' }> {
  // 先用輕量的最新收盤日決定快取 key —— 但取日期要打一次 TWSE，直接用台北日期較簡單：
  // 記憶體層以 10 分鐘 TTL 擋掉重複請求，持久層以「最新收盤日」為 key（見下）。
  if (_core && Date.now() - _core.ts < MEM_TTL_MS) return { ..._core.data, source: 'memory' };

  const latest = await fetchTwseLatest();
  const key = `top350-core3:${latest.date}`;
  const cached = await readPageCache<Core>(key);
  if (cached) {
    _core = { ts: Date.now(), key, data: cached };
    return { ...cached, source: 'supabase' };
  }
  const fresh = await computeCore();
  const realKey = `top350-core3:${fresh.latestDate}`;
  _core = { ts: Date.now(), key: realKey, data: fresh };
  await writePageCache(realKey, fresh);
  return { ...fresh, source: 'fresh' };
}

interface HoldRow { stockid: string; qshare: number | string | null; prate: number | string | null }

async function getHoldings(): Promise<{ funds: Top350Fund[]; byCode: Map<string, EtfHolder[]> }> {
  if (_hold && Date.now() - _hold.ts < MEM_TTL_MS) return _hold.data;
  const byCode = new Map<string, EtfHolder[]>();
  const funds: Top350Fund[] = [];
  if (!supabaseReady || !supabase) return { funds, byCode };

  const results = await mapLimit(TW_ACTIVE_FUNDS, 4, async (f) => {
    const { data: latest } = await supabase!
      .from('holding').select('date').eq('ticker', f.ticker)
      .order('date', { ascending: false }).limit(1).maybeSingle();
    const date = (latest?.date as string) ?? null;
    if (!date) return { f, date, rows: [] as HoldRow[] };
    const rows = await fetchAll<HoldRow>((from, to) =>
      supabase!.from('holding').select('stockid,qshare,prate')
        .eq('ticker', f.ticker).eq('date', date).order('stockid').range(from, to));
    return { f, date, rows };
  });

  for (const { f, date, rows } of results) {
    if (!date) continue; // 尚無任何持股資料的 ETF 不列入選單
    funds.push({ ticker: f.ticker, name: f.name, holdingDate: date });
    for (const r of rows) {
      const sid = String(r.stockid ?? '').trim();
      const q = r.qshare == null ? 0 : Number(r.qshare);
      if (!/^\d{4}$/.test(sid) || !(q > 0)) continue;
      const w = r.prate == null || isNaN(Number(r.prate)) ? null : Number(r.prate);
      const list = byCode.get(sid) ?? [];
      list.push({ t: f.ticker, q, w });
      byCode.set(sid, list);
    }
  }
  const data = { funds, byCode };
  _hold = { ts: Date.now(), data };
  return data;
}

export async function computeTop350Etf(): Promise<Top350Result> {
  const [core, hold] = await Promise.all([getCore(), getHoldings()]);
  const rows: Top350Row[] = core.rows.map(r => ({ ...r, holders: hold.byCode.get(r.code) ?? [] }));
  return {
    latestDate: core.latestDate,
    total: rows.length,
    funds: hold.funds,
    rows,
    cacheSource: core.source,
  };
}
