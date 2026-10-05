/**
 * 「收盤影響」共用核心 —— 單一市場的收盤漲跌，對各主動式ETF 該市場持股部位的估計影響。
 *
 *   contribution_i = weight_i · r_i,  r_i = (p1/p0)·(fx1/fx0) − 1（同幣別時 fx 項為 1）
 *
 * 美股版（lib/usImpact.ts）與台股版（lib/twImpact.ts）都只是提供一份 MarketImpactSpec
 * 的薄適配層。抽這一層的理由：兩邊八成邏輯相同，而 HANDOVER 記過「同一段邏輯抄三份 →
 * 00409A 的台股部位在三個地方都查不到價」的教訓，複製第二份只是把同一個坑再挖一次。
 *
 * 持股來源、現金列判定、代號收斂全部重用 lib/overseasAttribution.ts 已踩過雷的資料層
 * （buildOverseasDayMap / isCashLike / canonOf）與 lib/yahooFinance.ts、lib/fx.ts。
 */
import { OverseasFundConfig } from './overseasFunds';
import { Holding } from './types';
import { buildOverseasDayMap, isCashLike, canonOf } from './overseasAttribution';
import { fetchTotalReturnSeries } from './yahooFinance';
import { fetchFxSeries } from './fx';
import { readPageCache, writePageCache } from './pageCache';

const BATCH = 8;
const HOLD_CONCURRENCY = 3; // 持股抓取（CMoney/fhtrust）小併發，避免同時打太多請求

/** 各市場的差異全部收斂在這個介面裡，核心本身不認識「美股」或「台股」。 */
export interface MarketImpactSpec {
  /** 快取鍵前綴，例：'us-impact' / 'tw-impact' */
  cacheKeyPrefix: string;
  /** 候選基金（全部一起算，快取共用；使用者勾選只是切片） */
  funds: OverseasFundConfig[];
  /** 這筆持股算不算「本市場上市」——不是的一律排除（各基金多半混持多國股票） */
  isListed(stockid: string): boolean;
  /** 個股 → Yahoo 主代號與退路（台股上櫃要能退 .TWO） */
  resolveTicker(stockid: string): { yfTicker: string; fallback?: string };
  /** 換匯幣別；null = 與基金計價幣別相同（台股），不做匯率換算 */
  fxCurrency: string | null;
  /** 權重基準。'latest' = 最新一筆持股快照；'prev-session' = 早於報價交易日的最後一筆
   *  （標準歸因寫法：昨日收盤的部位去承受今日漲跌） */
  weightBasis: 'latest' | 'prev-session';
  /** 這個交易日的收盤是否已定案。台股要等收盤＋報價落定，美股對台北是隔夜、恆為 true。 */
  isSessionSettled(sessionDate: string): boolean;
  /** 這個交易日的結果可以寫進持久快取（Supabase page_cache）了嗎。省略＝一律可以。
   *  台股在「剛收盤、日 K 應該已落定但沒實測」的緩衝時段回 false：結果只進記憶體快取，不鎖一整天。 */
  canPersist?(sessionDate: string): boolean;
  /** 探快取鍵用的代表性標的（挑本市場一定有報價、不會下市的指標，例：'SPY' / '0050.TW'）。
   *  只為了先知道「現在該算哪個交易日」，避免拿日曆日當快取鍵而在假日重算。 */
  probeTicker: string;
  /** 自訂持股來源（date YYYY/MM/DD → 持股）。省略＝沿用 buildOverseasDayMap（fhtrust／CMoney／存檔）。 */
  loadHoldings?(cfg: OverseasFundConfig): Promise<Map<string, Holding[]>>;
}

