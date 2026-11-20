import { NextRequest, NextResponse } from 'next/server';
import { PEER_GROUPS, type PeerItem } from '@/lib/peerGroups';
import { computePeerPerformance, type CustomRange } from '@/lib/peerPerformance';

export const dynamic = 'force-dynamic';

export { PEER_GROUPS, type PeerItem };   // 維持原有 re-export，供其他模組沿用
export type { PeerPerfResult } from '@/lib/peerPerformance';

// 報酬算法本體在 lib/peerPerformance.ts（與客訴回覆助手共用）。

export async function GET(request: NextRequest) {
  const groupId     = request.nextUrl.searchParams.get('group') ?? 'active';
  const group       = PEER_GROUPS[groupId] ?? PEER_GROUPS['active'];
  const startStr    = request.nextUrl.searchParams.get('startDate');
  const endStr      = request.nextUrl.searchParams.get('endDate');
  // 兩端都用當日 23:59:59 當截止點：Yahoo 日 K 棒時間戳為 01:00Z（台股開盤），
  // 若起始日用 00:00:00 會落在「前一個交易日」，導致基準價抓錯（區間報酬被灌高）。
  // 以還原收盤計算，起始日的基準即為「起始日當天收盤」，與年初至今(去年底收盤)同口徑。
  const customRange: CustomRange | undefined = startStr && endStr ? {
    start: new Date(startStr + 'T23:59:59'),
    end:   new Date(endStr   + 'T23:59:59'),
  } : undefined;

  const results = await computePeerPerformance(group.items, customRange);
  return NextResponse.json(results, { headers: { 'Cache-Control': 'no-store' } });
}
