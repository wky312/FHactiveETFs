// 安聯投信 (Allianz GI Taiwan) ETF 申購買回 scraper — for 00402A 主動安聯美國科技.
// Angular SPA backend with XSRF protection. Two steps:
//   1. GET  /webapi/api/AntiForgery/GetAntiForgeryToken  → Set-Cookie: XSRF-TOKEN=…
//   2. POST /webapi/api/Fund/GetFundTradeInfo  (Cookie + X-XSRF-TOKEN header)
//        body {"FundNo":fundNo,"Date":"YYYY-MM-DD"} → { StatusCode:0, Entries:{…} }
// 00402A → FundNo "E0003". Entries is an OBJECT (not an array). CPcfdate echoes the queried
// (transaction) date; StatusCode:1 means non-trading day.

export interface AllianzDay {
  date: string;   // YYYY/MM/DD (the queried transaction date)
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

async function fetchOneDay(fundNo: string, dateDash: string, af: Antiforgery): Promise<AllianzDay | null> {
  try {
    const res = await fetch(`${BASE}/Fund/GetFundTradeInfo`, {
      method: 'POST',
      headers: {
        'User-Agent':   UA,
        'Content-Type': 'application/json',
        'Cookie':       af.cookieHeader,
        'X-XSRF-TOKEN': af.token,
      },
      body: JSON.stringify({ FundNo: fundNo, Date: dateDash }),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.StatusCode !== 0) return null;
    const e = json?.Entries;
    if (!e || e.CAnceNav == null) return null;

    const nav        = Number(e.CAnceNav) || 0;
    const totalav    = Number(e.CAnceTotalAv) || 0;
    const issuesdiff = Number(e.CAnceIssuesDiff) || 0;
    if (nav === 0) return null;

    return {
      date:   dateDash.replace(/-/g, '/'),
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
  const dates = weekdaysBetween(startDate, endDate);
  if (!dates.length) return [];

  const af = await getAntiforgery();
  if (!af) return [];

  const BATCH = 5;
  const all: AllianzDay[] = [];
  for (let i = 0; i < dates.length; i += BATCH) {
    const batch = dates.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(d => fetchOneDay(fundNo, d, af)));
    for (const r of results) if (r) all.push(r);
  }
  return all.sort((a, b) => a.date.localeCompare(b.date));
}
