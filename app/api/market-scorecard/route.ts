import { NextRequest, NextResponse } from 'next/server';
import { computeMarketComparison } from '@/lib/marketScorecard';

// 讀共用 Supabase（19 檔持股＋股價），算同區間總覽；資料量小，數秒內。
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const from = request.nextUrl.searchParams.get('from');
  const to   = request.nextUrl.searchParams.get('to') ?? undefined;
  if (!from) {
    return NextResponse.json({ error: '缺少 from 參數（區間起日 YYYY-MM-DD）' }, { status: 400 });
  }
  try {
    const data = await computeMarketComparison(from, to);
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
