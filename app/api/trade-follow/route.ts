import { NextRequest, NextResponse } from 'next/server';
import { computeTradeFollow, listTradeFollowFunds } from '@/lib/tradeFollow';

export const dynamic = 'force-dynamic';
// 每檔換過的股票＋匯率＋基金市價都打 Yahoo，首次查詢可能 30–90 秒（之後 10 分鐘內快取）
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  try {
    if (sp.get('funds') === '1') {
      return NextResponse.json(listTradeFollowFunds(), { headers: { 'Cache-Control': 'no-store' } });
    }
    const fund = sp.get('fund'), start = sp.get('start');
    if (!fund || !start) {
      return NextResponse.json({ error: '缺少參數（需 fund, start）' }, { status: 400 });
    }
    const res = await computeTradeFollow(fund, start, sp.get('end') || undefined);
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : '未知錯誤' }, { status: 500 });
  }
}
