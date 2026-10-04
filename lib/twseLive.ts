// 個股即時報價（TWSE MIS）：交叉驗證 Yahoo quote 的現價/昨收，抓 Yahoo 報價延遲/停更。
// Yahoo 免費報價約每 15~20 分鐘更新一批，若某檔剛好卡在更新空檔，現價會暫時停在昨收，
// 使當日漲跌假顯示 0%（曾見 8299 群聯電子）。MIS 是台股官方即時來源，用來偵測並修正這種情況。
//
// 不知道個股是上市(tse)或上櫃(otc)，兩種前綴都查，各代碼只會有一邊有資料、另一邊回傳空值。
// 上櫃股常見 top-level z='-' 但真正成交價在巢狀 trade.z（8299 即是一例），故 z 解析失敗時退而取 trade.z。

export interface TwseLiveQuote {
  price: number | null;      // 最新成交價（z，或上櫃股的 trade.z）
  prevClose: number | null;  // 昨收（y）
  date: string | null;       // 交易日 'YYYY-MM-DD'
  asOf: string | null;       // 報價時間 ISO 字串（來自 tlong，毫秒時間戳）
}

import { isAcceptableMisDate } from './twseCalendar';

export async function fetchTwseLive(codes: string[]): Promise<Map<string, TwseLiveQuote>> {
  const map = new Map<string, TwseLiveQuote>();
  const uniq = Array.from(new Set(codes.filter(Boolean)));
  if (!uniq.length) return map;
  try {
    const ex = [
      ...uniq.map(c => `tse_${c}.tw`),
      ...uniq.map(c => `otc_${c}.tw`),
    ].join('|');
    const res = await fetch(
      `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(ex)}&json=1&delay=0`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://mis.twse.com.tw/stock/index.jsp' } },
    );
    const data = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const x of (data?.msgArray ?? []) as any[]) {
      const code: string = x.c ?? '';
      const d: string = x.d ?? '';
      // 沒對到任何交易所的組合，MIS 會回傳缺 c/d 的空白物件，跳過
      if (!code || !/^\d{8}$/.test(d)) continue;
      const topZ   = parseFloat(x.z);
      const tradeZ = parseFloat(x.trade?.z);
      const z = !Number.isNaN(topZ) ? topZ : tradeZ;
      const y = parseFloat(x.y);
      if (Number.isNaN(z) && Number.isNaN(y)) continue;
      // ⚠ MIS 週末會送模擬盤（自報日期＝當天的週六/週日、價格會跳動）。見 lib/twseCalendar.ts。
      const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      if (!(await isAcceptableMisDate(iso))) continue;
      map.set(code, {
        price:     Number.isNaN(z) ? null : z,
        prevClose: Number.isNaN(y) ? null : y,
        date:      iso,
        asOf:      x.tlong ? new Date(Number(x.tlong)).toISOString() : null,
      });
    }
  } catch {
    // MIS 查詢失敗就不交叉驗證，沿用 Yahoo 資料
  }
  return map;
}
