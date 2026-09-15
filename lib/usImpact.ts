/**
 * 「美股收盤影響」——單一基金在最近一個美股交易日的收盤漲跌，對其美股上市持股部位的估計影響。
 *
 * 與 lib/overseasAttribution.ts（海外個股歸因）的差別：
 *   - 歸因是「兩檔基金」比一段「期間」的報酬差距，本模組是「單一基金」看「最近一個美股交易日」。
 *   - 只納入 Bloomberg 後綴判定為美股上市（' US'/' UW'/' UN'/' UA'）的持股，
 *     排除該基金持有的台股、日股、陸股等非美股部位（00409A/00998A 都混持多國股票）。
 *
 *   contribution_i = weight_i · r_i(TWD)，r_i(TWD) = (p1/p0)·(fx1/fx0) − 1
 *
 * 持股來源、Yahoo 報價、匯率換算全部重用 lib/overseasAttribution.ts 已踩過雷的資料層
 * （buildOverseasDayMap / isCashLike / canonOf）與 lib/yahooFinance.ts、lib/fx.ts。
 */
import { OVERSEAS_FUNDS, OverseasFundConfig } from './overseasFunds';
import { buildOverseasDayMap, isCashLike, canonOf } from './overseasAttribution';
import { resolveYfTicker, stockidToYfTicker, TW_BARE_CODE } from './exchangeMap';
import { fetchTotalReturnSeries } from './yahooFinance';
import { fetchFxSeries } from './fx';

const BATCH = 8;
const HOLD_CONCURRENCY = 3; // 持股抓取（CMoney/fhtrust）小併發，避免同時打太多請求
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

