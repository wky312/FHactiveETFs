import { NextRequest, NextResponse } from 'next/server';
import { fetchKgiRange } from '@/lib/kgiScale';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const key       = request.nextUrl.searchParams.get('key');       // fundID, e.g. J024
  const startDate = request.nextUrl.searchParams.get('startDate'); // YYYY-MM-DD
  const endDate   = request.nextUrl.searchParams.get('endDate');

  if (!key || !startDate || !endDate) {
    return NextResponse.json({ error: '缺少參數' }, { status: 400 });
  }
  try {
    const data = await fetchKgiRange(key, startDate, endDate);
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}
