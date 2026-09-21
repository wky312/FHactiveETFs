/**
 * 「美股收盤影響」——單一基金在最近一個美股交易日的收盤漲跌，對其美股上市持股部位的估計影響。
 *
 * 2026-09-15：實作搬進 lib/marketImpact.ts 共用核心，這裡只剩「美股」這個市場的差異定義
 * （美股判定、換匯 USD、權重取最新一筆持股）。加台股版時抽的——兩邊八成邏輯相同，
 * 複製第二份等於把 HANDOVER 記過的「同一段邏輯抄三份」那個坑再挖一次。
 *
 * 與 lib/overseasAttribution.ts（海外個股歸因）的差別：
 *   - 歸因是「兩檔基金」比一段「期間」的報酬差距，本模組是「單一基金」看「最近一個美股交易日」。
 *   - 只納入 Bloomberg 後綴判定為美股上市的持股，排除該基金持有的台股、日股、陸股等部位。
 */
import { OVERSEAS_FUNDS } from './overseasFunds';
import { resolveYfTicker, stockidToYfTicker, TW_BARE_CODE } from './exchangeMap';
import {
  MarketImpactSpec, MarketImpactResult, CachedMarketImpactResult,
  computeMarketImpact, getMarketImpactCached,
} from './marketImpact';

const US_SUFFIXES = new Set([' US', ' UW', ' UN', ' UA']);

/** Bloomberg 後綴判定是否美股上市。比照 lib/fx.ts::currencyForStockid 的判斷法——
 *  CMoney 對部分投信（如 00989A/00997A/00402A）不帶 ' US' 後綴，直接是裸英文代號
 *  （例：'NVDA'），這類「非空格後綴、非台股裸4碼、全英文」的代號也要算美股，
 *  否則這幾檔美股比重最高的基金反而會被誤判成「查無美股部位」。 */
export function isUsListed(stockid: string): boolean {
  const s = stockid.trim();
  const { suffix } = stockidToYfTicker(s);
  if (US_SUFFIXES.has(suffix)) return true;
  if (suffix) return false; // 有後綴但不是美股（日股/陸股/歐股…）
  if (TW_BARE_CODE.test(s.toUpperCase())) return false; // 裸4碼台股
  return /^[A-Za-z][A-Za-z.\-]{0,5}$/.test(s); // 裸英文代號 → 視為美股
}

/** 美股收盤 16:00 ET，再留 30 分鐘讓 Yahoo 日 K 落定成最終收盤，之後才採用該交易日這根。
 *
 *  ⚠ 美股收盤對台北雖是隔夜，但「隔夜」正是台北的深夜～清晨：週五晚上 23:00 打開分頁就是美股盤中，
 *  Yahoo 日 K 最後一根的 close 是當下即時價。舊版寫死 true，2026-09-18 盤中（11:05 ET）被開一次，
 *  盤中價就被寫進以交易日為鍵的 page_cache、整天鎖死（HOOD 顯示 +7.70%，實際收盤 +9.12%）。
 *  未定案時 computeMarketImpact 會自動退回前一個已收盤的交易日，也不會寫入當日快取。 */
export function isUsSessionSettled(sessionDateIso: string, now: Date = new Date()): boolean {
  const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (sessionDateIso < today) return true;    // 過去的交易日，早就定案
  if (sessionDateIso > today) return false;   // 不該發生，保守拒收
  const hhmm = now.toLocaleTimeString('en-GB', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  });
  return hhmm >= '16:30';
}

export const US_IMPACT_SPEC: MarketImpactSpec = {
  cacheKeyPrefix: 'us-impact',
  funds: OVERSEAS_FUNDS,
  isListed: isUsListed,
  resolveTicker: (stockid) => resolveYfTicker(stockid, false),
  fxCurrency: 'USD',
  // 美股版維持原口徑（最新一筆持股）。台股版改用 T−1 是因為台股主動式ETF 每日都公布持股、
  // 拿得到；這裡不順手改，避免既有分頁的數字無預警變動。
  weightBasis: 'latest',
  // 美股盤中（台北深夜～清晨）Yahoo 日 K 最後一根是即時價，要等 16:30 ET 後才算定案。
  isSessionSettled: (d) => isUsSessionSettled(d),
  probeTicker: 'SPY',
};

export function computeUsImpact(tickers: string[]): Promise<MarketImpactResult> {
  return computeMarketImpact(US_IMPACT_SPEC, tickers);
}

export function getUsImpactCached(): Promise<CachedMarketImpactResult> {
  return getMarketImpactCached(US_IMPACT_SPEC);
}
