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

    // ⚠ PostgREST 一次最多回 1000 列，**超過的部分靜默消失、不會報錯**。
    // tw_active 是 14 檔 × 每個交易日一列 → 只要區間超過約 71 個交易日就會被截；
    // 實測 2026-01-01→09-12 只回得到 5/29 以後的 74 天，前四個月憑空不見。
    // 所以一定要分頁抓完；排序必須「全序」（date+ticker 就是這張表的主鍵），
    // 否則同值邊界會在分頁之間漏列或重複列。
    const PAGE = 1000;
    const data: { date: string; ticker: string; net_sub: number; aum: number; is_estimate: boolean }[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data: page, error } = await supabase
        .from('peer_redemption')
        .select('date, ticker, net_sub, aum, is_estimate')
        .eq('group', group)
        .gte('date', startDate)
        .lte('date', endDate)
        .order('date', { ascending: false })
        .order('ticker', { ascending: true })
        .range(from, from + PAGE - 1);

      if (error) throw new Error(error.message);
      if (!page?.length) break;
      data.push(...page);
      if (page.length < PAGE) break;
    }

    // Transform flat rows → DayRow[]  { date, data: { ticker: {netSub, aum, isEstimate} } }
    // Columns are driven by the client's group definition, so we only emit the
    // tickers that actually have data; the frontend renders '—' for the rest.
    // isEstimate: 正式公告出來前，從申購買回清單的「預估發行受益權單位數」概算的暫定值
    // （見 scripts/daily_summary.py 的 fetch_*_estimate），之後會被正式值覆蓋。
    const dayMap = new Map<string, Record<string, { netSub: number; aum: number; isEstimate: boolean } | null>>();

    for (const row of data) {
      const d = (row.date as string).slice(0, 10); // ensure YYYY-MM-DD
      if (!dayMap.has(d)) dayMap.set(d, {});
      dayMap.get(d)![row.ticker] = { netSub: row.net_sub, aum: row.aum, isEstimate: !!row.is_estimate };
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
