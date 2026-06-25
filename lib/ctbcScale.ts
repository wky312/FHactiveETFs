// 中國信託投信 (CTBC Investments) ETF 申購買回清單 (PCF) scraper — for 00983A 主動中信ARK創新.
// Two-step JSON API on https://www.ctbcinvestments.com.tw (note: .com.tw, not .com):
//   1. POST /API/home/AuthToken?token=www.ctbcinvestments.com  → Data.token (URL-encode for reuse)
//   2. POST /API/etf/Buyback?token={enc}  body {"FID":fid,"StartDate":"YYYY-MM-DD"} → Data.Data[0]
// StartDate is the disclosure date (= transaction date T for this DSP-style page); a
// non-trading day returns an empty Data.Data array.

export interface CtbcDay {
  date: string;   // YYYY/MM/DD (the queried transaction date)
  netSub: number; // 億元 (DIFF_UNIT × P_UNIT / 1e8); negative = net redemption
  aum: number;    // 億元 (基金淨資產價值 / 1e8)
  pnav: number;   // 每受益權單位淨資產價值
}

const BASE = 'https://www.ctbcinvestments.com.tw/API';
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = {
  'User-Agent':   UA,
  'Content-Type': 'application/json; charset=utf-8',
  'Referer':      'https://www.ctbcinvestments.com.tw/Etf/Buyback',
};

function parseNum(v: unknown): number {
  if (typeof v === 'number') return v;
  const s = String(v ?? '');
  const neg = /\(.*\)/.test(s) || s.includes('−') || /-\s*[\d]/.test(s);
  const n = parseFloat(s.replace(/[,\s]/g, '').replace(/[^0-9.]/g, '')) || 0;
  return neg ? -Math.abs(n) : n;
}

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

async function getToken(): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/home/AuthToken?token=www.ctbcinvestments.com`, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ token: 'www.ctbcinvestments.com' }),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.Data?.token ?? null;
  } catch {
    return null;
  }
}

async function fetchOneDay(fid: string, dateDash: string, encToken: string): Promise<CtbcDay | null> {
  try {
    const res = await fetch(`${BASE}/etf/Buyback?token=${encToken}`, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ FID: fid, StartDate: dateDash }),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = await res.json();
    const row = json?.Data?.Data?.[0];
    if (!row) return null;

    const diffUnit = parseNum(row['與前日已發行單位差異數']);
    const nav      = parseNum(row['基金淨資產價值']);
    const pnav     = parseNum(row['每受益權單位淨資產價值']);
    if (nav === 0 || pnav === 0) return null;

    return {
      date:   dateDash.replace(/-/g, '/'),
      netSub: (diffUnit * pnav) / 1e8,
      aum:    nav / 1e8,
      pnav,
    };
  } catch {
    return null;
  }
}

export async function fetchCtbcRange(
  fid: string,
  startDate: string, // YYYY-MM-DD (transaction date range)
  endDate: string,
): Promise<CtbcDay[]> {
  const dates = weekdaysBetween(startDate, endDate);
  if (!dates.length) return [];

  const token = await getToken();
  if (!token) return [];
  const encToken = encodeURIComponent(token);

  const BATCH = 5;
  const all: CtbcDay[] = [];
  for (let i = 0; i < dates.length; i += BATCH) {
    const batch = dates.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(d => fetchOneDay(fid, d, encToken)));
    for (const r of results) if (r) all.push(r);
  }
  return all.sort((a, b) => a.date.localeCompare(b.date));
}
