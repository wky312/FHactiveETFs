import { NextRequest, NextResponse } from 'next/server';
import { fetchTrajectory } from '@/lib/stockTrajectory';

// 逐交易日掃描，首次查詢可能 15–30 秒
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const q      = request.nextUrl.searchParams.get('q');
  const fundId = request.nextUrl.searchParams.get('fundId') ?? 'ETF23';

  if (!q || !q.trim()) {
    return NextResponse.json({ error: '缺少 q 參數（股票代碼或名稱）' }, { status: 400 });
  }

  try {
    const data = await fetchTrajectory(q, fundId);
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
