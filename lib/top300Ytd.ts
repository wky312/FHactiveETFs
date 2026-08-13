import fs from 'fs';
import path from 'path';
import {
  isOrdinary, fetchTwseLatest, fetchTpexLatest, fetchTwseShares, fetchTpexShares, sanitizeShares,
} from './marketCapRanking';
import { fetchStockPerformance } from './yahooFinance';

/* 2025/12/31 市值前300大，追蹤至今的還原權息報酬 + 市值排名變化。
   ──────────────────────────────────────────────────────────────────
   市值/排名一律用「原始收盤價」計算（市值＝實際成交價×股數，不該用還原價，
   否則市值會失真）；只有「漲幅」與「股價」欄位依使用者要求改用還原權息
   （沿用全站既有 lib/yahooFinance.ts 的 fetchStockPerformance().ytd，跟
   「創新高強勢股」「個股與績效」分頁同一套口徑，不另外造一套算法）。

   基準日(2025/12/31)收盤價烘焙進 data/marketcap_baseline_20251231.json，
   理由同 marketCapRanking.ts：基準日資料永遠不變，沒必要每次都查歷史行情。

   300 檔逐一呼叫 Yahoo Finance 抓還原權息序列，成本較高，快取拉長到 30 分鐘。 */

export interface Top300Row {
  code: string;
  name: string;
  market: '上市' | '上櫃';
  closeBase: number;        // 12/31 原始收盤（算市值用）
  closeLatest: number;      // 最新原始收盤（算市值用）
  adjBasePrice: number;     // 12/31 還原權息價（顯示/算漲幅用）
  adjLatestPrice: number;   // 最新還原權息價（≈最新現價；顯示/算漲幅用）
  pct: number;              // 還原權息漲幅 %
  pctAdjusted: boolean;     // false＝Yahoo 還原資料抓不到，退回原始收盤算的漲幅（極少數）
  mktcapLatest: number;     // 元，最新原始收盤 × 股數
  rankBase: number;         // 12/31 市值排名（1-300）
  rankLatest: number;       // 最新市值排名（全市場，不限300）
  rankChange: number;       // rankBase - rankLatest，正值＝排名進步
}

export interface TierStats {
  count: number;
  avgPct: number;
  medianPct: number;
  upCount: number;
  droppedOut: number; // 跌出目前前300大的檔數
}

export interface Top300YtdResult {
  baseDate: string;
  latestDate: string;
  tier1: TierStats; // 排名 1-150
  tier2: TierStats; // 排名 151-300
  rows: Top300Row[];
}

const BASELINE_PATH = path.join(process.cwd(), 'data', 'marketcap_baseline_20251231.json');
const TOP_N = 300;
const BATCH = 8;
const TTL_MS = 30 * 60 * 1000;

interface BaselineFile { date: string; stocks: Record<string, { name: string; market: string; close: number }> }
let _cache: { ts: number; data: Top300YtdResult } | null = null;

function loadBaseline(): BaselineFile {
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i]); }
  }));
  return out;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function tierStats(rows: Top300Row[]): TierStats {
  const pcts = rows.map(r => r.pct);
  return {
    count: rows.length,
    avgPct: pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0,
    medianPct: median(pcts),
    upCount: rows.filter(r => r.pct > 0).length,
    droppedOut: rows.filter(r => r.rankLatest > TOP_N).length,
  };
}

export async function computeTop300Ytd(): Promise<Top300YtdResult> {
  if (_cache && Date.now() - _cache.ts < TTL_MS) return _cache.data;

  const baseline = loadBaseline();
  const [twseLatest, tpexLatest, twseShares, tpexShares] = await Promise.all([
    fetchTwseLatest(), fetchTpexLatest(), fetchTwseShares(), fetchTpexShares(),
  ]);
  const latestDate = twseLatest.date || tpexLatest.date;

  const sharesOf = (code: string) => {
    const info = twseShares.get(code) ?? tpexShares.get(code);
    return info ? sanitizeShares(info) : 0;
  };

  // 全市場最新市值排名（不限300，供「最新排名」查詢用）
  const latestCodes = new Set<string>([...twseLatest.prices.keys(), ...tpexLatest.prices.keys()]);
  const latestMktcap: { code: string; mktcap: number; close: number; market: '上市' | '上櫃' }[] = [];
  for (const code of latestCodes) {
    const isTwse = twseLatest.prices.has(code);
    const close = isTwse ? twseLatest.prices.get(code)! : tpexLatest.prices.get(code)!;
    const sh = sharesOf(code);
    if (sh <= 0) continue;
    latestMktcap.push({ code, mktcap: close * sh, close, market: isTwse ? '上市' : '上櫃' });
  }
  latestMktcap.sort((a, b) => b.mktcap - a.mktcap);
  const rankLatestMap = new Map<string, number>();
  const latestByCode = new Map<string, { mktcap: number; close: number; market: '上市' | '上櫃' }>();
  latestMktcap.forEach((r, i) => { rankLatestMap.set(r.code, i + 1); latestByCode.set(r.code, r); });

  // 12/31 市值排名，取前300
  interface BaseEntry { code: string; name: string; market: '上市' | '上櫃'; close: number; shares: number; mktcap: number }
  const baseEntries: BaseEntry[] = Object.entries(baseline.stocks)
    .filter(([code, s]) => isOrdinary(code, s.name))
    .map(([code, s]) => {
      const shares = sharesOf(code);
      return { code, name: s.name, market: s.market as '上市' | '上櫃', close: s.close, shares, mktcap: s.close * shares };
    })
    .filter(e => e.shares > 0 && e.close > 0 && latestByCode.has(e.code)); // 需同時有最新資料才追得下去

  baseEntries.sort((a, b) => b.mktcap - a.mktcap);
  const top300 = baseEntries.slice(0, TOP_N);

  // 逐檔抓還原權息報酬（沿用全站既有 fetchStockPerformance，跟其他分頁口徑一致）
  const perf = await mapLimit(top300, BATCH, async (e) => {
    const primary  = e.market === '上市' ? `${e.code}.TW`  : `${e.code}.TWO`;
    const fallback = e.market === '上市' ? `${e.code}.TWO` : `${e.code}.TW`;
    const p = await fetchStockPerformance(e.code, e.name, 0, primary, fallback);
    return { e, p };
  });

  const rows: Top300Row[] = perf.map(({ e, p }, i) => {
    const latest = latestByCode.get(e.code)!;
    const hasAdj = p.ytd != null && p.ytdBasePrice != null && p.ytdBasePrice > 0;
    const pct = hasAdj ? p.ytd! : ((latest.close - e.close) / e.close) * 100;
    return {
      code: e.code, name: e.name, market: e.market,
      closeBase: e.close, closeLatest: latest.close,
      adjBasePrice: hasAdj ? p.ytdBasePrice! : e.close,
      adjLatestPrice: p.currentPrice ?? latest.close,
      pct, pctAdjusted: hasAdj,
      mktcapLatest: latest.mktcap,
      rankBase: i + 1,
      rankLatest: rankLatestMap.get(e.code) ?? 99999,
      rankChange: (i + 1) - (rankLatestMap.get(e.code) ?? 99999),
    };
  });

  const tier1 = rows.filter(r => r.rankBase <= 150);
  const tier2 = rows.filter(r => r.rankBase > 150 && r.rankBase <= 300);

  const result: Top300YtdResult = {
    baseDate: baseline.date,
    latestDate,
    tier1: tierStats(tier1),
    tier2: tierStats(tier2),
    rows,
  };
  _cache = { ts: Date.now(), data: result };
  return result;
}
