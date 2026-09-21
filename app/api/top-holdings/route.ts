import { NextRequest, NextResponse } from 'next/server';
import { computeTopHoldings, fundsOf, TopMarket } from '@/lib/topHoldings';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const market: TopMarket = sp.get('market') === 'os' ? 'os' : 'tw';
  try {
    const raw = sp.get('tickers');
    const tickers = raw
      ? raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      : fundsOf(market).map((f) => f.ticker);
    const res = await computeTopHoldings(market, tickers);
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : '未知錯誤' }, { status: 500 });
  }
}
