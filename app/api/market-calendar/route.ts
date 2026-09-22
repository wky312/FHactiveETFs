import { NextRequest, NextResponse } from 'next/server';
import { getCalendar, refresh } from '@/lib/marketCalendar/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/* ?refresh=1 由 Vercel Cron 觸發（帶 Authorization: Bearer $CRON_SECRET）；&history=1 連歷史反應一起重算 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    if (sp.get('refresh') === '1') {
      const secret = process.env.CRON_SECRET;
      if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const p = await refresh({ forceHistory: sp.get('history') === '1' });
      return NextResponse.json({ ok: true, generatedAt: p.generatedAt, events: p.events.length, sources: p.sources });
    }
    return NextResponse.json(await getCalendar(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[market-calendar]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
