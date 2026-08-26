import { fetchStockPerformance } from './yahooFinance';
import { taipeiDateStr, readPageCache, writePageCache } from './pageCache';
import { HeatmapMarket, groupsFor, nameOf, tickerFor, uniqueCodes } from './sectorGroupsShared';

/* 產業熱力圖 —— 把「族群曝險」既有的 45組(國內)/15組(海外)內建產業族群，
   換算成「這段區間每個族群漲跌多少」的熱力圖資料。
   ──────────────────────────────────────────────────────────────────
   個股報酬沿用全站既有的 lib/yahooFinance.ts fetchStockPerformance()（還原權息，
   Top300Ytd/PerformanceTab 同一套口徑，不另造一套）：
   - 不帶 start/end（預設「最近一日」）：用回傳的 today（即時報價 vs 前一收盤），
     每檔股票各自判斷「自己最新一個交易日」，比伺服器端猜一個共用日期更穩，
     國內/海外交易日曆本來就不同，沒有共用的「昨天」。
   - 帶 start/end：用 customStart/customEnd → pctCustom（區間起訖日還原收盤算出的%）。
   族群報酬＝成分股報酬的等權平均（跳過查無資料的檔位，不假設有值）。

   快取兩層：
   - 記憶體 L1，任何 market+區間組合都套用，10分鐘 TTL。
   - 只有「預設最近一日」這組額外持久化進本專案 Supabase page_cache（同一天算過就不用重算），
     避免使用者亂選日期把這張表灌爆——自訂區間只靠記憶體快取，同一 instance 內短時間重複查詢才會秒回。 */

export interface HeatmapStock {
  code: string;
  name: string;
  pct: number | null;
  currentPrice: number | null;
  startPrice: number | null;  // 僅自訂區間有值（customStartPrice）
  endPrice: number | null;    // 僅自訂區間有值（customEndPrice）
}

export interface HeatmapGroup {
  name: string;
  avgPct: number | null;   // 成分股報酬等權平均；一檔可用資料都沒有時為 null
  nOk: number;             // 有算出報酬的檔數
  nTotal: number;          // 族群總檔數
  stocks: HeatmapStock[];  // 依報酬由高到低排序，供鑽取明細用
}

export interface HeatmapResult {
  asOf: string;          // 產生時間（ISO）
  market: HeatmapMarket;
  ranged: boolean;       // false＝預設最近一日，true＝自訂區間
  start: string | null;
  end: string | null;
  groups: HeatmapGroup[];
}

const BATCH = 8;
const MEM_TTL_MS = 10 * 60 * 1000;
const memCache = new Map<string, { ts: number; data: HeatmapResult }>();

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i]); }
  }));
  return out;
}

async function computeFresh(market: HeatmapMarket, start?: string, end?: string): Promise<HeatmapResult> {
  const groups = groupsFor(market);
  const codes = uniqueCodes(groups);
  const ranged = !!(start && end);
  const customStart = ranged ? new Date(`${start}T00:00:00`) : undefined;
  const customEnd   = ranged ? new Date(`${end}T23:59:59`)   : undefined; // 對齊 lib/peerPerformance 慣例，避免落到前一交易日

  const perf = await mapLimit(codes, BATCH, async (code) => {
    const { primary, fallback } = tickerFor(market, code);
    const p = await fetchStockPerformance(code, nameOf(market, code), 0, primary, fallback, customStart, customEnd);
    return { code, p };
  });
  const byCode = new Map(perf.map(r => [r.code, r.p]));

  const groupResults: HeatmapGroup[] = groups.map(g => {
    const stocks: HeatmapStock[] = g.codes.map(code => {
      const p = byCode.get(code);
      const pct = ranged ? (p?.pctCustom ?? null) : (p?.today ?? null);
      return {
        code, name: nameOf(market, code), pct,
        currentPrice: p?.currentPrice ?? null,
        startPrice: ranged ? (p?.customStartPrice ?? null) : null,
        endPrice: ranged ? (p?.customEndPrice ?? null) : null,
      };
    }).sort((a, b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity));

    const ok = stocks.filter(s => s.pct != null);
    const avgPct = ok.length ? ok.reduce((a, s) => a + s.pct!, 0) / ok.length : null;
    return { name: g.name, avgPct, nOk: ok.length, nTotal: stocks.length, stocks };
  });

  return {
    asOf: new Date().toISOString(),
    market, ranged,
    start: ranged ? start! : null,
    end: ranged ? end! : null,
    groups: groupResults,
  };
}

export async function computeSectorHeatmap(market: HeatmapMarket, start?: string, end?: string): Promise<HeatmapResult> {
  const ranged = !!(start && end);
  const dateKey = taipeiDateStr();
  const cacheKey = ranged ? `sector-heatmap:${market}:${start}:${end}` : `sector-heatmap:${market}:latest:${dateKey}`;

  const mem = memCache.get(cacheKey);
  if (mem && Date.now() - mem.ts < MEM_TTL_MS) return mem.data;

  if (!ranged) {
    const cached = await readPageCache<HeatmapResult>(cacheKey);
    if (cached) { memCache.set(cacheKey, { ts: Date.now(), data: cached }); return cached; }
  }

  const result = await computeFresh(market, start, end);
  memCache.set(cacheKey, { ts: Date.now(), data: result });
  if (!ranged) await writePageCache(cacheKey, result);
  return result;
}
