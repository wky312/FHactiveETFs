import { NextResponse } from 'next/server';
import { computeDailyChange } from '@/lib/dailyChange';

// 全 19 檔主動式 ETF「最新持股日 vs 前一持股日」的個股加減碼（全部異動口徑）。結果有 10 分鐘快取。
export const maxDuration = 120;

export async function GET() {
  try {
    const data = await computeDailyChange();
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
