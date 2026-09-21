import { ConsensusResult, resolveStockNameOverseas } from './sectorExposure';
import { GICS_SECTORS, GICS_UNMAPPED_ID, gicsSectorOf } from './gicsOverseas';

/* 海外 GICS 類別曝險：把每檔海外主動式ETF 的持股，依 lib/gicsOverseas.ts 的 GICS 11 大類別加總。
   純函式、無 I/O，吃現成的 ConsensusResult（/api/consensus-overseas），不新增 API 或快取。

   與 buildSectorMatrix（一檔個股一欄）的差別：這裡的欄是「類別」，每格是該檔基金在該類別的
   權重合計，所以不受 30 檔個股上限影響；個股明細放在每個類別的 stocks 裡給 UI 展開用。 */

export interface GicsStockRow {
  stockid: string;
  stockname: string;
  heldBy: number;
  sumWeight: number;                  // 各檔佔比合計 %
  weights: Record<string, number>;    // ETF ticker → 佔比 %（未持有為 0）
}
export interface GicsSectorCol {
  id: string;                         // GICS id，或 GICS_UNMAPPED_ID
  zh: string;
  en: string;
  nStocks: number;
  heldBy: number;                     // 至少持有該類別任一檔的 ETF 數
  equalAvg: number;                   // 全部 ETF 該類別權重的等權平均 %
  stocks: GicsStockRow[];             // 依 sumWeight 由大到小
}
export interface GicsFundRow {
  ticker: string;
  name: string;
  holdingDate: string | null;         // 各檔申報日不同，UI 必須顯示
  bySector: Record<string, number>;   // 類別 id → 權重合計 %
  total: number;                      // 所有類別（含未對應）合計＝該檔股票部位權重 %
}
export interface GicsExposureResult {
  asOf: string;
  nFunds: number;
  funds: GicsFundRow[];
  sectors: GicsSectorCol[];           // 11 類全列（沒持股也保留 0），有未對應持股時最後多一欄
  totalEqualAvg: number;
}

export function buildGicsMatrix(consensus: ConsensusResult): GicsExposureResult {
  const nFunds = consensus.funds.length;
  const stocksBySector = new Map<string, GicsStockRow[]>();

  for (const s of consensus.stocks) {
    if (!(s.sumWeight > 0)) continue;
    const id = gicsSectorOf(s.stockid) ?? GICS_UNMAPPED_ID;
    const weights: Record<string, number> = {};
    for (const h of s.holders) weights[h.ticker] = (weights[h.ticker] ?? 0) + h.w;
    const row: GicsStockRow = {
      stockid: s.stockid,
      stockname: resolveStockNameOverseas(s.stockid, s.stockname),
      heldBy: s.heldBy, sumWeight: s.sumWeight, weights,
    };
    const list = stocksBySector.get(id);
    if (list) list.push(row); else stocksBySector.set(id, [row]);
  }

  const cols = [...GICS_SECTORS];
  if (stocksBySector.has(GICS_UNMAPPED_ID)) {
    cols.push({ id: GICS_UNMAPPED_ID, zh: '未對應', en: 'Unmapped' });
  }

  const funds: GicsFundRow[] = consensus.funds.map(f => {
    const bySector: Record<string, number> = {};
    let total = 0;
    for (const c of cols) {
      const w = (stocksBySector.get(c.id) ?? []).reduce((a, r) => a + (r.weights[f.ticker] ?? 0), 0);
      bySector[c.id] = w;
      total += w;
    }
    return { ticker: f.ticker, name: f.name, holdingDate: f.holdingDate, bySector, total };
  });

  const sectors: GicsSectorCol[] = cols.map(c => {
    const stocks = (stocksBySector.get(c.id) ?? []).sort((a, b) => b.sumWeight - a.sumWeight);
    const held = funds.filter(f => f.bySector[c.id] > 0).length;
    const sum = funds.reduce((a, f) => a + f.bySector[c.id], 0);
    return { id: c.id, zh: c.zh, en: c.en, nStocks: stocks.length, heldBy: held, equalAvg: nFunds ? sum / nFunds : 0, stocks };
  });

  const totalEqualAvg = nFunds ? funds.reduce((a, f) => a + f.total, 0) / nFunds : 0;
  return { asOf: consensus.asOf, nFunds, funds, sectors, totalEqualAvg };
}
