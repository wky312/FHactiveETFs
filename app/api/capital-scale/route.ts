import { NextRequest, NextResponse } from 'next/server';
import { fetchCapitalRange } from '@/lib/capitalScale';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const fundId    = request.nextUrl.searchParams.get('fundId');
  const startDate = request.nextUrl.searchParams.get('startDate');
  const endDate   = request.nextUrl.searchParams.get('endDate');

  if (!fundId || !startDate || !endDate) {
    return NextResponse.json({ error: '缺少參數' }, { status: 400 });
  }

  try {
    const data = await fetchCapitalRange(fundId, startDate, endDate);
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
