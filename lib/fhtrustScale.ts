export interface ScaleDay {
  date: string;   // actBuyValDate, YYYY/MM/DD
  netSub: number; // 億元 (negative = net redemption)
  aum: number;    // 億元
  pnav: number;   // unit NAV
}

const PCF_URL = 'https://www.fhtrust.com.tw/api/ETFPcf';

function parseNum(v: unknown): number {
  if (typeof v === 'number') return v;
  return parseFloat(String(v).replace(/,/g, '')) || 0;
}

function toDateMs(dateStr: string): number {
  return new Date(dateStr.replace(/\//g, '-')).getTime();
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr.replace(/\//g, '-'));
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

function weekdaysBetween(start: string, end: string): string[] {
  const result: string[] = [];
  let cur = start;
  const endMs = toDateMs(end);
  while (toDateMs(cur) <= endMs) {
    const dow = new Date(cur.replace(/\//g, '-')).getDay();
    if (dow !== 0 && dow !== 6) result.push(cur);
    cur = addDays(cur, 1);
  }
  return result;
}

async function fetchOneDay(pcfDate: string, fundId: string): Promise<ScaleDay | null> {
  try {
    const url = `${PCF_URL}?fundID=${fundId}&pcfDate=${encodeURIComponent(pcfDate)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      next: { revalidate: 1800 },
    });
    if (!res.ok) return null;
    const json = await res.json();
    // Handle both { result: [...] } and flat response shapes
    const d = json?.result?.[0] ?? json;
    if (!d?.actBuyValDate) return null;

    const actBuyVal = parseNum(d.actBuyVal);
    const qDiff = parseNum(d.qDiff);

    return {
      date: String(d.actBuyValDate),
      netSub: actBuyVal * qDiff / 500000 / 1e8,
      aum: parseNum(d.nav) / 1e8,
      pnav: parseNum(d.pnav),
    };
  } catch {
    return null;
  }
}

export async function fetchScaleRange(
  startDate: string, // YYYY/MM/DD
  endDate: string,   // YYYY/MM/DD
  fundId = 'ETF23',
): Promise<ScaleDay[]> {
  // Query pcfDates from startDate to endDate+5 (announcement date is typically T+1)
  const pcfEnd = addDays(endDate, 5);
  const dates = weekdaysBetween(startDate, pcfEnd);

  const BATCH = 10;
  const all: ScaleDay[] = [];

  for (let i = 0; i < dates.length; i += BATCH) {
    const batch = dates.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(d => fetchOneDay(d, fundId)));
    for (const r of results) {
      if (r) all.push(r);
    }
  }

  // Filter to actBuyValDate within [startDate, endDate]
  const startMs = toDateMs(startDate);
  const endMs   = toDateMs(endDate);
  const filtered = all.filter(r => {
    const ms = toDateMs(r.date);
    return ms >= startMs && ms <= endMs;
  });

  // Sort and deduplicate by date
  filtered.sort((a, b) => a.date.localeCompare(b.date));
  const seen = new Set<string>();
  return filtered.filter(r => {
    if (seen.has(r.date)) return false;
    seen.add(r.date);
    return true;
  });
}
