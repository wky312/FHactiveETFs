/* 櫃買指數（^TWOII）歷史日收盤 —— TPEx 官方來源，取代 Yahoo。
   Yahoo 的 v8/finance/chart API 對 ^TWOII 已完全不回任何日 K（indicators 只剩空物件，
   連 timestamp 陣列都沒有；只有 meta 裡凍結在 2024-10-11 的殭屍快照），peer-performance
   分頁因此拿不到任何歷史資料算週期報酬。改抓 TPEx 官網「櫃買指數(月查詢)」這支頁面 API，
   逐月查詢、拼成完整歷史序列（同一支 API openapi 版本 /openapi/v1/tpex_index 只回當月，
   查證過帶 date 參數也無效，只有這支 www/zh-tw 頁面版接受 date 參數）。
   欄位：[日期, 開, 高, 低, 收, 漲跌]，只取「收」；指數本身沒有除權息還原的問題，
   收盤即還原價。 */

const INX_URL = 'https://www.tpex.org.tw/www/zh-tw/indexInfo/inx';
const UA = { 'User-Agent': 'Mozilla/5.0' };

export interface TpexIndexDay { date: Date; close: number }

function num(s: unknown): number | null {
  const t = String(s).replace(/,/g, '').trim();
  if (t === '' || t === '--' || t === '---') return null;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

async function fetchMonth(yyyymm: string): Promise<TpexIndexDay[]> {
  const y = yyyymm.slice(0, 4);
  const m = yyyymm.slice(4, 6);
  try {
    const r = await fetch(`${INX_URL}?response=json&date=${y}/${m}/01`, { headers: UA });
    if (!r.ok) return [];
    const j = await r.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = j?.tables?.[0]?.data ?? [];
    const out: TpexIndexDay[] = [];
    for (const row of rows) {
      const [d, , , , close] = row;
      if (!/^\d{4}\/\d{2}\/\d{2}$/.test(String(d))) continue;
      const c = num(close);
      if (c == null) continue;
      // 對齊 peer-performance 既有慣例：指數日期用台股收盤時點（05:30 UTC）
      // 注意：Date 建構子的 ISO 解析只認 '-' 分隔的日期部分，TPEx 回的是 '2026/08/27'，
      // 直接接 'T05:30:00Z' 會變成 Invalid Date（且 .toISOString() 呼叫時才會噴例外）。
      out.push({ date: new Date(`${String(d).replace(/\//g, '-')}T05:30:00Z`), close: c });
    }
    return out;
  } catch {
    return []; // 單月失敗只是該月缺值，呼叫端仍可用其餘月份算出部分區間報酬
  }
}

function monthsBetween(start: Date, end: Date): string[] {
  const months: string[] = [];
  let y = start.getFullYear(), m = start.getMonth() + 1;
  const ey = end.getFullYear(), em = end.getMonth() + 1;
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return months;
}

/* 抓 [start, end] 區間的櫃買指數每日收盤，逐月查詢（限流避免 TPEx 429），依日期排序回傳。 */
export async function fetchTpexIndexHistory(start: Date, end: Date): Promise<TpexIndexDay[]> {
  const months = monthsBetween(start, end);
  const CONC = 3;
  const out: TpexIndexDay[] = [];
  for (let i = 0; i < months.length; i += CONC) {
    const slice = months.slice(i, i + CONC);
    const results = await Promise.all(slice.map(fetchMonth));
    for (const r of results) out.push(...r);
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}
