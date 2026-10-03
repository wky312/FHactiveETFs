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

/* ⚠⚠ 區間上限與並發上限（安全邊界，別拿掉）。

   呼叫端（/api/peer-performance、/api/cumulative-return）的 startDate/endDate 直接來自
   公開 query 參數、沒有驗證。這支是**逐月**抓的，所以 `?startDate=1900-01-01` 會變成一次
   對 tpex.org.tw 發一千多個請求 —— 1 進 1500 出的放大攻擊，而且是從 Vercel 的出口 IP 打出去。
   真正的代價不是我們的 function 時間，而是**把 Vercel IP 送去被 TPEx 封鎖**（兆豐
   megafunds.com.tw 已經在封資料中心 IP，見 scripts/daily_summary.py::fetch_mega_day）。

   36 個月遠超實際需要：這一組的主動式 ETF 最早 2025-05 掛牌，route 自己的 baseFrom 也只回推
   約 14 個月。超過就「保留最近 36 個月」而不是報錯——使用者體感上只是區間被截短。 */
const MAX_MONTHS = 36;
const FETCH_CONCURRENCY = 4;

/** 回傳 [from, to] 區間內的櫃買指數每日收盤（由舊到新）。逐月抓，月份結果有快取。 */
export async function fetchTpexIndexRows(from: Date, to: Date): Promise<TpexIndexRow[]> {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return [];

  // to 不可超過今天（未來日期只會多抓到空月份）；from 不可早於 to 往回 MAX_MONTHS。
  const now = new Date();
  const hi = new Date(Math.min(to.getTime(), now.getTime()));
  const floor = new Date(hi.getFullYear(), hi.getMonth() - (MAX_MONTHS - 1), 1);
  const lo = new Date(Math.max(from.getTime(), floor.getTime()));
  if (lo.getTime() > hi.getTime()) return [];

  const keys: string[] = [];
  const cur = new Date(lo.getFullYear(), lo.getMonth(), 1);
  const end = new Date(hi.getFullYear(), hi.getMonth(), 1);
  while (cur.getTime() <= end.getTime() && keys.length < MAX_MONTHS) {
    keys.push(monthKey(cur));
    cur.setMonth(cur.getMonth() + 1);
  }

  // 分批而非一次 Promise.all 全開：就算是合法的 3 年區間也不要同時打 36 個請求。
  const months: TpexIndexRow[][] = [];
  for (let i = 0; i < keys.length; i += FETCH_CONCURRENCY) {
    months.push(...await Promise.all(keys.slice(i, i + FETCH_CONCURRENCY).map(fetchMonth)));
  }

  const fromMs = lo.getTime(), toMs = hi.getTime();
  return months.flat()
    .filter(r => r.date.getTime() >= fromMs && r.date.getTime() <= toMs)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}
