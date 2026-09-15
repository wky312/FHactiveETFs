/**
 * 「台股收盤影響」——單一基金在最近一個**已收盤**的台股交易日，其台股持股部位的估計影響。
 *
 * 只是 lib/marketImpact.ts 的台股適配層，與美股版（lib/usImpact.ts）的差別只有四點：
 *   1. 不換匯——持股與淨值同為台幣，少一層匯率誤差。
 *   2. 權重用 T−1 持股（標準歸因寫法：昨日收盤的部位承受今日漲跌）。台股主動式ETF 每個
 *      交易日都公布持股，拿得到；美股版沿用「最新一筆持股」的舊口徑，不在這次一起改。
 *   3. 上櫃退路：resolveYfTicker 回 .TW 主代號 + .TWO 退路，兩個都餵給報價層。不做這件事，
 *      上櫃成分股（例：3529 力旺、6510 精測）會整欄查無報價。
 *   4. 收盤時點閘門——見 isTwSessionSettled。
 */
import { TW_ACTIVE_FUNDS } from './twActiveFunds';
import { resolveYfTicker, TW_BARE_CODE, stockidToYfTicker } from './exchangeMap';
import {
  MarketImpactSpec, MarketImpactResult, CachedMarketImpactResult,
  computeMarketImpact, getMarketImpactCached,
} from './marketImpact';

/** 台股收盤 13:30，但 Yahoo 的日 K 要再等一段才落定（盤中延遲 15–20 分鐘，日 K 通常 14:00
 *  前後才是最終收盤）。14:10 前一律不採用「今天」這根，改用前一個交易日。
 *
 *  ⚠ 這道閘門是台股版存在的理由之一：美股收盤對台北是隔夜，分頁再怎麼早開也不會撞到
 *  「盤中未定案」；台股會——早上十點打開分頁，若照美股版的寫法就會拿當下的盤中價當收盤，
 *  還會被寫進當日快取、一整天都是錯的。 */
export function isTwSessionSettled(sessionDateIso: string, now: Date = new Date()): boolean {
  const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  if (sessionDateIso < today) return true;    // 過去的交易日，早就定案
  if (sessionDateIso > today) return false;   // 不該發生（時區怪異時保守拒收）
  const hhmm = now.toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit',
  });
  return hhmm >= '14:10';
}

/** 這筆持股算不算台股上市／上櫃。
 *  台股在投信 API 一律是裸 4 碼（'2330'）、不帶交易所後綴；外國股一律帶空格＋兩碼彭博後綴
 *  （'NVDA US'、'600183 CH'）。所以「有後綴就不是台股、裸 4 碼就是台股」是安全的判斷。
 *  少數 ETF 成分（如 00631L 這種 4 碼＋字母）也吃得到，TW_BARE_CODE 已含尾碼字母。 */
export function isTwListed(stockid: string): boolean {
  const s = stockid.trim();
  const { suffix } = stockidToYfTicker(s);
  if (suffix === ' TT') return true;              // 極少數來源會帶彭博台股後綴
  if (suffix) return false;                        // 其他後綴＝外國股
  return TW_BARE_CODE.test(s.toUpperCase());
}

export const TW_IMPACT_SPEC: MarketImpactSpec = {
  cacheKeyPrefix: 'tw-impact',
  funds: TW_ACTIVE_FUNDS,
  isListed: isTwListed,
  // isTwOnlyFund=true：裸 4 碼補 .TW，並帶 .TWO 退路給上櫃股
  resolveTicker: (stockid) => resolveYfTicker(stockid, true),
  fxCurrency: null,                 // 台股台幣計價，不換匯
  weightBasis: 'prev-session',
  isSessionSettled: (d) => isTwSessionSettled(d),
  probeTicker: '0050.TW',           // 台股一定有報價、不會下市的指標
};

export function computeTwImpact(tickers: string[]): Promise<MarketImpactResult> {
  return computeMarketImpact(TW_IMPACT_SPEC, tickers);
}

export function getTwImpactCached(): Promise<CachedMarketImpactResult> {
  return getMarketImpactCached(TW_IMPACT_SPEC);
}
