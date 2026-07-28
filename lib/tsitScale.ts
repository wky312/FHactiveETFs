// 台新投信 ETF 申購買回清單 (PCF) scraper — for 00986A 主動台新全球龍頭.
// Page: https://www.tsit.com.tw/ETF/Home/Pcf/{ticker}?FundType=&DataDate=YYYY-MM-DD
// Server-rendered HTML，版型是 `<th>label</th><td>value</td>`。
//
// ⚠️ DataDate 是**公告日**、不是交易日：00986A 是海外型，7/28 公告的內容是 7/24 的資料。
// 資料日只出現在「YYYY/M/D每基數實際申購總價金」標籤前綴 → 查公告日候選、用它把每筆歸位。
// 非公告日回全 0 的列。

export interface TsitDay {
  date: string;   // YYYY/MM/DD (資料日)
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

async function fetchOneAnnounce(ticker: string, announceDash: string): Promise<TsitDay | null> {
  try {
    const url = `https://www.tsit.com.tw/ETF/Home/Pcf/${encodeURIComponent(ticker)}?FundType=&DataDate=${announceDash}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, next: { revalidate: 1800 } });
    if (!res.ok) return null;
    const html = await res.text();

    // 資料日只出現在「YYYY/M/D每基數實際申購總價金」這個標籤前綴（月/日未補零）。
    const m = html.match(/<th>(\d{4})\/(\d{1,2})\/(\d{1,2})每基數實際申購總價金/);
    if (!m) return null;
    const navDate = `${m[1]}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}`;

    const diffUnit = parseNum(field(html, '與前日已發行單位差異數'));
    const nav      = parseNum(field(html, '基金淨資產價值'));
    const pnav     = parseNum(field(html, '每受益權單位淨資產價值'));

    // Non-trading day / before listing → NAV is 0.
    if (nav === 0 || pnav === 0) return null;

    return {
      date:   navDate,
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
  const announces = weekdaysBetween(addDays(startDate, 1), addDays(endDate, 5));
  if (!announces.length) return [];

  const startSlash = startDate.replace(/-/g, '/');
  const endSlash   = endDate.replace(/-/g, '/');
  const BATCH = 5;
  const byDate = new Map<string, TsitDay>();
  for (let i = 0; i < announces.length; i += BATCH) {
    const batch = announces.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(d => fetchOneAnnounce(ticker, d)));
    for (const r of results) {
      if (r && r.date >= startSlash && r.date <= endSlash) byDate.set(r.date, r);
    }
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}
