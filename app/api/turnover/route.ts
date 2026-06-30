import { NextRequest, NextResponse } from 'next/server';
import { computeTurnover } from '@/lib/turnover';

// 用共用 Supabase 每日持股快照差分，估各檔經理人換手率。結果有 10 分鐘快取。
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const from = request.nextUrl.searchParams.get('from');
  const to   = request.nextUrl.searchParams.get('to') ?? undefined;
  if (!from) {
    return NextResponse.json({ error: '缺少 from 參數（區間起日 YYYY-MM-DD）' }, { status: 400 });
  }
  try {
    const data = await computeTurnover(from, to);
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
