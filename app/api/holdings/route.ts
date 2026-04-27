import { NextRequest, NextResponse } from 'next/server';
import { fetchHoldings } from '@/lib/fhtrust';

export async function GET(request: NextRequest) {
  const date   = request.nextUrl.searchParams.get('date');
  const fundId = request.nextUrl.searchParams.get('fundId') ?? 'ETF24';
  if (!date) {
    return NextResponse.json({ error: '缺少 date 參數（格式：YYYY/MM/DD）' }, { status: 400 });
  }

  try {
    const data = await fetchHoldings(date, fundId);
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
