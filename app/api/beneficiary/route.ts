import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { BENEFICIARY_TICKERS, RawRow, buildWeeks } from '@/lib/beneficiary';

export const dynamic = 'force-dynamic';

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase credentials not configured');
  return createClient(url, key);
}

export async function GET(request: NextRequest) {
  const ticker = (request.nextUrl.searchParams.get('ticker') ?? '00991A').toUpperCase();
  const meta = BENEFICIARY_TICKERS.find(t => t.ticker === ticker);
  if (!meta) {
    return NextResponse.json({ error: `未追蹤此標的：${ticker}` }, { status: 400 });
  }

  try {
    const supabase = getSupabase();
    // 一檔約 51 週 × 17 列 ≈ 870 列，一次取回綽綽有餘，但仍分頁避免 PostgREST 預設上限截斷。
    const rows: RawRow[] = [];
    const step = 1000;
    for (let offset = 0; ; offset += step) {
      const { data, error } = await supabase
        .from('beneficiary_counts')
        .select('date, level, people, units, pct')
        .eq('ticker', ticker)
        .order('date', { ascending: true })
        .range(offset, offset + step - 1);
      if (error) throw new Error(error.message);
      const batch = (data ?? []) as RawRow[];
      rows.push(...batch);
      if (batch.length < step) break;
    }

    const weeks = buildWeeks(rows);
    return NextResponse.json(
      { ticker, name: meta.name, weeks },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
