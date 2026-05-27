import { NextResponse } from 'next/server';
import { fetch0050Data } from '@/lib/twse';
import { buildPrediction, RebalancePrediction } from '@/lib/tw0050';

let cache: { data: RebalancePrediction; ts: number } | null = null;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json(cache.data);
  }

  try {
    const { members, stocks } = await fetch0050Data();
    const ranked = [...stocks].sort((a, b) => b.marketCap - a.marketCap);
    const prediction = buildPrediction(ranked, new Set(members));
    cache = { data: prediction, ts: Date.now() };
    return NextResponse.json(prediction, {
      headers: { 'Cache-Control': 's-maxage=1800, stale-while-revalidate=3600' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
