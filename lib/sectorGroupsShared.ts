import { BUILTIN_GROUPS, STOCK_NAMES, SectorGroup } from './sectorGroups';
import { BUILTIN_GROUPS_OVERSEAS, STOCK_NAMES_OVERSEAS } from './sectorGroupsOverseas';

/* 「產業熱力圖」與「產業相對強度(RRG)」共用的族群/代碼解析——兩個分頁都只用內建族群
   （不含使用者存在瀏覽器 localStorage 的自訂族群，伺服器端拿不到），國內/海外各自的
   45組/15組定義沿用 lib/sectorGroups.ts、lib/sectorGroupsOverseas.ts，不重造一份。 */

export type HeatmapMarket = 'tw' | 'overseas';

export function groupsFor(market: HeatmapMarket): SectorGroup[] {
  return market === 'tw' ? BUILTIN_GROUPS : BUILTIN_GROUPS_OVERSEAS;
}

export function nameOf(market: HeatmapMarket, code: string): string {
  return (market === 'tw' ? STOCK_NAMES[code] : STOCK_NAMES_OVERSEAS[code]) || code;
}

/** 國內代碼是純數字，要組出 Yahoo ticker；海外代碼在 sectorGroupsOverseas.ts 裡本來就是
    Yahoo 格式（AMD、2454.TW、IFX.DE…），直接用、不需要 fallback。 */
export function tickerFor(market: HeatmapMarket, code: string): { primary: string; fallback?: string } {
  if (market === 'tw') return { primary: `${code}.TW`, fallback: `${code}.TWO` };
  return { primary: code };
}

/** 某市場下所有族群出現過的不重複代碼（跨族群去重，一檔股票只查一次價）。 */
export function uniqueCodes(groups: SectorGroup[]): string[] {
  return [...new Set(groups.flatMap(g => g.codes))];
}
