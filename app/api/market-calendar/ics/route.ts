import { NextRequest, NextResponse } from 'next/server';
import { getCalendar } from '@/lib/marketCalendar/store';
import { buildIcs } from '@/lib/marketCalendar/ics';
import { CATEGORY_META } from '@/lib/marketCalendar/config';
import type { Category } from '@/lib/marketCalendar/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/* 手機行事曆訂閱：webcal://fhactiveetf.vercel.app/api/market-calendar/ics
   可選參數：cat=central_bank,macro（類別）、min=2（最低重要性）、alarm=30（提前 N 分鐘提醒） */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const categories = (sp.get('cat') ?? '').split(',').filter((c): c is Category => c in CATEGORY_META);
    const min = Number(sp.get('min')) || undefined;
    const alarm = Math.min(Math.max(Number(sp.get('alarm')) || 0, 0), 1440) || undefined;
    const data = await getCalendar();
    const cutoff = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
    const events = data.events.filter(e => (e.endDate ?? e.date) >= cutoff);
    const body = buildIcs(events, { categories, minImportance: min, alarmMinutes: alarm, generatedAt: data.generatedAt });
    return new NextResponse(body, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="market-calendar.ics"',
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=21600',
      },
    });
  } catch (e) {
    console.error('[market-calendar/ics]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
