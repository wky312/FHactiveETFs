import { NextResponse } from 'next/server';
import { fetchStockPerformance } from '@/lib/yahooFinance';

// 供「創新高強勢股」預設「高點比較基準」用：抓加權指數（^TWII）今年至今的最高點日期，
// 直接重用 fetchStockPerformance()（不傳 highSince，內部即以 ytdTarget=今年1/1 為基準），
// 回傳的 postHigh/postHighDate 就是「今年以來最高點」。
export async function GET() {
  try {
    const perf = await fetchStockPerformance('^TWII', '加權指數', 0, '^TWII');
    return NextResponse.json(
      { date: perf.postHighDate, price: perf.postHigh },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
