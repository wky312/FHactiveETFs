import { NextRequest, NextResponse } from 'next/server';
import { fetchFubonRange } from '@/lib/fubonScale';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const stkId     = request.nextUrl.searchParams.get('stkId');
  const startDate = request.nextUrl.searchParams.get('startDate');
  const endDate   = request.nextUrl.searchParams.get('endDate');

  if (!stkId || !startDate || !endDate) {
    return NextResponse.json({ error: '缺少參數' }, { status: 400 });
  }

  try {
    const data = await fetchFubonRange(stkId, startDate, endDate);
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
