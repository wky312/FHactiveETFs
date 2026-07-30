import type { Holding } from './types';

/* 復華 assets API 的 detail 會夾帶「非個股」列（ftype='其他資產' / '現金'）：
     扣除應付買入證券款後現金餘額(NTD/USD/EUR…)、應付買回款(NTD)、應付申購預收款(NTD)、期貨保證金(NTD)
   這些列 stockid 為空、qshare 恆為 0，若進到持股差分表，每天都會被判成「清倉」，
   汙染加碼/減碼/新倉/清倉統計與異動金額，故做加減碼計算前一律排除。
   期貨(ftype='期貨')是真實部位，不在排除範圍。 */
export function isNonStockRow(h: Pick<Holding, 'stockid' | 'stockname' | 'country' | 'ftype'>): boolean {
  if (h.ftype === '現金' || h.ftype === '其他資產') return true;
  if (h.country === '現金/其他') return true;
  // 保險：來源沒帶 ftype/country 時，用「無代碼 + 現金/應收付科目名稱」判定
  return !h.stockid.trim() &&
    /現金|存款|餘額|保證金|應付|應收|AFTER DEDUCTING|^(CASH|NTD|TWD)$/i.test(h.stockname.trim());
}

/** 只留真實個股 —— 給持股差分／加減碼統計用。 */
export function onlyStockRows(holdings: Holding[]): Holding[] {
  return holdings.filter(h => !isNonStockRow(h));
}
