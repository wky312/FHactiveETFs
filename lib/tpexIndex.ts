/* 櫃買指數（OTC / TPEx）歷史收盤 —— 官方來源。

   為什麼不用 Yahoo：**`^TWOII` 已被 Yahoo 下架**（2026-10-03 實測 chart/quote 都回
   "No data found, symbol may be delisted"，連 ^OTCI / ^TWO / ^TPEX / ^GTSM 等替代代號
   全部查無），同業績效分頁的櫃買那一列因此整列空白（rows 為空 → fetchOne 直接 return base）。

   來源：TPEx「日成交量值指數」月報表，一次回整個月的每日櫃買指數收盤。
     GET www.tpex.org.tw/www/zh-tw/afterTrading/tradingIndex?date=YYYY/MM/01&response=json
     → tables[0].fields = ['日期','成交張數','金額（仟元）','筆數','櫃買指數','漲/跌']
       data 每列 [民國日期, 量, 額, 筆數, 收盤指數, 漲跌]
   ⚠ 日期是**民國年**（'115/09/01'）。⚠ date 參數要**斜線格式**（連字號會被忽略回最新月）。
   ⚠ OpenAPI 的 /tpex_index 名字叫「歷史資料」但實測只回當月（2 筆），不能用。

   刻意用「櫃買指數」而非同一支 API 另有的「櫃買報酬指數」：同組的 ^TWII 是價格指數，
   兩個基準要同口徑才能並排比較（海外組才刻意用 ^XCMP/^SP500TR 這類含息指數）。 */

const HOST = 'https://www.tpex.org.tw';

export interface TpexIndexRow { date: Date; close: number }

// 過去月份的收盤不會再變 → 永久快取；當月留 30 分鐘。
const _months = new Map<string, { ts: number; rows: TpexIndexRow[] }>();
const CUR_TTL_MS = 30 * 60 * 1000;

function monthKey(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function fetchMonth(key: string): Promise<TpexIndexRow[]> {
  const nowKey = monthKey(new Date());
  const hit = _months.get(key);
  if (hit && (key !== nowKey || Date.now() - hit.ts < CUR_TTL_MS)) return hit.rows;

  const rows: TpexIndexRow[] = [];
  try {
    const res = await fetch(
      `${HOST}/www/zh-tw/afterTrading/tradingIndex?date=${key}/01&response=json`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': `${HOST}/` }, next: { revalidate: 1800 } },
    );
    if (!res.ok) return hit?.rows ?? [];
    const json = await res.json();
    const data: unknown[][] = json?.tables?.[0]?.data ?? [];
    for (const r of data) {
      const roc = String(r?.[0] ?? '').trim();          // '115/09/01'
      const m = roc.match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
      const close = parseFloat(String(r?.[4] ?? '').replace(/,/g, ''));
      if (!m || !Number.isFinite(close)) continue;
      // 民國 → 西元；用 UTC 01:00 對齊 Yahoo 日 K 的時間戳慣例（route 只比日期字串）
      rows.push({
        date: new Date(Date.UTC(Number(m[1]) + 1911, Number(m[2]) - 1, Number(m[3]), 1)),
        close,
      });
    }
  } catch {
    return hit?.rows ?? [];     // 連不到就用上次的，不要讓整列變空
  }
  rows.sort((a, b) => a.date.getTime() - b.date.getTime());
  if (rows.length) _months.set(key, { ts: Date.now(), rows });
  return rows;
}

/** 回傳 [from, to] 區間內的櫃買指數每日收盤（由舊到新）。逐月抓，月份結果有快取。 */
export async function fetchTpexIndexRows(from: Date, to: Date): Promise<TpexIndexRow[]> {
  const keys: string[] = [];
  const cur = new Date(from.getFullYear(), from.getMonth(), 1);
  const end = new Date(to.getFullYear(), to.getMonth(), 1);
  while (cur.getTime() <= end.getTime()) {
    keys.push(monthKey(cur));
    cur.setMonth(cur.getMonth() + 1);
  }
  const months = await Promise.all(keys.map(fetchMonth));
  const fromMs = from.getTime(), toMs = to.getTime();
  return months.flat()
    .filter(r => r.date.getTime() >= fromMs && r.date.getTime() <= toMs)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}
