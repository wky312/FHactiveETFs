/**
 * 「前十大持股」——各主動式ETF 最新一筆持股快照中，權重最大的 10 檔（整檔基金，不限市場），
 * 外加前十大合計占淨值的權重。不查股價，純持股資料，所以比收盤影響輕很多、不需要另外落地快取。
 *
 * 持股來源、現金列判定、代號收斂全部重用 lib/overseasAttribution.ts（buildOverseasDayMap /
 * isCashLike / canonOf）——跟「台股／美股收盤影響」讀的是同一份資料層。
 * 候選基金：台股 = TW_ACTIVE_FUNDS、海外 = OVERSEAS_FUNDS（與兩個收盤影響分頁的勾選清單一致）。
 */
import { OverseasFundConfig, OVERSEAS_FUNDS } from './overseasFunds';
import { TW_ACTIVE_FUNDS } from './twActiveFunds';
import { buildOverseasDayMap, isCashLike, canonOf } from './overseasAttribution';

export type TopMarket = 'tw' | 'os';

export const TOP_N = 10;
const HOLD_CONCURRENCY = 3; // 持股抓取（CMoney/fhtrust）小併發，避免同時打太多請求
const MEM_TTL_MS = 10 * 60 * 1000;

/** key = canonOf(stockid)：同一檔個股跨基金的統一比對鍵（'NVDA US' 與裸 'NVDA' 會收斂成同一個），
 *  前端「滑鼠指到某檔就亮起其他基金同一檔」靠它對應。 */
export interface TopHolding { rank: number; key: string; stockid: string; name: string; weight: number }
/** 該基金「全部」持股的權重與名次（key → …），讓前端能顯示沒進前十大的基金持有多少 */
export interface HoldingRank { name: string; weight: number; rank: number }
export interface TopFundResult {
  ticker: string; name: string; asOfHoldings: string;
  top: TopHolding[]; topWeight: number; all: Record<string, HoldingRank>; warning?: string;
}
export interface TopHoldingsResult { funds: TopFundResult[] }

export function fundsOf(market: TopMarket): OverseasFundConfig[] {
  return market === 'tw' ? TW_ACTIVE_FUNDS : OVERSEAS_FUNDS;
}

const slashToIso = (s: string) => s.replace(/\//g, '-');
const _memCache = new Map<string, { ts: number; data: TopFundResult }>();

async function topOfFund(cfg: OverseasFundConfig): Promise<TopFundResult> {
  const hit = _memCache.get(cfg.ticker);
  if (hit && Date.now() - hit.ts < MEM_TTL_MS) return hit.data;

  let result: TopFundResult;
  try {
    const dayMap = await buildOverseasDayMap(cfg);
    const latest = [...dayMap.keys()].sort().pop();
    if (!latest) {
      return { ticker: cfg.ticker, name: cfg.name, asOfHoldings: '', top: [], topWeight: 0, all: {},
        warning: '查無持股資料（可能該基金較晚成立或尚未公布逐日持股）。' };
    }
    // 同一檔個股可能寫成不同後綴／裸代號（'NVDA US' vs 'NVDA'），用 canonOf 收斂後權重加總
    const merged = new Map<string, { key: string; stockid: string; name: string; weight: number; best: number }>();
    for (const h of dayMap.get(latest) ?? []) {
      if (isCashLike(h.stockid, h.stockname, h.ftype)) continue;
      const weight = (Number(h.prate_addaccint) || 0) / 100;
      if (weight <= 0) continue;
      const key = canonOf(h.stockid);
      const cur = merged.get(key);
      if (!cur) merged.set(key, { key, stockid: h.stockid.trim(), name: h.stockname, weight, best: weight });
      else {
        cur.weight += weight;
        if (weight > cur.best) { cur.best = weight; cur.stockid = h.stockid.trim(); cur.name = h.stockname; }
      }
    }
    const sorted = [...merged.values()].sort((a, b) => b.weight - a.weight);
    const all: Record<string, HoldingRank> = {};
    sorted.forEach((s, i) => { all[s.key] = { name: s.name, weight: s.weight, rank: i + 1 }; });
    const top = sorted.slice(0, TOP_N)
      .map((s, i) => ({ rank: i + 1, key: s.key, stockid: s.stockid, name: s.name, weight: s.weight }));
    result = {
      ticker: cfg.ticker, name: cfg.name, asOfHoldings: slashToIso(latest),
      top, topWeight: top.reduce((a, s) => a + s.weight, 0), all,
      warning: top.length ? undefined : '最新持股快照內查無個股持股。',
    };
  } catch (e) {
    return { ticker: cfg.ticker, name: cfg.name, asOfHoldings: '', top: [], topWeight: 0, all: {},
      warning: e instanceof Error ? e.message : '持股讀取失敗' };
  }
  _memCache.set(cfg.ticker, { ts: Date.now(), data: result });
  return result;
}

export async function computeTopHoldings(market: TopMarket, tickers: string[]): Promise<TopHoldingsResult> {
  const pool = fundsOf(market);
  const cfgs = tickers
    .map((t) => pool.find((f) => f.ticker === t.toUpperCase()))
    .filter((f): f is OverseasFundConfig => !!f);
  const funds: TopFundResult[] = [];
  for (let i = 0; i < cfgs.length; i += HOLD_CONCURRENCY) {
    funds.push(...await Promise.all(cfgs.slice(i, i + HOLD_CONCURRENCY).map(topOfFund)));
  }
  return { funds };
}
