import { BUILTIN_GROUPS, SectorGroup } from './sectorGroups';
import { BUILTIN_GROUPS_OVERSEAS } from './sectorGroupsOverseas';
import { OVERSEAS_FUNDS } from './overseasFunds';
import { stockidToYfTicker } from './exchangeMap';
import { canonicalCode } from './sectorExposure';
import { Holding } from './types';

/* 持股清單下方的「族群鋪陳」—— 把單一 ETF 的持股依內建族群歸類，加總各族群佔淨值比例。
   國內基金（00991A）用國內族群(BUILTIN_GROUPS)；海外基金（OVERSEAS_FUNDS 內的）用海外族群，
   跟「族群曝險」分頁的國內/海外分法一致。

   ⚠ 同一檔股票可能同時屬於多個族群（族群曝險分頁各族群獨立計算）。這裡要的是「佔比加總
   ≈ 100%」的鋪陳，所以每檔只歸給「第一個含它的族群」（依族群定義順序），避免重複計算。 */

export interface SectorSlice {
  name: string;
  weight: number;                                  // 佔淨值 %
  stocks: { stockid: string; stockname: string; weight: number }[];
}
export interface HoldingsSectorResult {
  market: 'tw' | 'overseas';
  slices: SectorSlice[];        // 已依 weight 由大到小
  unclassified: SectorSlice;    // 有持股但不在任何族群
  other: number;                // 現金／期貨／其他資產 %
}

const isCashLike = (h: Holding) =>
  h.stockid.trim() === '' || h.ftype === '其他資產' || h.country === '現金/其他';

function codeOf(market: 'tw' | 'overseas', h: Holding): string {
  // 海外基金回報的持股是彭博格式（NVDA US / 2454 TT），轉成 Yahoo 格式才對得上族群代碼；
  // 台股裸 4 碼原樣保留，兩邊再剝 .TW/.TWO 比對（同 sectorExposure.buildSectorMatrix）。
  const id = market === 'overseas' ? stockidToYfTicker(h.stockid).ticker : h.stockid.trim();
  return canonicalCode(id);
}

export function buildHoldingsSector(holdings: Holding[], etfTicker: string): HoldingsSectorResult {
  const market: 'tw' | 'overseas' = OVERSEAS_FUNDS.some(f => f.ticker === etfTicker) ? 'overseas' : 'tw';
  const groups: SectorGroup[] = market === 'tw' ? BUILTIN_GROUPS : BUILTIN_GROUPS_OVERSEAS;

  const groupOf = new Map<string, string>();
  for (const g of groups) for (const c of g.codes) {
    const k = canonicalCode(c);
    if (!groupOf.has(k)) groupOf.set(k, g.name);
  }

  const by = new Map<string, SectorSlice>();
  const unclassified: SectorSlice = { name: '未分類', weight: 0, stocks: [] };
  let other = 0;
  for (const h of holdings) {
    if (isCashLike(h) || h.country === '期貨') { other += h.prate_addaccint; continue; }
    const gname = groupOf.get(codeOf(market, h));
    const target = gname
      ? (by.get(gname) ?? (by.set(gname, { name: gname, weight: 0, stocks: [] }), by.get(gname)!))
      : unclassified;
    target.weight += h.prate_addaccint;
    target.stocks.push({ stockid: h.stockid, stockname: h.stockname, weight: h.prate_addaccint });
  }
  const slices = [...by.values()].sort((a, b) => b.weight - a.weight);
  for (const s of [...slices, unclassified]) s.stocks.sort((a, b) => b.weight - a.weight);
  return { market, slices, unclassified, other };
}
