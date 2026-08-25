import { NextResponse } from 'next/server';
import { computeOverseasConsensus } from '@/lib/consensusOverseas';

// 海外族群曝險的橫向持股統計，比照 /api/consensus 但資料源是 fhtrust+CMoney 即時抓取
// （見 lib/consensusOverseas.ts），不是 Supabase。只給「最新」，v1 不支援 asOf 歷史查詢。
export const maxDuration = 120;

export async function GET() {
  try {
    const data = await computeOverseasConsensus();
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
