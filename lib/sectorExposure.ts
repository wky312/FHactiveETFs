import { STOCK_NAMES } from './sectorGroups';
import { STOCK_NAMES_OVERSEAS } from './sectorGroupsOverseas';

/* 族群曝險 —— 把 /api/consensus 的一包資料組成「ETF × 個股」權重矩陣。
   ──────────────────────────────────────────────────────────────────
   純函式、無 IO：consensus 已含全市場每檔個股被哪些 ETF 持有與各自佔比，
   選股改變時只要重算矩陣，不需重新打 API。

   兩種「全市場合計」口徑，刻意都給，因為它們回答不同問題：
   - equalAvg  等權平均：Σ各檔佔比 ÷ 全部檔數(未持有記 0)。看的是「平均一檔主動 ETF 押多少」，
                 5 億的小基金與 2,700 億的大基金等重。
   - mktWeight 市值加權：Σ(佔比 × 該檔淨資產) ÷ Σ淨資產。看的是「全市場主動 ETF 的錢有多少 % 押在這檔」。
                 淨資產取 consensus 的 navProxy(見 lib/consensus.ts)，報價覆蓋不足的基金會被排除。 */

export interface ConsensusHolder { ticker: string; w: number }
export interface ConsensusStock {
  stockid: string; stockname: string; heldBy: number; holders: ConsensusHolder[];
  sumWeight: number; avgWeight: number; maxWeight: number; maxHolder: string;
}
export interface ConsensusFund {
  ticker: string; name: string; holdingDate: string | null; nHoldings: number; nSolo: number;
  navProxy: number | null; priceCoverage: number;
}
export interface ConsensusResult {
  asOf: string; nFunds: number; funds: ConsensusFund[]; stocks: ConsensusStock[];
}

export interface SectorFundRow {
  ticker: string;
  name: string;
  holdingDate: string | null;   // 各檔申報日不同，UI 必須顯示，否則會被誤讀成同一天的快照
  navProxy: number | null;
  weights: Record<string, number>;  // stockid → 佔比 %（未持有為 0）
  groupWeight: number;              // 該檔對所選個股的佔比加總
}
export interface SectorStockCol {
  stockid: string;
  stockname: string;
  heldBy: number;
  sumWeight: number;   // 各檔佔比合計 %（與「共識持股」分頁同義）
  equalAvg: number;    // 全市場等權平均 %
  mktWeight: number;   // 全市場市值加權 %
}
export interface SectorTotals {
  heldByAny: number;   // 至少持有族群中任一檔的 ETF 數
  sumWeight: number;
  equalAvg: number;
  mktWeight: number;
}
export interface SectorExposureResult {
  asOf: string;
  nFunds: number;
  codes: string[];
  funds: SectorFundRow[];
  stocks: SectorStockCol[];
  totals: SectorTotals;
  totalNav: number;          // 納入市值加權的基金淨資產合計(元)
  navExcluded: string[];     // 因報價覆蓋不足而排除於市值加權的 ETF ticker
}

/** 有被持有的股票以 DB 的 stockname 為準；沒被任何 ETF 持有的退回內建名稱，再退回代碼本身。 */
export function resolveStockName(code: string, consensusName?: string): string {
  const n = (consensusName ?? '').trim();
  if (n) return n;
  return STOCK_NAMES[code] || code;
}

/** 海外版：邏輯同 resolveStockName，內建名稱退回讀 CSV 轉換來的 STOCK_NAMES_OVERSEAS。 */
export function resolveStockNameOverseas(code: string, consensusName?: string): string {
  const n = (consensusName ?? '').trim();
  if (n) return n;
  return STOCK_NAMES_OVERSEAS[code] || code;
}

export function buildSectorMatrix(
  consensus: ConsensusResult,
  rawCodes: string[],
  nameResolver: (code: string, consensusName?: string) => string = resolveStockName,
): SectorExposureResult {
  const codes = [...new Set(rawCodes.map(c => c.trim()).filter(Boolean))];
  const byId = new Map(consensus.stocks.map(s => [s.stockid, s]));

  // ticker → 佔比，只建所選個股的部分
  const weightOf = new Map<string, Map<string, number>>();
  for (const c of codes) {
    const m = new Map<string, number>();
    for (const h of byId.get(c)?.holders ?? []) m.set(h.ticker, h.w);
    weightOf.set(c, m);
  }

  const navFunds = consensus.funds.filter(f => f.navProxy != null);
  const totalNav = navFunds.reduce((s, f) => s + (f.navProxy as number), 0);
  const navExcluded = consensus.funds.filter(f => f.navProxy == null).map(f => f.ticker);

  const funds: SectorFundRow[] = consensus.funds.map(f => {
    const weights: Record<string, number> = {};
    let groupWeight = 0;
    for (const c of codes) {
      const w = weightOf.get(c)!.get(f.ticker) ?? 0;
      weights[c] = w;
      groupWeight += w;
    }
    return { ticker: f.ticker, name: f.name, holdingDate: f.holdingDate, navProxy: f.navProxy, weights, groupWeight };
  });

  const nFunds = consensus.funds.length;
  const stocks: SectorStockCol[] = codes.map(c => {
    const s = byId.get(c);
    const m = weightOf.get(c)!;
    const sumWeight = [...m.values()].reduce((a, b) => a + b, 0);
    let mkt = 0;
    if (totalNav > 0) {
      for (const f of navFunds) mkt += (m.get(f.ticker) ?? 0) * (f.navProxy as number);
      mkt /= totalNav;
    }
    return {
      stockid: c,
      stockname: nameResolver(c, s?.stockname),
      heldBy: m.size,
      sumWeight,
      equalAvg: nFunds > 0 ? sumWeight / nFunds : 0,
      mktWeight: mkt,
    };
  });

  const totals: SectorTotals = {
    heldByAny: funds.filter(f => f.groupWeight > 0).length,
    sumWeight: stocks.reduce((a, s) => a + s.sumWeight, 0),
    equalAvg: stocks.reduce((a, s) => a + s.equalAvg, 0),
    mktWeight: stocks.reduce((a, s) => a + s.mktWeight, 0),
  };

  return { asOf: consensus.asOf, nFunds, codes, funds, stocks, totals, totalNav, navExcluded };
}
