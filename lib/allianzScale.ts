// 安聯投信 (Allianz GI Taiwan) ETF 申購買回 scraper — for 00402A 主動安聯美國科技.
// Angular SPA backend with XSRF protection. Two steps:
//   1. GET  /webapi/api/AntiForgery/GetAntiForgeryToken  → Set-Cookie: XSRF-TOKEN=…
//   2. POST /webapi/api/Fund/GetFundTradeInfo  (Cookie + X-XSRF-TOKEN header)
//        body {"FundNo":fundNo,"Date":"YYYY-MM-DD"} → { StatusCode:0, Entries:{…} }
// 00402A → FundNo "E0003"、00993A → "E0002"、00984A → "E0001"。Entries 是 OBJECT（非陣列）。
//
// ⚠️ `Date` 是**公告日**、不是交易日：CPcfdate 只是把查詢日回聲回來，真正的資料日是
// `CNavDt`（7/28 公告的內容是 7/27 的資料；海外型可落後 2-3 個交易日）。所以查公告日候選、
// 用 CNavDt 把每筆歸位。StatusCode:1 = 非公告日。

export interface AllianzDay {
  date: string;   // YYYY/MM/DD (資料日 = CNavDt)
  netSub: number; // 億元 (CAnceIssuesDiff × CAnceNav / 1e8); negative = net redemption
  aum: number;    // 億元 (CAnceTotalAv / 1e8)
  pnav: number;   // CAnceNav per unit
}

const BASE = 'https://etf.allianzgi.com.tw/webapi/api';
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

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

interface Antiforgery { cookieHeader: string; token: string }

// The AntiForgery endpoint sets three cookies: `.AspNetCore.Antiforgery.*` (server-side
// validation), `X-XSRF-TOKEN` (the double-submit token), and a WAF cookie. Validation needs
// ALL of them echoed back as Cookie, plus the X-XSRF-TOKEN value in the X-XSRF-TOKEN header.
function extractAntiforgery(res: Response): Antiforgery | null {
  const headersWithCookies = res.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = typeof headersWithCookies.getSetCookie === 'function'
    ? headersWithCookies.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : []);
  if (!setCookies.length) return null;

  const pairs: string[] = [];
  let token = '';
  for (const c of setCookies) {
    const pair = c.split(';')[0].trim(); // name=value
    if (!pair) continue;
    pairs.push(pair);
    const m = pair.match(/^X-XSRF-TOKEN=(.+)$/);
    if (m) token = m[1];
  }
  if (!token) return null;
  return { cookieHeader: pairs.join('; '), token };
}

async function getAntiforgery(): Promise<Antiforgery | null> {
  try {
    const res = await fetch(`${BASE}/AntiForgery/GetAntiForgeryToken`, {
      headers: { 'User-Agent': UA }, cache: 'no-store',
    });
    if (!res.ok) return null;
    return extractAntiforgery(res);
  } catch {
    return null;
  }
}

async function fetchOneAnnounce(fundNo: string, announceDash: string, af: Antiforgery): Promise<AllianzDay | null> {
  try {
    const res = await fetch(`${BASE}/Fund/GetFundTradeInfo`, {
      method: 'POST',
      headers: {
        'User-Agent':   UA,
        'Content-Type': 'application/json',
        'Cookie':       af.cookieHeader,
        'X-XSRF-TOKEN': af.token,
      },
      body: JSON.stringify({ FundNo: fundNo, Date: announceDash }),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.StatusCode !== 0) return null;
    const e = json?.Entries;
    if (!e || e.CAnceNav == null) return null;

    const navDate = String(e.CNavDt ?? '').slice(0, 10).replace(/-/g, '/');
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(navDate)) return null;

    const nav        = Number(e.CAnceNav) || 0;
    const totalav    = Number(e.CAnceTotalAv) || 0;
    const issuesdiff = Number(e.CAnceIssuesDiff) || 0;
    if (nav === 0) return null;

    return {
      date:   navDate,
      netSub: (issuesdiff * nav) / 1e8,
      aum:    totalav / 1e8,
      pnav:   nav,
    };
  } catch {
    return null;
  }
}

export async function fetchAllianzRange(
  fundNo: string,
  startDate: string, // YYYY-MM-DD (transaction date range)
  endDate: string,
): Promise<AllianzDay[]> {
  // 公告日候選 = 交易日區間往後推 5 個日曆日（涵蓋連假與海外型的多日落後）。
  const announces = weekdaysBetween(addDays(startDate, 1), addDays(endDate, 5));
  if (!announces.length) return [];

  const af = await getAntiforgery();
  if (!af) return [];

  const startSlash = startDate.replace(/-/g, '/');
  const endSlash   = endDate.replace(/-/g, '/');
  const BATCH = 5;
  const byDate = new Map<string, AllianzDay>();
  for (let i = 0; i < announces.length; i += BATCH) {
    const batch = announces.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(d => fetchOneAnnounce(fundNo, d, af)));
    for (const r of results) {
      if (r && r.date >= startSlash && r.date <= endSlash) byDate.set(r.date, r);
    }
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}
