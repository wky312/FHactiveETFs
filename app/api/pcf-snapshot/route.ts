import { NextRequest, NextResponse } from 'next/server';

const PCF_URL = 'https://www.fhtrust.com.tw/api/ETFPcf';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const YahooFinance = require('yahoo-finance2').default;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yf: any = new YahooFinance({ suppressNotices: ['ripHistorical'] });

export const dynamic = 'force-dynamic';

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

async function fetchPcfForDate(targetDate: string, fundId: string): Promise<{ aum: number } | null> {
  const results = await Promise.all([0, 1, 2, 3, 4].map(async (offset) => {
    const pcfDate = addDays(targetDate, offset);
    try {
      const url = `${PCF_URL}?fundID=${fundId}&pcfDate=${encodeURIComponent(pcfDate)}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' });
      if (!res.ok) return null;
      const json = await res.json();
      const d = json?.result?.[0] ?? json;
      if (!d?.actBuyValDate) return null;
      if (String(d.actBuyValDate) !== targetDate) return null;
      return { aum: parseNum(d.nav) / 1e8 };
    } catch { return null; }
  }));
  return results.find(r => r !== null) ?? null;
}

interface EtfPriceResult {
  price: number | null;
  prevClose: number | null;
  priceAsOf: string | null;
}

async function fetchEtfPrice(yfTicker: string): Promise<EtfPriceResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = await yf.quote(yfTicker, {}, { validateResult: false });
    if (!q?.regularMarketPrice) return { price: null, prevClose: null, priceAsOf: null };
    return {
      price:      q.regularMarketPrice,
      prevClose:  q.regularMarketPreviousClose ?? null,
      priceAsOf:  q.regularMarketTime ? new Date(q.regularMarketTime).toISOString() : null,
    };
  } catch { return { price: null, prevClose: null, priceAsOf: null }; }
}

export async function GET(request: NextRequest) {
  const date      = request.nextUrl.searchParams.get('date');
  const prevDate  = request.nextUrl.searchParams.get('prevDate');
  const fundId    = request.nextUrl.searchParams.get('fundId') ?? 'ETF24';
  const yfTicker  = request.nextUrl.searchParams.get('yfTicker') ?? '';

  if (!date || !prevDate) {
    return NextResponse.json({ error: '缺少 date 或 prevDate 參數' }, { status: 400 });
  }

  const [currPcf, prevPcf, etfPrice] = await Promise.all([
    fetchPcfForDate(date, fundId),
    fetchPcfForDate(prevDate, fundId),
    yfTicker ? fetchEtfPrice(yfTicker) : Promise.resolve({ price: null, prevClose: null, priceAsOf: null }),
  ]);

  return NextResponse.json({
    curr: currPcf ? { aum: currPcf.aum } : null,
    prev: prevPcf ? { aum: prevPcf.aum } : null,
    etfPrice,
  });
}
