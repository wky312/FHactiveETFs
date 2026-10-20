import { NextRequest, NextResponse } from 'next/server';
import { computeDailyChange } from '@/lib/dailyChange';

// 全 19 檔主動式 ETF「最新持股日 vs 前一持股日」的個股加減碼（全部異動口徑）。結果有 10 分鐘快取。
// ?date=YYYY-MM-DD 查指定持股日；?fresh=1 繞過快取。
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const date = sp.get('date') ?? undefined;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: 'date 格式需為 YYYY-MM-DD' }, { status: 400 });
    const data = await computeDailyChange({ date, fresh: sp.get('fresh') === '1' });
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
