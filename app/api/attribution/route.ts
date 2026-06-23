import { NextRequest, NextResponse } from 'next/server';
import { compute, listFunds } from '@/lib/attribution';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  try {
    // ?funds=1 → 回傳可比較的基金清單（給下拉用）
    if (sp.get('funds') === '1') {
      return NextResponse.json(await listFunds(), { headers: { 'Cache-Control': 'no-store' } });
    }
    const a = sp.get('a'), b = sp.get('b'), start = sp.get('start');
    if (!a || !b || !start) {
      return NextResponse.json({ error: '缺少參數（需 a, b, start）' }, { status: 400 });
    }
    const res = await compute(a, b, start, sp.get('total') === '1', sp.get('end') || undefined);
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : '未知錯誤' },
      { status: 500 },
    );
  }
}
