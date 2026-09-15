import { NextRequest, NextResponse } from 'next/server';
import { computeUsImpact } from '@/lib/usImpact';
import { listOverseasFunds } from '@/lib/overseasAttribution';
import { OVERSEAS_FUNDS } from '@/lib/overseasFunds';

export const dynamic = 'force-dynamic';
// 多檔基金各自的持股 + 聯集美股個股報價/匯率都打 Yahoo，首次查詢可能數十秒
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  try {
    // ?funds=1 → 可選的海外主動式 ETF 清單（給勾選清單用；沿用海外個股歸因同一份清單）
    if (sp.get('funds') === '1') {
      return NextResponse.json(listOverseasFunds(), { headers: { 'Cache-Control': 'no-store' } });
    }
    const raw = sp.get('tickers');
    const tickers = raw
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : OVERSEAS_FUNDS.map((f) => f.ticker);
    const res = await computeUsImpact(tickers);
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : '未知錯誤' },
      { status: 500 },
    );
  }
}
