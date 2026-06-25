// 台新投信 ETF 申購買回清單 (PCF) scraper — for 00986A 主動台新全球龍頭.
// Page: https://www.tsit.com.tw/ETF/Home/Pcf/{ticker}?FundType=&DataDate=YYYY-MM-DD
// Server-rendered HTML; the queried DataDate is the transaction date (non-trading days
// return all-zero rows). Layout is `<th>label</th><td>value</td>`.

export interface TsitDay {
  date: string;   // YYYY/MM/DD (the queried transaction date)
  netSub: number; // 億元 (DIFF_UNIT × P_UNIT / 1e8); negative = net redemption
  aum: number;    // 億元 (基金淨資產價值 / 1e8)
  pnav: number;   // 每受益權單位淨資產價值
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function parseNum(v: string | null): number {
  if (v === null) return 0;
  const neg = /\(.*\)/.test(v) || v.includes('−') || /-\s*[\d]/.test(v);
  const n = parseFloat(v.replace(/[,\s]/g, '').replace(/[^0-9.]/g, '')) || 0;
  return neg ? -Math.abs(n) : n;
}

// Match `<th>label…</th> <td>value</td>` (label may carry a (元) suffix).
function field(html: string, label: string): string | null {
  const m = html.match(new RegExp(`<th>${label}[^<]*</th>\\s*<td>([^<]*)</td>`));
  return m ? m[1].trim() : null;
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

async function fetchOneDay(ticker: string, dateDash: string): Promise<TsitDay | null> {
  try {
    const url = `https://www.tsit.com.tw/ETF/Home/Pcf/${encodeURIComponent(ticker)}?FundType=&DataDate=${dateDash}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, next: { revalidate: 1800 } });
    if (!res.ok) return null;
    const html = await res.text();

    const diffUnit = parseNum(field(html, '與前日已發行單位差異數'));
    const nav      = parseNum(field(html, '基金淨資產價值'));
    const pnav     = parseNum(field(html, '每受益權單位淨資產價值'));

    // Non-trading day / before listing → NAV is 0.
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

export async function fetchTsitRange(
  ticker: string,
  startDate: string, // YYYY-MM-DD (transaction date range)
  endDate: string,
): Promise<TsitDay[]> {
  const dates = weekdaysBetween(startDate, endDate);
  if (!dates.length) return [];

  const BATCH = 5;
  const all: TsitDay[] = [];
  for (let i = 0; i < dates.length; i += BATCH) {
    const batch = dates.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(d => fetchOneDay(ticker, d)));
    for (const r of results) if (r) all.push(r);
  }
  return all.sort((a, b) => a.date.localeCompare(b.date));
}
