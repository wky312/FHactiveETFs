// 元大投信 ETF 申購買回清單 (PCF) scraper — for 00990A 主動元大AI新經濟.
// API: GET https://etfapi.yuantaetfs.com/ectranslation/api/bridge
//        ?APIType=ETFAPI&CompanyName=YUANTAFUNDS&FuncId=PCF/Daily&ticker={ticker}&date=YYYYMMDD
// `date` is the announcement date (anndate); the response's `trandate` is the real
// transaction date (T), typically a couple of business days earlier. We query a range of
// announcement days and key each row by its returned `trandate`, so rows align on T with
// the other issuers' scrapers.

export interface YuantaDay {
  date: string;   // YYYY/MM/DD — transaction date (trandate)
  netSub: number; // 億元 (issuesdiff × nav / 1e8); negative = net redemption
  aum: number;    // 億元 (totalav / 1e8)
  pnav: number;   // nav per unit
}

const API = 'https://etfapi.yuantaetfs.com/ectranslation/api/bridge';
const UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

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

async function fetchOneAnnounce(ticker: string, announceDash: string): Promise<YuantaDay | null> {
  try {
    const url = `${API}?APIType=ETFAPI&CompanyName=YUANTAFUNDS&FuncId=PCF/Daily&ticker=${encodeURIComponent(ticker)}&date=${ymd(announceDash)}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, next: { revalidate: 1800 } });
    if (!res.ok) return null;
    const json = await res.json();
    const pcf = json?.PCF;
    if (!pcf || pcf.trandate == null || pcf.nav == null) return null;

    const nav = Number(pcf.nav) || 0;
    const totalav = Number(pcf.totalav) || 0;
    const issuesdiff = Number(pcf.issuesdiff) || 0;
    if (nav === 0) return null;

    return {
      date:   toSlash(String(pcf.trandate)),
      netSub: (issuesdiff * nav) / 1e8,
      aum:    totalav / 1e8,
      pnav:   nav,
    };
  } catch {
    return null;
  }
}

export async function fetchYuantaRange(
  ticker: string,
  startDate: string, // YYYY-MM-DD — transaction date range
  endDate: string,
): Promise<YuantaDay[]> {
  // Announcement lags the transaction date by ~1–3 business days → widen the query window.
  const announceDates = weekdaysBetween(addDays(startDate, 1), addDays(endDate, 5));
  if (!announceDates.length) return [];

  const startSlash = startDate.replace(/-/g, '/');
  const endSlash   = endDate.replace(/-/g, '/');

  const BATCH = 5;
  const all: YuantaDay[] = [];
  for (let i = 0; i < announceDates.length; i += BATCH) {
    const batch = announceDates.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(d => fetchOneAnnounce(ticker, d)));
    for (const r of results) if (r) all.push(r);
  }

  // Keep transaction dates within [start, end], dedupe by date.
  const seen = new Set<string>();
  return all
    .filter(r => {
      if (r.date < startSlash || r.date > endSlash) return false;
      if (seen.has(r.date)) return false;
      seen.add(r.date);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
