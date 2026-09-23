// 元大投信主動式ETF「逐檔個股持股」— for 00990A 主動元大AI新經濟.
// 沿用 lib/yuantaScale.ts 已驗證過的同一支 API（etfapi.yuantaetfs.com 的 PCF/Daily），
// 該回應除了 yuantaScale.ts 取用的 PCF 規模欄位外，還帶一份 FundWeights.StockWeights
// （逐檔個股代號/名稱/權重/股數），是元大自家的官方資料，比 CMoney 代理（lib/cmoneyHoldings.ts）
// 新：2026-09-22 實測 CMoney 停在 09/18、這支 API 已經有 09/21（官網 ratio 頁同步顯示 09/21，
// 兩邊資料一致，非個案）。`date` 是查詢基準日，回應的 `trandate` 才是實際資料日，常常落後
// 基準日 1 個交易日，因此要連「今天之後」也一起查（同 fetchYuantaRange 的處理）。
import { Holding } from './types';

const API = 'https://etfapi.yuantaetfs.com/ectranslation/api/bridge';
const UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BATCH = 5;

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr.replace(/\//g, '-'));
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

function weekdaysBetween(start: string, end: string): string[] {
  const result: string[] = [];
  let cur = start;
  while (cur <= end) {
    const dow = new Date(cur.replace(/\//g, '-')).getDay();
    if (dow !== 0 && dow !== 6) result.push(cur);
    cur = addDays(cur, 1);
  }
  return result;
}

function ymd(dashDate: string): string {
  return dashDate.replace(/-/g, '');
}
function toSlash(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}/${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}

interface StockWeightRow { code?: string; name?: string; weights?: number; qty?: number }

async function fetchOneAnnounce(ticker: string, announceDash: string): Promise<{ date: string; rows: Holding[] } | null> {
  try {
    const url = `${API}?APIType=ETFAPI&CompanyName=YUANTAFUNDS&FuncId=PCF/Daily&ticker=${encodeURIComponent(ticker)}&date=${ymd(announceDash)}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, next: { revalidate: 1800 } });
    if (!res.ok) return null;
    const json = await res.json();
    const trandate = json?.PCF?.trandate;
    const sw: StockWeightRow[] = json?.FundWeights?.StockWeights;
    if (!trandate || !Array.isArray(sw) || !sw.length) return null;

    const rows: Holding[] = [];
    for (const s of sw) {
      const stockid = String(s.code ?? '').trim();
      const weight = Number(s.weights) || 0;
      if (!stockid || weight <= 0) continue;
      rows.push({
        stockid,
        stockname: String(s.name ?? '').trim(),
        qshare: Number(s.qty) || 0,
        mvalue: 0,
        prate_addaccint: weight,
        country: '',
        ftype: '',
      });
    }
    if (!rows.length) return null;
    return { date: toSlash(String(trandate)), rows };
  } catch {
    return null;
  }
}

/** 回傳 date(YYYY/MM/DD) → Holding[]，只查 `sinceDateIso`（不含）之後的交易日到「今天+3」
 *  （+3 是為了吃到查詢基準日領先實際資料日的情況，多查到的未來日期本來就查不到值，會被
 *  fetchOneAnnounce 的 trandate 檢查濾掉，不會誤植未來資料）。 */
export async function fetchYuantaHoldings(ticker: string, sinceDateIso: string): Promise<Map<string, Holding[]>> {
  const todayIso = new Date(Date.now() + 8 * 3600 * 1000).toISOString().split('T')[0];
  const endDash = addDays(todayIso, 3);
  const announceDates = weekdaysBetween(addDays(sinceDateIso, 1), endDash);
  const sinceSlash = sinceDateIso.replace(/-/g, '/');

  const out = new Map<string, Holding[]>();
  for (let i = 0; i < announceDates.length; i += BATCH) {
    const chunk = announceDates.slice(i, i + BATCH);
    const results = await Promise.all(chunk.map((d) => fetchOneAnnounce(ticker, d)));
    for (const r of results) {
      if (r && r.date > sinceSlash) out.set(r.date, r.rows);
    }
  }
  return out;
}