const slashToIso = (s: string) => s.replace(/\//g, '-');

export interface UsImpactStock {
  stockid: string; name: string; weight: number; sret: number; contribution: number; ticker: string;
}
export interface UsImpactFundResult {
  ticker: string; name: string; asOfHoldings: string; usWeight: number; coverage: number;
  totalContribution: number; gainers: UsImpactStock[]; losers: UsImpactStock[]; warning?: string;
}
export interface UsImpactResult {
  usSessionDate: string; prevSessionDate: string; funds: UsImpactFundResult[];
}

interface UsHoldingRow { stockid: string; stockname: string; weight: number }
interface FundUsHoldings { cfg: OverseasFundConfig; asOf: string; rows: UsHoldingRow[]; error?: string }

/** 某基金最新一筆持股快照中，屬於美股上市、非現金/期貨的部位。 */
async function latestUsHoldings(cfg: OverseasFundConfig): Promise<FundUsHoldings> {
  try {
    const dayMap = await buildOverseasDayMap(cfg);
    const dates = [...dayMap.keys()].sort();
    const asOf = dates[dates.length - 1];
    if (!asOf) return { cfg, asOf: '', rows: [], error: '查無持股資料（可能該基金較晚成立或尚未公布逐日持股）。' };
    const holds = dayMap.get(asOf) ?? [];
    const rows: UsHoldingRow[] = [];
    for (const h of holds) {
      if (isCashLike(h.stockid, h.stockname, h.ftype)) continue;
      if (!isUsListed(h.stockid)) continue;
      const weight = (Number(h.prate_addaccint) || 0) / 100;
      if (weight <= 0) continue;
      rows.push({ stockid: h.stockid.trim(), stockname: h.stockname, weight });
    }
    return { cfg, asOf, rows };
  } catch (e) {
    return { cfg, asOf: '', rows: [], error: e instanceof Error ? e.message : '持股讀取失敗' };
  }
}

export async function computeUsImpact(tickers: string[]): Promise<UsImpactResult> {
  const cfgs = tickers
    .map((t) => OVERSEAS_FUNDS.find((f) => f.ticker === t.toUpperCase()))
    .filter((f): f is OverseasFundConfig => !!f);
  if (!cfgs.length) return { usSessionDate: '', prevSessionDate: '', funds: [] };

  const holdings: FundUsHoldings[] = [];
  for (let i = 0; i < cfgs.length; i += HOLD_CONCURRENCY) {
    const chunk = cfgs.slice(i, i + HOLD_CONCURRENCY);
    holdings.push(...await Promise.all(chunk.map(latestUsHoldings)));
  }

  // 聯集所有基金的美股持股（同股不同後綴／裸代號用 canonOf 合併），只查一次價
  const tickerRows = new Map<string, { yfTicker: string }>();
  for (const h of holdings) {
    for (const r of h.rows) {
      const canon = canonOf(r.stockid);
      if (tickerRows.has(canon)) continue;
      const { yfTicker } = resolveYfTicker(r.stockid, false);
      tickerRows.set(canon, { yfTicker: yfTicker || canon });
    }
  }

  const to = new Date();
  const from = new Date(to); from.setDate(from.getDate() - 12); // 涵蓋假期，確保至少抓到最近兩個交易日

  const priceMap = new Map<string, { p0: number; p1: number }>();
  let sessionDate = '';
  let prevSessionDate = '';
  const priceEntries = [...tickerRows.entries()];
  for (let i = 0; i < priceEntries.length; i += BATCH) {
    const chunk = priceEntries.slice(i, i + BATCH);
    const results = await Promise.all(
      chunk.map(([canon, r]) => fetchTotalReturnSeries(r.yfTicker, from, to).then((s) => ({ canon, s }))),
    );
    for (const { canon, s } of results) {
      if (s.bars.length < 2) continue;
      const last = s.bars[s.bars.length - 1];
      const prev = s.bars[s.bars.length - 2];
      priceMap.set(canon, { p0: prev.raw, p1: last.raw });
      // 用「最多個股都有」的最新日期當全體一致的美股交易日（同一交易所同一天收盤，正常應完全一致）
      if (!sessionDate || last.date > sessionDate) { sessionDate = last.date; prevSessionDate = prev.date; }
    }
  }

  const fx = await fetchFxSeries('USD', from, to);
  const fx1 = sessionDate ? fx.get(sessionDate) : undefined;
  const fx0 = prevSessionDate ? fx.get(prevSessionDate) : undefined;

  const funds: UsImpactFundResult[] = holdings.map((h) => {
    if (h.error || !h.rows.length) {
      return {
        ticker: h.cfg.ticker, name: h.cfg.name, asOfHoldings: h.asOf ? slashToIso(h.asOf) : '',
        usWeight: 0, coverage: 0, totalContribution: 0, gainers: [], losers: [],
        warning: h.error ?? '此基金最新持股快照內查無美股上市部位。',
      };
    }
    const stocks: UsImpactStock[] = [];
    let usWeight = 0, coverage = 0, total = 0;
    for (const r of h.rows) {
      usWeight += r.weight;
      const canon = canonOf(r.stockid);
      const px = priceMap.get(canon);
      const { yfTicker } = resolveYfTicker(r.stockid, false);
      if (!px || fx1 == null || fx0 == null || !px.p0) continue;
      const sret = px.p1 / px.p0 - 1;
      const ret = (px.p1 / px.p0) * (fx1 / fx0) - 1;
      const contribution = r.weight * ret;
      coverage += r.weight;
      total += contribution;
      stocks.push({ stockid: r.stockid, name: r.stockname, weight: r.weight, sret, contribution, ticker: yfTicker || canon });
    }
    const gainers = stocks.filter((s) => s.contribution > 0).sort((a, b) => b.contribution - a.contribution);
    const losers = stocks.filter((s) => s.contribution < 0).sort((a, b) => a.contribution - b.contribution);

    const warnParts: string[] = [];
    if (h.asOf && sessionDate) {
      const gapDays = (new Date(slashToIso(sessionDate)).getTime() - new Date(slashToIso(h.asOf)).getTime()) / 86400000;
      if (gapDays > 3) {
        warnParts.push(`持股資料日（${slashToIso(h.asOf)}）落後美股交易日（${slashToIso(sessionDate)}）超過 3 天，影響估計可能失真。`);
      }
    }
    if (coverage < usWeight - 1e-6) {
      warnParts.push('部分美股持股無法取得報價或匯率，已從估計中排除。');
    }

    return {
      ticker: h.cfg.ticker, name: h.cfg.name, asOfHoldings: h.asOf ? slashToIso(h.asOf) : '',
      usWeight, coverage, totalContribution: total, gainers, losers,
      warning: warnParts.length ? warnParts.join(' ') : undefined,
    };
  });

  return {
    usSessionDate: sessionDate ? slashToIso(sessionDate) : '',
    prevSessionDate: prevSessionDate ? slashToIso(prevSessionDate) : '',
    funds,
  };
}
