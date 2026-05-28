import { NextRequest, NextResponse } from 'next/server';
import { fetchScaleRange } from '@/lib/fhtrustScale';

const MAX_DAYS = 366;

export async function GET(request: NextRequest) {
  const startDate = request.nextUrl.searchParams.get('startDate');
  const endDate   = request.nextUrl.searchParams.get('endDate');
  const fundId    = request.nextUrl.searchParams.get('fundId') ?? 'ETF23';

  if (!startDate || !endDate) {
    return NextResponse.json(
      { error: '缺少 startDate 或 endDate 參數（格式：YYYY/MM/DD）' },
      { status: 400 },
    );
  }

  const startMs = new Date(startDate.replace(/\//g, '-')).getTime();
  const endMs   = new Date(endDate.replace(/\//g, '-')).getTime();
  if (isNaN(startMs) || isNaN(endMs) || startMs > endMs) {
    return NextResponse.json(
      { error: '日期格式錯誤或開始日期晚於結束日期' },
      { status: 400 },
    );
  }
  if ((endMs - startMs) / 86400000 > MAX_DAYS) {
    return NextResponse.json(
      { error: `查詢區間不能超過 ${MAX_DAYS} 天` },
      { status: 400 },
    );
  }

  try {
    const data = await fetchScaleRange(startDate, endDate, fundId);
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
