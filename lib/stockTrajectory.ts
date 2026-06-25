import { fetchHoldings } from './fhtrust';
import { Holding } from './types';
import { UNIVERSE_NAMES } from './twseUniverse';
import { stockidToYfTicker } from './exchangeMap';
import { fetchDailyBars } from './yahooFinance';
import { loadStoredHoldings } from './holdingsStore';
import { fetchCmoneyHoldings, CMONEY_FUNDS } from './cmoneyHoldings';
import { fetchTwseAvgMap } from './twseDaily';

/* 個股持股軌跡：逐交易日抓復華持股，組出某一檔個股在某 ETF 的進出時間序列。
   策略 = 即時查詢（不存檔），重用 lib/fhtrust.ts 的 fetchHoldings（已內建快取）。 */

export interface TrajectoryPoint {
  date: string;       // YYYY/MM/DD
  lots: number;       // 持股張數 (qshare / 1000)
  qshare: number;     // 持股股數
  mvalue: number;     // 市值 (NTD)
  prate: number;      // 佔淨值比例 (%)
  deltaLots: number;  // 較前一交易日的張數增減（首日 = 初始買入張數）
  mid: number | null;       // 當日中間價 (高+低)/2，元/股（Yahoo，海外股成本基準）
  avg: number | null;       // 當日真實成交均價 = 成交金額/成交股數，元/股（台股，TWSE/TPEx）
  close: number | null;     // 當日收盤價，元/股
  dayBuyCost: number | null; // 當日買進金額 = 增加股數 × 成本基準價（僅加碼日）
  avgCost: number | null;    // 累計移動平均持倉成本，元/股
}

export interface TrajectoryResult {
  stockid: string;
  stockname: string;
  fundId: string;
  series: TrajectoryPoint[];          // 由首次買入日起的每個交易日
  firstHeldDate: string | null;       // 首次出現（張數 > 0）的日期
  latest: TrajectoryPoint | null;     // 期間最後一個交易日的狀態
  maxLots: number;                    // 期間最高持股張數
  notHeld: boolean;                   // 期間內從未持有
  scannedDays: number;                // 實際抓到資料的交易日數
  avgCost: number | null;             // 目前預估平均持倉成本，元/股
  currentPrice: number | null;        // 最新收盤價，元/股（推估損益用）
}

const FETCH_FLOOR = '2025-05-01';   // 台灣主動式 ETF 最早約 2025-05 上市，掃描下限
const MAX_WEEKDAYS = 420;           // 安全上限，避免無限抓取
const BATCH = 8;                    // 併發數

