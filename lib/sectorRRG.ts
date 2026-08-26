import { fetchAdjCloseSeries, CloseBar } from './yahooFinance';
import { taipeiDateStr, readPageCache, writePageCache } from './pageCache';
import { HeatmapMarket, groupsFor, tickerFor, uniqueCodes } from './sectorGroupsShared';

/* 產業 Relative Rotation Graphs（RRG）—— 沿用使用者先前在 macro-dashboard
   專案（src/app/api/rrg/route.ts）做過的 JdK RS-Ratio / RS-Momentum 演算法，原封不動搬過來，
   差別只在：原本是單一類股 ETF 對 SPY，這裡先把「族群曝險」的內建族群成分股合成一條
   「族群指數」（成分股收盤各自 rebase 到 100 後取等權平均），再拿這條合成指數對 0050 算 RS。
   ──────────────────────────────────────────────────────────────────
   為什麼族群指數要 rebase 而 benchmark 不用：rawRS = groupIndex / benchmarkPrice 這個比值
   之後全部經過「相對自己過去N期的 z-score」正規化，比值的絕對水位不影響結果——但「群內
   等權平均」這一步必須先把每檔股價換成報酬同基準（rebase 到100），否則股價貴的成分股
   （如某檔$1000）會用金額而非報酬率把平均拉走，不是有意義的產業指數。

   2026-08-26 改用日線（原本週線）：使用者反映週線(52週視窗)看不出近期輪動變化——JdK公式的
   反應速度是由「EMA/z-score期數」決定的，不是資料頻率本身，但同一組期數套在「週」上就是
   數個月的記憶，套在「交易日」上就短很多、對近期變化敏感很多。抓取窗口從1年縮到6個月
   （日線資料量本來就大，不需要抓一整年）。

   期數＝EMA(EMA_PERIOD)/EMA(EMA_PERIOD)/z-score(ZSCORE_WINDOW)，目前是 15/15/20 個交易日
   （最初上線時用 10/10/14，使用者接著提出：希望看到 Improving→Leading 轉換、進場後至少還
   有2-3週行情可以吃，這組期數夠不夠？——平滑期數/z-score視窗拉長，會讓轉換出現得較慢，但
   出現後也比較不容易立刻反轉，是技術分析裡常見的「反應速度 vs 訊號持續性」取捨；15/15/20
   是根據這個原則推出的合理中期起點，鎖定「轉換後仍有數週行情」這個目標，但沒有做歷史回測
   驗證，使用者選擇先套用、之後邊看邊調（YAGNI，真的需要更嚴謹的驗證再另外做象限持續天數
   統計或可調參數 UI）。z-score 正規化的 ×2、momentum 變化率的 ×5 是純視覺縮放常數（決定圖
   上數值分佈幅度），跟這裡要調的「反應/持續時間」是兩件事，不用跟著動。

   抓價成本量級同「產業熱力圖」，一天只算一次、快取進本專案 Supabase page_cache（沒有自訂
   區間，不需要 heatmap 那種 ranged 分支）。 */

export type Quadrant = 'leading' | 'weakening' | 'lagging' | 'improving';

export interface RRGPoint { rsRatio: number; rsMomentum: number }

export interface RRGGroup {
  name: string;
  latest: RRGPoint;
  trail: RRGPoint[];   // 最近 TRAIL_LEN 點軌跡（含 latest，依時間排序）
  quadrant: Quadrant;
  nOk: number;         // 參與族群指數計算的成分股數（至少一天有資料即算入）
  nTotal: number;
}

export interface RRGResult {
  asOf: string;
  market: HeatmapMarket;
  benchmark: string;
  periodsUsed: number;   // 對齊後拿去算 RS 的交易日數，供 UI 顯示樣本量
  groups: RRGGroup[];
}

const BATCH = 8;
const MEM_TTL_MS = 10 * 60 * 1000;
const memCache = new Map<string, { ts: number; data: RRGResult }>();

const BENCHMARK_TICKER = '0050.TW';
const BENCHMARK_LABEL = '0050';
const LOOKBACK_MONTHS = 6;  // 抓取窗口；EMA/z-score 在日線下的熱身期遠小於這個窗口
const TRAIL_LEN = 10;       // 軌跡點數＝最近幾個交易日的輪動路徑
const EMA_PERIOD = 15;      // 雙重 EMA 平滑期數（交易日）
const ZSCORE_WINDOW = 20;   // RS-Ratio 正規化用的滾動 z-score 視窗（交易日）

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// Exponential Moving Average（沿用 macro-dashboard 原公式）
function ema(data: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) result.push(data[i] * k + result[i - 1] * (1 - k));
  return result;
}

