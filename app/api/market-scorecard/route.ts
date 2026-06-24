import { NextRequest, NextResponse } from 'next/server';
import { computeMarketComparison } from '@/lib/marketScorecard';

// 讀共用 Supabase（19 檔每日持股快照＋股價），差分算「本期進場 VWAP」總覽。
// YTD 區間需分頁抓較多列，放寬執行時間上限。結果有 10 分鐘快取。
export const maxDuration = 300;

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
