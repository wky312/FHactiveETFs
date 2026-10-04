import { Holding } from './types';
import { fetchYuantaHoldings } from './yuantaHoldings';

/* 海外主動式ETF「最新一天持股」——投信官網直抓，取代 CMoney 代理。
   ──────────────────────────────────────────────────────────────────
   2026-10-04：CMoney（pocket.tw GetDtnoData）開始對所有請求回 {"Error":{"Code":101,"Message":"Auth Failed"}}，
   補 Referer/Origin 也一樣 → 海外族群曝險 10 檔只剩復華 2 檔有資料。改走各家官網：
   - 統一 ezmoney  POST GetPCF（00988A=61YTW、00411A=64YTW）
   - 元大          沿用 lib/yuantaHoldings.ts（00990A）
   - 群益          POST capitalfund buyback（00997A=502）
   - 摩根          GET am.jpmorgan.com product-data（00989A，cusip 即 ISIN）
   中信 00983A／台新 00986A／安聯 00402A 官網要 Playwright，伺服器端抓不到，暫留 CMoney（目前會是空的）。

   回傳的 stockid 一律保持投信原樣（彭博式 "LITE US"、台股裸 4 碼、摩根是純美股代號），
   由 consensusOverseas 統一走 stockidToYfTicker 轉 join key。日期格式 YYYY/MM/DD。 */

export type LatestHoldings = { date: string; holdings: Holding[] } | null;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const REVALIDATE = 1800;

function twNow(): Date { return new Date(Date.now() + 8 * 3600 * 1000); }
function isoOf(d: Date): string { return d.toISOString().split('T')[0]; }
function slash(iso: string): string { return iso.slice(0, 10).replace(/-/g, '/'); }
function todaySlash(): string { return slash(isoOf(twNow())); }

function row(stockid: unknown, stockname: unknown, weight: unknown, qty: unknown): Holding | null {
  const id = String(stockid ?? '').trim();
  const w = Number(weight) || 0;
  if (!id || w <= 0) return null;
  return { stockid: id, stockname: String(stockname ?? '').trim(), qshare: Number(qty) || 0, mvalue: 0,
           prate_addaccint: w, country: '', ftype: '' };
}

/* ── 統一 ezmoney ───────────────────────────────────────────── */
export const EZMONEY_CODES: Record<string, string> = { '00988A': '61YTW', '00411A': '64YTW' };

/** TranDate 有兩種格式：'/Date(1790784000000)/'（UTC 毫秒，對應台灣當日 00:00）與 '2026-10-01T00:00:00'。 */
function ezDate(v: unknown): string | null {
  const s = String(v ?? '');
  const ms = s.match(/Date\((\d+)\)/);
  const iso = ms ? isoOf(new Date(Number(ms[1]) + 8 * 3600 * 1000)) : s.slice(0, 10);
  return /^(19|20)\d\d-\d\d-\d\d$/.test(iso) ? slash(iso) : null;   // 未來公告日回 0001-01-01 空殼
}

async function ezmoneyOne(fundCode: string, d: Date): Promise<LatestHoldings> {
  try {
    const roc = `${d.getUTCFullYear() - 1911}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
    const res = await fetch('https://www.ezmoney.com.tw/ETF/Transaction/GetPCF', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest',
                 Referer: 'https://www.ezmoney.com.tw/ETF/Transaction/PCF' },
      body: JSON.stringify({ fundCode, date: roc, specificDate: false }),
      next: { revalidate: REVALIDATE },
    });
    if (!res.ok) return null;
    const j = await res.json();
    const st = (j?.asset ?? []).find((a: { AssetCode?: string }) => String(a?.AssetCode).toUpperCase() === 'ST');
    const details: Record<string, unknown>[] = st?.Details ?? [];
    const date = ezDate(details[0]?.TranDate);
    if (!date) return null;
    const holdings = details.map(h => row(h.DetailCode, h.DetailName, h.NavRate, h.Share)).filter((h): h is Holding => !!h);
    return holdings.length ? { date, holdings } : null;
  } catch {
    return null;
  }
}

/** 公告日往後掃 3 個平日、往前 7 個平日，取自報交易日最新且不晚於今天者（同 tw-market-data 鐵律：日期只信 API 自報）。 */
export async function fetchLatestEzmoney(ticker: string): Promise<LatestHoldings> {
  const code = EZMONEY_CODES[ticker];
  if (!code) return null;
  const days: Date[] = [];
  for (let off = 4; off >= -9; off--) {
    const d = twNow(); d.setUTCDate(d.getUTCDate() + off);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(d);
  }
  const today = todaySlash();
  const results = await Promise.all(days.map(d => ezmoneyOne(code, d)));
  return results.filter((r): r is NonNullable<LatestHoldings> => !!r && r.date <= today)
    .sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
}

/* ── 元大 ────────────────────────────────────────────────────── */
export async function fetchLatestYuanta(ticker: string): Promise<LatestHoldings> {
  const since = twNow(); since.setUTCDate(since.getUTCDate() - 12);
  const byDate = await fetchYuantaHoldings(ticker, isoOf(since));
  const today = todaySlash();
  const latest = [...byDate.keys()].filter(d => d <= today).sort().at(-1);
  return latest ? { date: latest, holdings: byDate.get(latest)! } : null;
}

/* ── 群益 ────────────────────────────────────────────────────── */
export const CAPITAL_FUNDS: Record<string, string> = { '00997A': '502' };

/** 只回最新一份清單。⚠ date1 是清單生效日（下一交易日），持股日要用 pcf.date2。 */
export async function fetchLatestCapital(ticker: string): Promise<LatestHoldings> {
  const fundId = CAPITAL_FUNDS[ticker];
  if (!fundId) return null;
  try {
    const res = await fetch('https://www.capitalfund.com.tw/CFWeb/api/etf/buyback', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fundId }),
      next: { revalidate: REVALIDATE },
    });
    if (!res.ok) return null;
    const data = (await res.json())?.data;
    const d2 = String(data?.pcf?.date2 ?? '');
    if (!/^\d{4}-\d\d-\d\d/.test(d2)) return null;
    const holdings = ((data?.stocks ?? []) as Record<string, unknown>[])
      .map(h => row(h.stocNo, h.stocName, h.weight, h.share)).filter((h): h is Holding => !!h);
    return holdings.length ? { date: slash(d2), holdings } : null;
  } catch {
    return null;
  }
}

/* ── 摩根 ────────────────────────────────────────────────────── */
export const JPM_CUSIPS: Record<string, string> = { '00989A': 'TW00000989A5' };

export async function fetchLatestJpm(ticker: string): Promise<LatestHoldings> {
  const cusip = JPM_CUSIPS[ticker];
  if (!cusip) return null;
  try {
    const url = `https://am.jpmorgan.com/FundsMarketingHandler/product-data?cusip=${cusip}&country=tw&role=twetf&language=zh&userLoggedIn=false&version=9.11_1`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, next: { revalidate: REVALIDATE } });
    if (!res.ok) return null;
    const rows: Record<string, unknown>[] = (await res.json())?.fundData?.holdings?.pcfEquityHoldings?.data ?? [];
    const nav = String(rows[0]?.navDate ?? '');
    if (!/^\d{4}-\d\d-\d\d/.test(nav)) return null;
    const holdings = rows.map(h => row(h.securityTicker, h.securityDescription, h.marketValuePercent, h.shares))
      .filter((h): h is Holding => !!h);
    return holdings.length ? { date: slash(nav), holdings } : null;
  } catch {
    return null;
  }
}
