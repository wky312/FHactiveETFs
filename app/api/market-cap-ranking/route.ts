import { NextResponse } from 'next/server';
import { computeMarketCapRanking } from '@/lib/marketCapRanking';

// 全台股市值前150大漲跌排行 + 00981A/00991A持股比例。結果有 15 分鐘快取。
export const maxDuration = 60;

export async function GET() {
  try {
    const data = await computeMarketCapRanking();
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
