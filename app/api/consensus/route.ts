import { NextRequest, NextResponse } from 'next/server';
import { computeConsensus } from '@/lib/consensus';

// 全 19 檔主動式 ETF 最新持股的橫向共識統計。結果有 10 分鐘快取。
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const asOf = request.nextUrl.searchParams.get('asOf') ?? undefined;
  try {
    const data = await computeConsensus(asOf);
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
