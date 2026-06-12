// 富邦投信 ETF 申購買回清單 (PCF) scraper.
// Page: https://websys.fsit.com.tw/FubonETF/Trade/Pcf.aspx?stkId={stkId}&ddate=YYYYMMDD&lan=TW
// A specific date is selected purely via the `ddate` query param (the page's
// "查詢" button just 302-redirects to that GET), so no ASP.NET postback is needed.

export interface FubonDay {
  date: string;   // YYYY/MM/DD (the queried trade date)
  netSub: number; // 億元 (qDiff × actBuyVal / cu / 1e8); negative = net redemption
  aum: number;    // 億元 (基金淨資產價值 / 1e8)
  pnav: number;   // 每受益權單位淨資產價值 (NAV per unit)
}

const HOST = 'websys.fsit.com.tw';
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function parseNum(v: string | null): number {
  if (v === null) return 0;
  // Strip NT$, full-width chars, commas; normalise unicode minus; keep parentheses as negative.
  const neg = /\(.*\)/.test(v) || v.includes('−') || v.includes('-');
  const n = parseFloat(v.replace(/[,\s]/g, '').replace(/[^0-9.]/g, '')) || 0;
  return neg ? -Math.abs(n) : n;
}

// Pull a `<p>label</p><p>value</p>` pair out of the PCF list. The label is
// anchored with a leading `>` so the meta-description text (which lists the
// same words separated by 、) can never match.
function field(html: string, label: string): string | null {
  const m = html.match(new RegExp(`>${label}</p>\\s*<p>([^<]*)</p>`));
  return m ? m[1].trim() : null;
}

function toDdate(dateStr: string): string {
  return dateStr.replace(/[-/]/g, '');
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

async function fetchOneDay(stkId: string, dateStr: string): Promise<FubonDay | null> {
  try {
    const ddate = toDdate(dateStr);
    const url = `https://${HOST}/FubonETF/Trade/Pcf.aspx?stkId=${encodeURIComponent(stkId)}&ddate=${ddate}&lan=TW`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, next: { revalidate: 1800 } });
    if (!res.ok) return null;
    const html = await res.text();

    // 每申購基數實際申購總價金 label is prefixed with the trade date, so match without a leading `>`.
    const actRaw = html.match(/每申購基數實際申購總價金<\/p>\s*<p>([^<]*)<\/p>/);

    const qDiff     = parseNum(field(html, '與前日已發行單位差異數'));
    const cu        = parseNum(field(html, '每申購/買回基數之受益權單位數'));
    const nav       = parseNum(field(html, '基金淨資產價值'));
    const pnav      = parseNum(field(html, '每受益權單位淨資產價值'));
    const actBuyVal = parseNum(actRaw ? actRaw[1].trim() : null);

    // cu/nav are 0 on non-trading days and before the fund's listing → no data.
    if (cu === 0 || nav === 0) return null;

    const sd = html.match(/id="mainContent_subMainContent_sDate"[^>]*value="([^"]*)"/);
    const date = sd ? sd[1] : dateStr.replace(/-/g, '/');

    return {
      date,
      netSub: (qDiff * actBuyVal) / cu / 1e8,
      aum:    nav / 1e8,
      pnav,
    };
  } catch {
    return null;
  }
}

export async function fetchFubonRange(
  stkId: string,
  startDate: string, // YYYY-MM-DD (trade date range)
  endDate: string,
): Promise<FubonDay[]> {
  const dates = weekdaysBetween(startDate, endDate);
  if (!dates.length) return [];

  const BATCH = 5;
  const all: FubonDay[] = [];
  for (let i = 0; i < dates.length; i += BATCH) {
    const batch = dates.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(d => fetchOneDay(stkId, d)));
    for (const r of results) if (r) all.push(r);
  }

  return all.sort((a, b) => a.date.localeCompare(b.date));
}
