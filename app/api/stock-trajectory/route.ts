import { NextRequest, NextResponse } from 'next/server';
import { fetchTrajectory } from '@/lib/stockTrajectory';
import { getFiniConsensus } from '@/lib/finiConsensus';

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

    // 外資目標價共識——錦上添花的疊圖資料，查詢失敗絕不可影響軌跡主結果
    let finiConsensus = null;
    try {
      finiConsensus = await getFiniConsensus(data.stockid, data.currentPrice);
    } catch {
      finiConsensus = null;
    }

    return NextResponse.json({ ...data, finiConsensus });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
