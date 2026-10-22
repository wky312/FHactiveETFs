import { NextResponse } from 'next/server';
import { computeTop350Etf } from '@/lib/top350Etf';

// 市值前350大：YTD/近一季/近一月/近一週（還原權息）＋ 台股主動式ETF持有狀況。
// 350檔逐一查Yahoo，成本較高；績效層以「最新收盤日」為key做記憶體+Supabase快取。
export const maxDuration = 280;

export async function GET() {
  try {
    const data = await computeTop350Etf();
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
