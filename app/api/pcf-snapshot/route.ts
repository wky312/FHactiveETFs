import { NextRequest, NextResponse } from 'next/server';

const PCF_URL = 'https://www.fhtrust.com.tw/api/ETFPcf';

function parseNum(v: unknown): number {
  if (typeof v === 'number') return v;
  return parseFloat(String(v).replace(/,/g, '')) || 0;
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr.replace(/\//g, '-'));
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${mo}/${day}`;
}

async function fetchPcfForDate(targetDate: string, fundId: string): Promise<{ aum: number; pnav: number } | null> {
  // pcfDate is typically actBuyValDate + 1~4 business days; try offsets in parallel
  const results = await Promise.all([0, 1, 2, 3, 4].map(async (offset) => {
    const pcfDate = addDays(targetDate, offset);
    try {
      const url = `${PCF_URL}?fundID=${fundId}&pcfDate=${encodeURIComponent(pcfDate)}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, next: { revalidate: 1800 } });
      if (!res.ok) return null;
      const json = await res.json();
      const d = json?.result?.[0] ?? json;
      if (!d?.actBuyValDate) return null;
      if (String(d.actBuyValDate) !== targetDate) return null;
      return { aum: parseNum(d.nav) / 1e8, pnav: parseNum(d.pnav) };
    } catch { return null; }
  }));
  return results.find(r => r !== null) ?? null;
}

export async function GET(request: NextRequest) {
  const date     = request.nextUrl.searchParams.get('date');
  const prevDate = request.nextUrl.searchParams.get('prevDate');
  const fundId   = request.nextUrl.searchParams.get('fundId') ?? 'ETF24';

  if (!date || !prevDate) {
    return NextResponse.json({ error: '缺少 date 或 prevDate 參數' }, { status: 400 });
  }

  const [curr, prev] = await Promise.all([
    fetchPcfForDate(date, fundId),
    fetchPcfForDate(prevDate, fundId),
  ]);

  return NextResponse.json({ curr, prev });
}
