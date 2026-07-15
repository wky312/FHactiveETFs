// 單位數注意商品：主管機關要求「成立以來平均單位數」不得低於發行時單位數之一半。
// 目前只監測 00986D；未來若有其他產品觸及同類門檻，於 UNIT_WATCH_PRODUCTS 增列即可。

export interface UnitWatchProduct {
  ticker: string;
  name: string;
  fundId: string;       // fhtrust ETFPcf fundID
  listingDate: string;  // YYYY-MM-DD，掛牌日（成立以來平均的起算日）
  listingUnits: number; // 發行時單位數
  thresholdRatio: number; // 門檻比例（成立以來平均 / 發行時單位數），主管機關要求 ≥ 0.5
}

export const UNIT_WATCH_PRODUCTS: UnitWatchProduct[] = [
  {
    ticker: '00986D',
    name: '復華ETF25',
    fundId: 'ETF25',
    listingDate: '2026-04-15',
    listingUnits: 230_677_000.0,
    thresholdRatio: 0.5,
  },
];

export function getUnitWatchProduct(ticker: string): UnitWatchProduct | undefined {
  return UNIT_WATCH_PRODUCTS.find(p => p.ticker === ticker);
}

export interface UnitDay {
  date: string;  // YYYY-MM-DD
  units: number;
}

export interface UnitWatchRow extends UnitDay {
  cumAvgUnits: number; // 成立以來（截至當日）平均單位數
  ratio: number;       // cumAvgUnits / listingUnits
  pass: boolean;       // ratio >= thresholdRatio
}

// 依日期由舊到新累加平均；輸入不需先排序。
export function computeUnitWatchRows(product: UnitWatchProduct, days: UnitDay[]): UnitWatchRow[] {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  let sum = 0;
  return sorted.map((d, i) => {
    sum += d.units;
    const cumAvgUnits = sum / (i + 1);
    const ratio = cumAvgUnits / product.listingUnits;
    return { ...d, cumAvgUnits, ratio, pass: ratio >= product.thresholdRatio };
  });
}