function toDateMs(dateStr: string): number {
  return new Date(dateStr.replace(/\//g, '-')).getTime();
}

function fmt(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr.replace(/\//g, '-'));
  d.setDate(d.getDate() + n);
  return fmt(d);
}

function weekdaysBetween(start: string, end: string): string[] {
  const result: string[] = [];
  let cur = start;
  const endMs = toDateMs(end);
  while (toDateMs(cur) <= endMs && result.length < MAX_WEEKDAYS) {
    const dow = new Date(cur.replace(/\//g, '-')).getDay();
    if (dow !== 0 && dow !== 6) result.push(cur);
    cur = addDays(cur, 1);
  }
  return result;
}

// 今天（台灣時間 UTC+8）的 YYYY/MM/DD
function todayTW(): string {
  const tw = new Date(Date.now() + 8 * 3600 * 1000);
  return `${tw.getUTCFullYear()}/${String(tw.getUTCMonth() + 1).padStart(2, '0')}/${String(tw.getUTCDate()).padStart(2, '0')}`;
}

async function fetchDay(date: string, fundId: string): Promise<{ date: string; holdings: Holding[] } | null> {
  try {
    const r = await fetchHoldings(date, fundId);
    if (!r.holdings || r.holdings.length === 0) return null;
    return { date: r.date, holdings: r.holdings };
  } catch {
    return null;  // 非交易日 / 成立前 / API 無資料
  }
}

// 粗掃每月一個日期，找出最早有資料的月份，避免對成立前日期大量浪費請求
async function detectStartDate(fundId: string, end: string): Promise<string> {
  const floorStr = FETCH_FLOOR.replace(/-/g, '/');
  const probes: string[] = [];
  let cur = floorStr.replace(/\/\d{2}$/, '/15'); // 每月 15 號
  while (toDateMs(cur) <= toDateMs(end)) {
    probes.push(cur);
    const d = new Date(cur.replace(/\//g, '-'));
    d.setMonth(d.getMonth() + 1);
    cur = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/15`;
  }
  const results = await Promise.all(probes.map(async p => ({ p, ok: (await fetchDay(p, fundId)) !== null })));
  const earliest = results.find(r => r.ok);
  if (!earliest) return floorStr; // 都沒資料 → 退回下限（後續逐日掃也會全 null）
  // 從該月 1 號開始逐日掃，涵蓋月中上市的情況
  return earliest.p.replace(/\/15$/, '/01');
}

export interface DayMapResult {
  dayMap: Map<string, Holding[]>;   // 'YYYY/MM/DD' → 當日持股
  sortedDates: string[];            // 升冪交易日
  end: string;                      // 今天（台灣時間 UTC+8）
}

// 建某基金「逐交易日持股」對照表：優先讀每日存檔（git 資料庫）→ 毫秒級；只對「最後存檔日之後」
// 的交易日即時補抓；無存檔退回完整即時掃描（fallback）。fetchTrajectory 與選股對帳單共用。
export async function buildDayMap(fundId: string): Promise<DayMapResult> {
  const end = todayTW();
  const dayMap = new Map<string, Holding[]>();
  const stored = loadStoredHoldings(fundId);

  const scan = async (from: string, to: string) => {
    const dates = weekdaysBetween(from, to);
    for (let i = 0; i < dates.length; i += BATCH) {
      const batch = dates.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(d => fetchDay(d, fundId)));
      for (const r of results) if (r) dayMap.set(r.date, r.holdings);
    }
  };

  const populateFromStored = () => {
    if (!stored) return;
    for (const [date, recs] of Object.entries(stored.days)) {
      dayMap.set(date, recs.map(r => ({
        stockid: r.c,
        stockname: stored.names[r.c] ?? '',
        qshare: r.q,
        mvalue: r.m,
        prate_addaccint: r.p,
        country: '',
        ftype: '',
      })));
    }
  };

  if (CMONEY_FUNDS[fundId]) {
    // CMoney 來源（如統一 00981A，官網只給最新一天）：先讀存檔（毫秒），再用 CMoney
    // 補近端含今日；無存檔則一次抓全歷史（DTRange 大）。
    populateFromStored();
    const live = await fetchCmoneyHoldings(CMONEY_FUNDS[fundId], dayMap.size > 0 ? 20 : 400);
    for (const [date, holdings] of live) dayMap.set(date, holdings);
  } else if (stored) {
    populateFromStored();
    const lastStored = Array.from(dayMap.keys()).sort((a, b) => a.localeCompare(b)).pop()!;
    await scan(addDays(lastStored, 1), end); // gap：存檔後到今天，通常 0–數天
  } else {
    await scan(await detectStartDate(fundId, end), end); // fallback：完整即時掃描
  }
  const sortedDates = Array.from(dayMap.keys()).sort((a, b) => a.localeCompare(b));
  return { dayMap, sortedDates, end };
}

export async function fetchTrajectory(rawQuery: string, fundId = 'ETF23'): Promise<TrajectoryResult> {
  const q = rawQuery.trim();
  const { dayMap, sortedDates, end } = await buildDayMap(fundId);

  // 3. 解析目標股票代碼
  const isCode = /^\d{4,6}[A-Za-z]?$/.test(q);  // 台股代碼（4-6 碼 +可選一英文）
  const qU = q.toUpperCase();
  let stockid = '';
  let stockname = '';
  if (isCode) {
    stockid = qU;
  } else {
    // 用基金實際持有過的名稱或代碼比對，取出現次數最多者。海外股代碼為彭博式（如「NVDA US」），
    // 故也比對代碼的第一段（NVDA）讓使用者能直接打外國 ticker。
    const freq = new Map<string, { name: string; n: number }>();
    for (const holdings of dayMap.values()) {
      for (const h of holdings) {
        if (!h.stockid) continue;
        const codeBase = h.stockid.split(/\s+/)[0].toUpperCase();
        const nameHit = h.stockname.includes(q) || q.includes(h.stockname);
        const codeHit = codeBase === qU || h.stockid.toUpperCase() === qU;
        if (nameHit || codeHit) {
          const e = freq.get(h.stockid) ?? { name: h.stockname, n: 0 };
          e.n += 1;
          freq.set(h.stockid, e);
        }
      }
    }
    let best: { id: string; n: number } | null = null;
    for (const [id, e] of freq) if (!best || e.n > best.n) best = { id, n: e.n };
    if (best) { stockid = best.id; stockname = freq.get(best.id)!.name; }
    else {
      // 退而求其次：用 TWSE universe 名稱反查
      const hit = Object.entries(UNIVERSE_NAMES).find(([, name]) => name.includes(q) || q.includes(name));
      if (hit) { stockid = hit[0]; stockname = hit[1]; }
    }
  }

  if (!stockid) {
    return { stockid: '', stockname: '', fundId, series: [], firstHeldDate: null, latest: null, maxLots: 0, notHeld: true, scannedDays: sortedDates.length, avgCost: null, currentPrice: null };
  }

  // 4. 組每日序列
  const raw = sortedDates.map(date => {
    const h = (dayMap.get(date) ?? []).find(x => x.stockid === stockid);
    if (h && !stockname) stockname = h.stockname;
    return {
      date,
      lots: h ? h.qshare / 1000 : 0,
      qshare: h ? h.qshare : 0,
      mvalue: h ? h.mvalue : 0,
      prate: h ? h.prate_addaccint : 0,
    };
  });

  // 補名稱備援
  if (!stockname) stockname = UNIVERSE_NAMES[stockid] ?? '';

  // 5. 從首次持有日起算，計算每日增減
  const firstIdx = raw.findIndex(p => p.lots > 0);
  if (firstIdx === -1) {
    return { stockid, stockname, fundId, series: [], firstHeldDate: null, latest: null, maxLots: 0, notHeld: true, scannedDays: sortedDates.length, avgCost: null, currentPrice: null };
  }
  const trimmed = raw.slice(firstIdx);

  // 6. 抓每日中間價/收盤價（Yahoo）＋台股真實成交均價（TWSE），算移動平均持倉成本
  const { mid: midMap, close: closeMap, avg: avgMap } = await fetchPriceMaps(stockid, fundId, trimmed[0].date, end);
  let currentPrice: number | null = null;

  let runShares = 0;   // 累計持股股數
  let runCost   = 0;   // 累計持倉成本 (NTD)
  const series: TrajectoryPoint[] = trimmed.map((p, i) => {
    const deltaLots = i === 0 ? p.lots : p.lots - trimmed[i - 1].lots;
    const deltaShares = deltaLots * 1000;
    const mid = midMap.get(p.date) ?? null;
    const avg = avgMap.get(p.date) ?? null;
    const close = closeMap.get(p.date) ?? null;
    // 成本基準：台股真實成交均價優先，退中間價（海外股），再退收盤
    const costBasis = avg ?? mid ?? close;
    if (close !== null) currentPrice = close; // 以最後一個有報價日的收盤價當「目前股價」

    let dayBuyCost: number | null = null;
    if (deltaShares > 0) {
      // 加碼：以當日成本基準價估算買進成本
      if (costBasis !== null) {
        dayBuyCost = deltaShares * costBasis;
        runCost  += dayBuyCost;
        runShares += deltaShares;
      } else {
        runShares += deltaShares; // 無報價時仍計入股數（均價會略失真）
      }
    } else if (deltaShares < 0) {
      // 減碼：移動平均成本法，用當時均價沖銷，均價不變
      const avg = runShares > 0 ? runCost / runShares : 0;
      runShares += deltaShares;
      runCost   += deltaShares * avg;
      if (runShares <= 0) { runShares = 0; runCost = 0; }
    }
    const avgCost = runShares > 0 ? runCost / runShares : null;
    // CMoney 來源無市值（mvalue=0）→ 以股數×當日收盤估算；復華原有市值則保留。
    const mvalue = p.mvalue || (close !== null ? Math.round(p.qshare * close) : 0);
    return { ...p, mvalue, deltaLots, mid, avg, close, dayBuyCost, avgCost };
  });

  const maxLots = series.reduce((m, p) => Math.max(m, p.lots), 0);

  return {
    stockid,
    stockname,
    fundId,
    series,
    firstHeldDate: series[0].date,
    latest: series[series.length - 1],
    maxLots,
    notHeld: false,
    scannedDays: sortedDates.length,
    avgCost: series[series.length - 1].avgCost,
    currentPrice,
  };
}

// 對 start→end 每一天前向填補：沒有報價就沿用上一個有報價日（處理假日/資料缺口）
function forwardFill(raw: Map<string, number>, start: string, end: string): Map<string, number> {
  if (raw.size === 0) return raw;
  const filled = new Map<string, number>();
  let last: number | null = null;
  let cur = start;
  const endMs = new Date(end.replace(/\//g, '-')).getTime();
  while (new Date(cur.replace(/\//g, '-')).getTime() <= endMs) {
    if (raw.has(cur)) last = raw.get(cur)!;
    if (last !== null) filled.set(cur, last);
    const d = new Date(cur.replace(/\//g, '-'));
    d.setDate(d.getDate() + 1);
    cur = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  }
  return filled;
}

// 抓某檔股票在 [start, end] 區間每日價格，回傳 date(YYYY/MM/DD) → 價格。
//  mid/close：Yahoo（已前向填補，處理假日/缺口）；avg：台股真實成交均價（TWSE，僅交易日，不填補）。
export async function fetchPriceMaps(stockid: string, fundId: string, start: string, end: string): Promise<{ mid: Map<string, number>; close: Map<string, number>; avg: Map<string, number> }> {
  const { ticker, suffix } = stockidToYfTicker(stockid);
  const base = stockid.trim();
  const isTwOnly = fundId === 'ETF23' || !!CMONEY_FUNDS[fundId];
  const yfTicker = isTwOnly && !suffix ? `${base}.TW` : (ticker || base);
  const fallback = isTwOnly && !suffix ? `${base}.TWO` : undefined;

  // 台股（yfTicker 以 .TW/.TWO 結尾）才有 TWSE 真實成交均價可查；海外股 avg 留空，沿用中間價
  const isTw = /\.TWO?$/.test(yfTicker);
  const twseCode = yfTicker.replace(/\.TWO?$/, '');

  const from = new Date(start.replace(/\//g, '-'));
  const to   = new Date(end.replace(/\//g, '-'));

  const [bars, avgRaw] = await Promise.all([
    fetchDailyBars(yfTicker, from, to, fallback).catch(() => []),
    isTw ? fetchTwseAvgMap(twseCode, start, end).catch(() => new Map<string, number>())
         : Promise.resolve(new Map<string, number>()),
  ]);

  const midRaw = new Map<string, number>();
  const closeRaw = new Map<string, number>();
  for (const b of bars) { midRaw.set(b.date, b.mid); closeRaw.set(b.date, b.close); }

  return {
    mid: forwardFill(midRaw, start, end),
    close: forwardFill(closeRaw, start, end),
    avg: avgRaw,
  };
}

export interface PositionPnlRaw {
  avgCost: number | null;       // 剩餘部位移動平均成本 元/股（held 才有意義）
  currentPrice: number | null;  // 最後一個有報價交易日的收盤
  currentShares: number;        // 目前持股股數（0 = 已出清）
  grossInvested: number;        // 累計買進成本 NTD（所有加碼日成本基準價 × 股數）
  realizedPnl: number;          // 已實現損益 NTD（減碼時以當日成本基準價當賣出價沖銷）
  unrealizedPnl: number;        // 未實現損益 NTD（剩餘股數 ×（現價 − 均價））
}

// 給定某股「逐交易日張數序列」(已從首次持有日 trim) 與價格 maps，以移動平均成本法算成本、
// 已實現／未實現損益。算法承襲 fetchTrajectory 主迴圈；選股對帳單(lib/scorecard)共用。
// 成本/賣出基準：台股真實成交均價(avg) → 中間價(mid，海外股) → 收盤(close)。
export function computePositionPnl(
  trimmed: { date: string; lots: number }[],
  midMap: Map<string, number>,
  closeMap: Map<string, number>,
  avgMap: Map<string, number>,
): PositionPnlRaw {
  let runShares = 0;
  let runCost = 0;
  let currentPrice: number | null = null;
  let grossInvested = 0;
  let realizedPnl = 0;
  trimmed.forEach((p, i) => {
    const deltaShares = (i === 0 ? p.lots : p.lots - trimmed[i - 1].lots) * 1000;
    const close = closeMap.get(p.date) ?? null;
    const costBasis = avgMap.get(p.date) ?? midMap.get(p.date) ?? close;
    if (close !== null) currentPrice = close;
    if (deltaShares > 0) {
      if (costBasis !== null) {
        runCost += deltaShares * costBasis;
        runShares += deltaShares;
        grossInvested += deltaShares * costBasis;
      } else {
        runShares += deltaShares;  // 無報價仍計股數（成本略失真）
      }
    } else if (deltaShares < 0) {
      // 減碼：移動平均成本法。賣出價用當日成本基準價（無則取均價＝0 損益），認列已實現損益。
      const a = runShares > 0 ? runCost / runShares : 0;
      const sellPrice = costBasis ?? a;
      const soldShares = Math.min(-deltaShares, runShares);
      realizedPnl += soldShares * (sellPrice - a);
      runShares += deltaShares;
      runCost += deltaShares * a;
      if (runShares <= 0) { runShares = 0; runCost = 0; }
    }
  });
  const avgCost = runShares > 0 ? runCost / runShares : null;
  const unrealizedPnl = (runShares > 0 && currentPrice != null && avgCost != null)
    ? runShares * (currentPrice - avgCost) : 0;
  return { avgCost, currentPrice, currentShares: runShares, grossInvested, realizedPnl, unrealizedPnl };
}
