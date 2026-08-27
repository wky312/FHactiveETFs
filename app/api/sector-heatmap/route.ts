import { NextRequest, NextResponse } from 'next/server';
import { computeSectorHeatmap } from '@/lib/sectorHeatmap';
import { HeatmapMarket } from '@/lib/sectorGroupsShared';

// 產業熱力圖：45組(國內)/15組(海外)內建族群的區間漲跌。269/122檔逐一查 Yahoo，成本較高，見 lib/sectorHeatmap.ts 的快取說明。
export const maxDuration = 280;

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const market: HeatmapMarket = sp.get('market') === 'overseas' ? 'overseas' : 'tw';
  const start = sp.get('start') ?? undefined;
  const end = sp.get('end') ?? undefined;
  const force = sp.get('force') === '1';
  if ((start && !end) || (end && !start)) {
    return NextResponse.json({ error: 'start 與 end 必須同時提供' }, { status: 400 });
  }
  try {
    const data = await computeSectorHeatmap(market, start, end, force);
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
