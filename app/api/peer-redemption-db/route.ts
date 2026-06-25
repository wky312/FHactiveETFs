import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase credentials not configured');
  return createClient(url, key);
}

export async function GET(request: NextRequest) {
  const startDate = request.nextUrl.searchParams.get('startDate'); // YYYY-MM-DD
  const endDate   = request.nextUrl.searchParams.get('endDate');
  const group     = request.nextUrl.searchParams.get('group') ?? 'tw_active';

  if (!startDate || !endDate) {
    return NextResponse.json({ error: 'Missing startDate or endDate' }, { status: 400 });
  }

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('peer_redemption')
      .select('date, ticker, net_sub, aum')
      .eq('group', group)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: false });

    if (error) throw new Error(error.message);

    // Transform flat rows → DayRow[]  { date, data: { ticker: {netSub, aum} } }
    // Columns are driven by the client's group definition, so we only emit the
    // tickers that actually have data; the frontend renders '—' for the rest.
    const dayMap = new Map<string, Record<string, { netSub: number; aum: number } | null>>();

    for (const row of (data ?? [])) {
      const d = (row.date as string).slice(0, 10); // ensure YYYY-MM-DD
      if (!dayMap.has(d)) dayMap.set(d, {});
      dayMap.get(d)![row.ticker] = { netSub: row.net_sub, aum: row.aum };
    }

    const rows = Array.from(dayMap.entries())
      .map(([date, tickerData]) => ({ date, data: tickerData }))
      .sort((a, b) => b.date.localeCompare(a.date));

    return NextResponse.json(
      { rows, count: rows.length },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