const slashToIso = (s: string) => s.replace(/\//g, '-');

export interface ImpactStock {
  stockid: string; name: string; weight: number; sret: number; contribution: number; ticker: string;
}
export interface ImpactFundResult {
  ticker: string; name: string; asOfHoldings: string; marketWeight: number; coverage: number;
  totalContribution: number; gainers: ImpactStock[]; losers: ImpactStock[]; warning?: string;
  /** 持股資料日落後基準交易日超過 3 天。有任何一檔為 true 時，整份結果不寫進持久快取。 */
  holdingsLagging?: boolean;
}
export interface MarketImpactResult {
  sessionDate: string; prevSessionDate: string; funds: ImpactFundResult[];
}

interface HoldingRow { stockid: string; stockname: string; weight: number }
/** 一檔基金「可能用得到」的兩筆持股快照：最新一筆，以及它前面那一筆。
 *  weightBasis='prev-session' 時要用哪一筆，得等報價交易日確定後才知道，所以兩筆都先留著。 */
interface FundSnapshots {
  cfg: OverseasFundConfig;
  snaps: { date: string; rows: HoldingRow[] }[];   // 由舊到新，最多 2 筆
  error?: string;
}

async function latestSnapshots(cfg: OverseasFundConfig, spec: MarketImpactSpec): Promise<FundSnapshots> {
  try {
    const dayMap = spec.loadHoldings ? await spec.loadHoldings(cfg) : await buildOverseasDayMap(cfg);
    const dates = [...dayMap.keys()].sort();
    if (!dates.length) {
      return { cfg, snaps: [], error: '查無持股資料（可能該基金較晚成立或尚未公布逐日持股）。' };
    }
    const wanted = dates.slice(-2);
    const snaps = wanted.map((date) => {
      const rows: HoldingRow[] = [];
      for (const h of dayMap.get(date) ?? []) {
        if (isCashLike(h.stockid, h.stockname, h.ftype)) continue;
        if (!spec.isListed(h.stockid)) continue;
        const weight = (Number(h.prate_addaccint) || 0) / 100;
        if (weight <= 0) continue;
        rows.push({ stockid: h.stockid.trim(), stockname: h.stockname, weight });
      }
      return { date, rows };
    });
    return { cfg, snaps };
  } catch (e) {
    return { cfg, snaps: [], error: e instanceof Error ? e.message : '持股讀取失敗' };
  }
}

export async function computeMarketImpact(spec: MarketImpactSpec, tickers: string[]): Promise<MarketImpactResult> {
  const cfgs = tickers
    .map((t) => spec.funds.find((f) => f.ticker === t.toUpperCase()))
    .filter((f): f is OverseasFundConfig => !!f);
  if (!cfgs.length) return { sessionDate: '', prevSessionDate: '', funds: [] };

  const holdings: FundSnapshots[] = [];
  for (let i = 0; i < cfgs.length; i += HOLD_CONCURRENCY) {
    const chunk = cfgs.slice(i, i + HOLD_CONCURRENCY);
    holdings.push(...await Promise.all(chunk.map((c) => latestSnapshots(c, spec))));
  }

  // 聯集所有基金、所有留下來的快照的持股（同股不同後綴／裸代號用 canonOf 合併），只查一次價。
  // 要含「前一筆快照」才抓得到今天賣掉的個股——weightBasis='prev-session' 時那筆仍要算貢獻。
  const tickerRows = new Map<string, { yfTicker: string; fallback?: string }>();
  for (const h of holdings) {
    for (const snap of h.snaps) {
      for (const r of snap.rows) {
        const canon = canonOf(r.stockid);
        if (tickerRows.has(canon)) continue;
        const { yfTicker, fallback } = spec.resolveTicker(r.stockid);
        tickerRows.set(canon, { yfTicker: yfTicker || canon, fallback });
      }
    }
  }

  const to = new Date();
  const from = new Date(to); from.setDate(from.getDate() - 20); // 涵蓋長假，確保至少抓到最近兩個交易日

  // canon → (交易日 → 收盤價)。刻意存成「日期 → 價」而不是「最後兩根」：
  // 停牌個股的最後兩根可能相隔好幾天，拿去當「單日報酬」會把數天漲跌算成一天。
  const barsOf = new Map<string, Map<string, number>>();
  const allDates = new Set<string>();
  const priceEntries = [...tickerRows.entries()];
  for (let i = 0; i < priceEntries.length; i += BATCH) {
    const chunk = priceEntries.slice(i, i + BATCH);
    const results = await Promise.all(
      chunk.map(([canon, r]) =>
        fetchTotalReturnSeries(r.yfTicker, from, to, r.fallback).then((s) => ({ canon, s }))),
    );
    for (const { canon, s } of results) {
      if (!s.bars.length) continue;
      const m = new Map<string, number>();
      for (const b of s.bars) { m.set(b.date, b.raw); allDates.add(b.date); }
      barsOf.set(canon, m);
    }
  }

  // 交易日：由新到舊找第一個「已定案」的日期當 sessionDate，它前面那個是 prevSessionDate。
  // 台股盤中（13:50 前）今天的收盤還沒定案 → 整個往前挪一天，不會把盤中價寫進當日快取。
  const sortedDates = [...allDates].sort();
  let sessionDate = '';
  let prevSessionDate = '';
  for (let i = sortedDates.length - 1; i >= 1; i--) {
    if (!spec.isSessionSettled(slashToIso(sortedDates[i]))) continue;
    sessionDate = sortedDates[i];
    prevSessionDate = sortedDates[i - 1];
    break;
  }

  const fx = spec.fxCurrency ? await fetchFxSeries(spec.fxCurrency, from, to) : null;
  const fx1 = fx && sessionDate ? fx.get(sessionDate) : 1;
  const fx0 = fx && prevSessionDate ? fx.get(prevSessionDate) : 1;

  const funds: ImpactFundResult[] = holdings.map((h) => {
    // weightBasis='prev-session' → 取「早於報價交易日」的最後一筆快照（多半就是 T−1）；
    // 該基金持股公布落後時，這筆可能就是它的最新快照，下方的資料日落差警語會照常提醒。
    const snap = spec.weightBasis === 'prev-session' && sessionDate
      ? [...h.snaps].reverse().find((s) => s.date < sessionDate) ?? h.snaps[h.snaps.length - 1]
      : h.snaps[h.snaps.length - 1];

    if (h.error || !snap || !snap.rows.length) {
      return {
        ticker: h.cfg.ticker, name: h.cfg.name, asOfHoldings: snap ? slashToIso(snap.date) : '',
        marketWeight: 0, coverage: 0, totalContribution: 0, gainers: [], losers: [],
        warning: h.error ?? '此基金最新持股快照內查無本市場上市部位。',
      };
    }

    const stocks: ImpactStock[] = [];
    let marketWeight = 0, coverage = 0, total = 0;
    for (const r of snap.rows) {
      marketWeight += r.weight;
      const canon = canonOf(r.stockid);
      const bars = barsOf.get(canon);
      const p1 = bars?.get(sessionDate);
      const p0 = bars?.get(prevSessionDate);
      const { yfTicker } = spec.resolveTicker(r.stockid);
      if (p0 == null || p1 == null || !p0 || fx1 == null || fx0 == null) continue;
      const sret = p1 / p0 - 1;
      const ret = (p1 / p0) * (fx1 / fx0) - 1;
      const contribution = r.weight * ret;
      coverage += r.weight;
      total += contribution;
      stocks.push({ stockid: r.stockid, name: r.stockname, weight: r.weight, sret, contribution, ticker: yfTicker || canon });
    }
    const gainers = stocks.filter((s) => s.contribution > 0).sort((a, b) => b.contribution - a.contribution);
    const losers = stocks.filter((s) => s.contribution < 0).sort((a, b) => a.contribution - b.contribution);

    const warnParts: string[] = [];
    let holdingsLagging = false;
    // 該比對哪一天，取決於這個市場「本來就打算用哪天的權重」：
    //   weightBasis='prev-session' → 基準日就是 prevSessionDate；
    //   weightBasis='latest'（美股）→ 沿用原本的口徑，跟 sessionDate 比。
    // 一律拿 prevSessionDate 比會讓美股版的警語比改版前晚一天才跳，那是無意的行為改變。
    const basisDate = spec.weightBasis === 'prev-session' ? prevSessionDate : sessionDate;
    if (snap.date && basisDate) {
      const gapDays = (new Date(slashToIso(basisDate)).getTime() - new Date(slashToIso(snap.date)).getTime()) / 86400000;
      if (gapDays > 3) {
        holdingsLagging = true;
        warnParts.push(`持股資料日（${slashToIso(snap.date)}）落後基準交易日（${slashToIso(basisDate)}）超過 3 天，影響估計可能失真。`);
      }
    }
    if (coverage < marketWeight - 1e-6) {
      warnParts.push('部分持股當日無成交或查無報價（停牌、新上市等），已從估計中排除。');
    }

    return {
      ticker: h.cfg.ticker, name: h.cfg.name, asOfHoldings: slashToIso(snap.date),
      marketWeight, coverage, totalContribution: total, gainers, losers,
      warning: warnParts.length ? warnParts.join(' ') : undefined,
      holdingsLagging: holdingsLagging || undefined,
    };
  });

  return {
    sessionDate: sessionDate ? slashToIso(sessionDate) : '',
    prevSessionDate: prevSessionDate ? slashToIso(prevSessionDate) : '',
    funds,
  };
}

/* ── 快取（比照 lib/top300Ytd.ts：L1 記憶體 10 分鐘 + L2 本專案 Supabase page_cache 跨 instance 共用）──
   一律算「全部候選 ETF」當共用快取本體，不管使用者這次勾了哪幾檔，都是從同一份快取切片。

   ⚠ 快取鍵用**交易日**而非日曆日：週末假日不會因為換了一個日期就整批重算（同一個交易日的
   結果本來就一樣），台股盤中也不會把「還沒定案的今天」寫成當日快取——sessionDate 本身就已經
   被 isSessionSettled() 擋在前一個交易日了。 */
const MEM_TTL_MS = 10 * 60 * 1000;
const _memCache = new Map<string, { ts: number; data: MarketImpactResult }>();

export interface CachedMarketImpactResult extends MarketImpactResult {
  cacheSource: 'memory' | 'supabase' | 'fresh';
}

/** 先探一次「目前應該算哪個交易日」，用它當快取鍵；探不到就退回全算。
 *  只打一檔基金的一檔代表性個股，成本遠低於整批重算。 */
async function probeSessionDate(spec: MarketImpactSpec): Promise<string> {
  const to = new Date();
  const from = new Date(to); from.setDate(from.getDate() - 20);
  const s = await fetchTotalReturnSeries(spec.probeTicker, from, to).catch(() => null);
  if (!s?.bars.length) return '';
  for (let i = s.bars.length - 1; i >= 0; i--) {
    const iso = slashToIso(s.bars[i].date);
    if (spec.isSessionSettled(iso)) return iso;
  }
  return '';
}

/* refresh=true 時跳過兩層快取、重算並覆寫。
   為什麼需要這個：快取鍵只有「交易日」，所以同一個交易日內把 data/holdings 補齊後重新部署，
   線上仍會讀到部署前算好的那份（Supabase 那層跨 instance 又不會隨部署失效）→ 新持股要等到
   下一個交易日才看得到。2026-10-03 把 22 檔台股的官網持股補進存檔時就是卡在這裡。 */
export async function getMarketImpactCached(
  spec: MarketImpactSpec,
  opts?: { refresh?: boolean },
): Promise<CachedMarketImpactResult> {
  const probed = await probeSessionDate(spec);
  const cacheKey = `${spec.cacheKeyPrefix}:${probed || 'unknown'}`;

  if (!opts?.refresh) {
    const mem = _memCache.get(cacheKey);
    if (mem && Date.now() - mem.ts < MEM_TTL_MS) return { ...mem.data, cacheSource: 'memory' };

    const cached = await readPageCache<MarketImpactResult>(cacheKey);
    if (cached) {
      _memCache.set(cacheKey, { ts: Date.now(), data: cached });
      return { ...cached, cacheSource: 'supabase' };
    }
  }

  const result = await computeMarketImpact(spec, spec.funds.map((f) => f.ticker));
  _memCache.set(cacheKey, { ts: Date.now(), data: result });
  // 只有真的算出交易日才落地，否則（Yahoo 全掛）會把一份空結果鎖在快取裡一整天。
  // 緩衝時段（spec.canPersist 回 false）也只留在記憶體，等 TTL 過了重算。
  // 任一檔持股資料落後（來源還沒更新）也不落地：快取鍵只有交易日，落地會把「當時落後的持股」
  // 鎖一整天（2026-09-22 實例：CMoney 停在 09/18 時算的結果，來源追上後仍讀到舊值）。
  const holdingsLagging = result.funds.some((f) => f.holdingsLagging);
  if (result.sessionDate && !holdingsLagging && (spec.canPersist?.(result.sessionDate) ?? true)) await writePageCache(cacheKey, result);
  return { ...result, cacheSource: 'fresh' };
}
