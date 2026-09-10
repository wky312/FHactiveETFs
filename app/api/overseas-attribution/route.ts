import { NextRequest, NextResponse } from 'next/server';
import { computeOverseas, listOverseasFunds } from '@/lib/overseasAttribution';

export const dynamic = 'force-dynamic';
// 逐檔外國股 + 匯率都打 Yahoo，首次查詢可能 30–90 秒
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  try {
    // ?funds=1 → 可比較的海外主動式 ETF 清單（給下拉用）
    if (sp.get('funds') === '1') {
      return NextResponse.json(listOverseasFunds(), { headers: { 'Cache-Control': 'no-store' } });
    }
    const a = sp.get('a'), b = sp.get('b'), start = sp.get('start');
    if (!a || !b || !start) {
      return NextResponse.json({ error: '缺少參數（需 a, b, start）' }, { status: 400 });
    }
    const res = await computeOverseas(a, b, start, sp.get('total') === '1', sp.get('end') || undefined);
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : '未知錯誤' },
      { status: 500 },
    );
  }
}
