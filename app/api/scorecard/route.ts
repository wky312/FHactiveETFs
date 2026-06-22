import { NextRequest, NextResponse } from 'next/server';
import { computeScorecard } from '@/lib/scorecard';

// 對基金「目前每一檔持股」逐檔抓價算成本，首次查詢（未命中快取）約需 20–60 秒。
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const fundId = request.nextUrl.searchParams.get('fundId') ?? 'ETF23';
  try {
    const data = await computeScorecard(fundId);
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
