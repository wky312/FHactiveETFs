/* 台股當日「真實成交均價」 avg = 成交金額 ÷ 成交股數（≈ 當日 VWAP），作為持倉成本基準。
   來源：TWSE STOCK_DAY（上市）一次回整月；無資料退 TPEx（上櫃）。
   僅台股有此資料；海外股仍由 Yahoo 中間價估算（見 lib/stockTrajectory.ts）。
   算法參考 wky312/twActiveETFs scripts/twse.py。 */

const TWSE_URL = 'https://www.twse.com.tw/exchangeReport/STOCK_DAY';
const TPEX_URL = 'https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock';
const UA = { 'User-Agent': 'Mozilla/5.0' };

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

function num(s: unknown): number | null {
  const t = String(s).replace(/,/g, '').trim();
  if (t === '' || t === '--' || t === '---' || t === 'X') return null;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

// 民國日期 '115/06/16' → '2026/06/16'
function rocToYmd(s: unknown): string | null {
  const m = /^(\d{2,3})\/(\d{2})\/(\d{2})$/.exec(String(s).trim());
  return m ? `${Number(m[1]) + 1911}/${m[2]}/${m[3]}` : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getJson(url: string, params: Record<string, string>): Promise<any | null> {
  const qs = new URLSearchParams(params).toString();
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${url}?${qs}`, { headers: UA });
      if (r.status === 429 || r.status >= 500) { await sleep(1200 * (i + 1)); continue; } // 重試
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(1000 * (i + 1)); }
  }
  return null;
}

async function fetchTwseMonth(code: string, yyyymm: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const j = await getJson(TWSE_URL, { response: 'json', date: `${yyyymm}01`, stockNo: code });
  // STOCK_DAY 欄位：[日期, 成交股數, 成交金額, 開, 高, 低, 收, 漲跌, 筆數]
  if (j?.stat === 'OK' && Array.isArray(j.data)) {
    for (const row of j.data) {
      const d = rocToYmd(row[0]); if (!d) continue;
      const shares = num(row[1]), amount = num(row[2]);
      if (shares && amount) out.set(d, amount / shares);
    }
  }
  return out;
}

async function fetchTpexMonth(code: string, yyyymm: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const j = await getJson(TPEX_URL, { code, date: `${yyyymm.slice(0, 4)}/${yyyymm.slice(4, 6)}/01`, response: 'json' });
  // 欄位：[日期, 成交仟股, 成交仟元, 開, 高, 低, 收, 漲跌, 筆數]；avg = 仟元/仟股
  const rows = j?.tables?.[0]?.data;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const d = rocToYmd(row[0]); if (!d) continue;
      const kShares = num(row[1]), kAmount = num(row[2]);
      if (kShares && kAmount) out.set(d, kAmount / kShares);
    }
  }
  return out;
}

// ── 月份快取（過去月份不變，永久快取；當月短 TTL）──
interface MonthCache { rows: Map<string, number>; fetchedAt: number }
const cache = new Map<string, MonthCache>();
const CUR_TTL = 10 * 60 * 1000;

const yyyymmOf = (ymd: string) => ymd.slice(0, 4) + ymd.slice(5, 7); // 'YYYY/MM/DD' → 'YYYYMM'

async function getMonth(code: string, yyyymm: string, isCurrent: boolean): Promise<Map<string, number>> {
  const key = `${code}:${yyyymm}`;
  const hit = cache.get(key);
  if (hit && (!isCurrent || Date.now() - hit.fetchedAt < CUR_TTL)) return hit.rows;
  let rows = await fetchTwseMonth(code, yyyymm);
  if (rows.size === 0) rows = await fetchTpexMonth(code, yyyymm); // 上市無資料 → 上櫃備援
  cache.set(key, { rows, fetchedAt: Date.now() });
  return rows;
}

function monthsBetween(start: string, end: string): string[] {
  const months: string[] = [];
  const [sy, sm] = start.split('/').map(Number);
  const [ey, em] = end.split('/').map(Number);
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return months;
}

/* 抓某台股代碼在 [start, end]（YYYY/MM/DD）每日真實成交均價，回傳 date → avg(元/股)。
   逐月抓取（限流，避免 TWSE 429）；任何月份失敗只是該月缺值，呼叫端會退回中間價。 */
export async function fetchTwseAvgMap(code: string, start: string, end: string): Promise<Map<string, number>> {
  const months = monthsBetween(start, end);
  const curMonth = yyyymmOf(end);
  const result = new Map<string, number>();
  const CONC = 3;
  for (let i = 0; i < months.length; i += CONC) {
    const slice = months.slice(i, i + CONC);
    const maps = await Promise.all(slice.map(mm => getMonth(code, mm, mm === curMonth)));
    for (const mp of maps) for (const [d, v] of mp) result.set(d, v);
  }
  return result;
}
