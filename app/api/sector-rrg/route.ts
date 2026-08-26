import { NextRequest, NextResponse } from 'next/server';
import { computeSectorRRG } from '@/lib/sectorRRG';
import { HeatmapMarket } from '@/lib/sectorGroupsShared';

// 產業相對強度四象限（RRG）：45組(國內)/15組(海外)族群對 0050 的 JdK RS-Ratio/Momentum。
// 1年週線逐檔抓取，成本量級同產業熱力圖，見 lib/sectorRRG.ts 的快取說明。
export const maxDuration = 280;

export async function GET(request: NextRequest) {
  const market: HeatmapMarket = request.nextUrl.searchParams.get('market') === 'overseas' ? 'overseas' : 'tw';
  try {
    const data = await computeSectorRRG(market);
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
