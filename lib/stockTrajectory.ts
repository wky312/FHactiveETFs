import { fetchHoldings } from './fhtrust';
import { Holding } from './types';
import { UNIVERSE_NAMES } from './twseUniverse';
import { stockidToYfTicker } from './exchangeMap';
import { fetchDailyBars } from './yahooFinance';
import { loadStoredHoldings } from './holdingsStore';

/* 個股持股軌跡：逐交易日抓復華持股，組出某一檔個股在某 ETF 的進出時間序列。
   策略 = 即時查詢（不存檔），重用 lib/fhtrust.ts 的 fetchHoldings（已內建快取）。 */

export interface TrajectoryPoint {
  date: string;       // YYYY/MM/DD
  lots: number;       // 持股張數 (qshare / 1000)
  qshare: number;     // 持股股數
  mvalue: number;     // 市值 (NTD)
  prate: number;      // 佔淨值比例 (%)
  deltaLots: number;  // 較前一交易日的張數增減（首日 = 初始買入張數）
  mid: number | null;       // 當日中間價 (高+低)/2，元/股
  close: number | null;     // 當日收盤價，元/股
  dayBuyCost: number | null; // 當日買進金額 = 增加股數 × 中間價（僅加碼日）
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

export async function fetchTrajectory(rawQuery: string, fundId = 'ETF23'): Promise<TrajectoryResult> {
  const q = rawQuery.trim();
  const end = todayTW();

  // 1+2. 優先讀每日存檔（git 資料庫）→ 毫秒級；只對「最後存檔日之後」的交易日即時補抓。
  //      無存檔時退回完整即時掃描（fallback）。
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

  if (stored) {
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
    const lastStored = Array.from(dayMap.keys()).sort((a, b) => a.localeCompare(b)).pop()!;
    await scan(addDays(lastStored, 1), end); // gap：存檔後到今天，通常 0–數天
  } else {
    await scan(await detectStartDate(fundId, end), end); // fallback：完整即時掃描
  }
  const sortedDates = Array.from(dayMap.keys()).sort((a, b) => a.localeCompare(b));

  // 3. 解析目標股票代碼
  const isCode = /^\d{4,6}[A-Za-z]?$/.test(q);
  let stockid = '';
  let stockname = '';
  if (isCode) {
    stockid = q.toUpperCase();
  } else {
    // 用基金實際持有過的名稱比對（縮寫差異靠雙向 includes 容錯），取出現次數最多者
    const freq = new Map<string, { name: string; n: number }>();
    for (const holdings of dayMap.values()) {
      for (const h of holdings) {
        if (!h.stockid) continue;
        if (h.stockname.includes(q) || q.includes(h.stockname)) {
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

  // 6. 抓每日最高/最低/收盤價，算中間價與移動平均持倉成本
  const { mid: midMap, close: closeMap } = await fetchPriceMaps(stockid, fundId, trimmed[0].date, end);
  let currentPrice: number | null = null;

  let runShares = 0;   // 累計持股股數
  let runCost   = 0;   // 累計持倉成本 (NTD)
  const series: TrajectoryPoint[] = trimmed.map((p, i) => {
    const deltaLots = i === 0 ? p.lots : p.lots - trimmed[i - 1].lots;
    const deltaShares = deltaLots * 1000;
    const mid = midMap.get(p.date) ?? null;
    const close = closeMap.get(p.date) ?? null;
    if (close !== null) currentPrice = close; // 以最後一個有報價日的收盤價當「目前股價」

    let dayBuyCost: number | null = null;
    if (deltaShares > 0) {
      // 加碼：以當日中間價估算買進成本
      if (mid !== null) {
        dayBuyCost = deltaShares * mid;
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
    return { ...p, deltaLots, mid, close, dayBuyCost, avgCost };
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

// 抓某檔股票在 [start, end] 區間每日中間價與收盤價，皆回傳 date(YYYY/MM/DD) → 價格（已前向填補）
async function fetchPriceMaps(stockid: string, fundId: string, start: string, end: string): Promise<{ mid: Map<string, number>; close: Map<string, number> }> {
  const { ticker, suffix } = stockidToYfTicker(stockid);
  const base = stockid.trim();
  const isTwOnly = fundId === 'ETF23';
  const yfTicker = isTwOnly && !suffix ? `${base}.TW` : (ticker || base);
  const fallback = isTwOnly && !suffix ? `${base}.TWO` : undefined;

  const from = new Date(start.replace(/\//g, '-'));
  const to   = new Date(end.replace(/\//g, '-'));
  let bars;
  try {
    bars = await fetchDailyBars(yfTicker, from, to, fallback);
  } catch {
    return { mid: new Map(), close: new Map() };
  }

  const midRaw = new Map<string, number>();
  const closeRaw = new Map<string, number>();
  for (const b of bars) { midRaw.set(b.date, b.mid); closeRaw.set(b.date, b.close); }

  return { mid: forwardFill(midRaw, start, end), close: forwardFill(closeRaw, start, end) };
}