// JdK RS-Ratio & RS-Momentum —— 沿用 macro-dashboard src/app/api/rrg/route.ts 的公式，
// 期數換成本站的 EMA_PERIOD/ZSCORE_WINDOW（見檔案頂端說明）
function computeRSIndicators(seriesPrices: number[], benchmarkPrices: number[]): RRGPoint[] {
  if (seriesPrices.length !== benchmarkPrices.length || seriesPrices.length < ZSCORE_WINDOW + 5) return [];

  const rawRS = seriesPrices.map((p, i) => (benchmarkPrices[i] !== 0 ? p / benchmarkPrices[i] : 1));
  const rs1 = ema(rawRS, EMA_PERIOD);
  const rs2 = ema(rs1, EMA_PERIOD);

  const rsRatioRaw: number[] = [];
  for (let i = 0; i < rs2.length; i++) {
    if (i < ZSCORE_WINDOW) {
      rsRatioRaw.push(100);
    } else {
      const trailing = rs2.slice(i - ZSCORE_WINDOW, i);
      const trailMean = trailing.reduce((a, b) => a + b, 0) / trailing.length;
      const trailStd = Math.sqrt(trailing.reduce((a, b) => a + (b - trailMean) ** 2, 0) / trailing.length);
      rsRatioRaw.push(trailStd > 0 ? 100 + ((rs2[i] - trailMean) / trailStd) * 2 : 100);
    }
  }

  const results: RRGPoint[] = [];
  for (let i = 1; i < rsRatioRaw.length; i++) {
    results.push({ rsRatio: rsRatioRaw[i], rsMomentum: 100 + (rsRatioRaw[i] - rsRatioRaw[i - 1]) * 5 });
  }
  return results;
}

function getQuadrant(rsRatio: number, rsMomentum: number): Quadrant {
  if (rsRatio >= 100 && rsMomentum >= 100) return 'leading';
  if (rsRatio >= 100 && rsMomentum < 100) return 'weakening';
  if (rsRatio < 100 && rsMomentum < 100) return 'lagging';
  return 'improving';
}

/** 把成分股收盤對齊到 benchDates 的網格上，各自 rebase 到「自己第一個對得到的日期」＝100，
    再逐日取有資料的檔位等權平均；某天完全沒有成分股資料時延用前一天的族群指數值，避免中斷 EMA。 */
function buildGroupIndex(benchDates: string[], memberSeries: Map<string, number>[]): number[] {
  const rebased: (number | null)[][] = memberSeries.map(byDate => {
    let base: number | null = null;
    return benchDates.map(d => {
      const v = byDate.get(d);
      if (v == null) return null;
      if (base == null) base = v;
      return (v / base) * 100;
    });
  });

  const out: number[] = new Array(benchDates.length).fill(100);
  let last = 100;
  for (let i = 0; i < benchDates.length; i++) {
    const vals = rebased.map(s => s[i]).filter((v): v is number => v != null);
    if (vals.length) last = vals.reduce((a, b) => a + b, 0) / vals.length;
    out[i] = last;
  }
  return out;
}

async function computeFresh(market: HeatmapMarket): Promise<RRGResult> {
  const groups = groupsFor(market);
  const codes = uniqueCodes(groups);

  const to = new Date();
  const from = new Date(to); from.setMonth(from.getMonth() - LOOKBACK_MONTHS);

  const [benchBars, stockBars] = await Promise.all([
    fetchAdjCloseSeries(BENCHMARK_TICKER, from, to, '1d'),
    mapLimit(codes, BATCH, async (code) => {
      const { primary, fallback } = tickerFor(market, code);
      const bars = await fetchAdjCloseSeries(primary, from, to, '1d', fallback);
      return { code, bars };
    }),
  ]);

  const benchDates = benchBars.map(b => b.date);
  const benchPrices = benchBars.map(b => b.close);
  const byCodeDate = new Map<string, Map<string, number>>(
    stockBars.map(({ code, bars }) => [code, new Map(bars.map((b: CloseBar) => [b.date, b.close]))]),
  );

  const groupResults: RRGGroup[] = groups.map(g => {
    const memberMaps = g.codes.map(c => byCodeDate.get(c)).filter((m): m is Map<string, number> => !!m && m.size > 0);
    const groupIndex = buildGroupIndex(benchDates, memberMaps);
    const indicators = computeRSIndicators(groupIndex, benchPrices);
    const trail = indicators.slice(-TRAIL_LEN);
    const latest = trail[trail.length - 1] ?? { rsRatio: 100, rsMomentum: 100 };
    return {
      name: g.name, latest, trail,
      quadrant: getQuadrant(latest.rsRatio, latest.rsMomentum),
      nOk: memberMaps.length, nTotal: g.codes.length,
    };
  });

  return { asOf: new Date().toISOString(), market, benchmark: BENCHMARK_LABEL, periodsUsed: benchDates.length, groups: groupResults };
}

export async function computeSectorRRG(market: HeatmapMarket): Promise<RRGResult> {
  const cacheKey = `sector-rrg:${market}:${taipeiDateStr()}`;

  const mem = memCache.get(cacheKey);
  if (mem && Date.now() - mem.ts < MEM_TTL_MS) return mem.data;

  const cached = await readPageCache<RRGResult>(cacheKey);
  if (cached) { memCache.set(cacheKey, { ts: Date.now(), data: cached }); return cached; }

  const result = await computeFresh(market);
  memCache.set(cacheKey, { ts: Date.now(), data: result });
  await writePageCache(cacheKey, result);
  return result;
}
