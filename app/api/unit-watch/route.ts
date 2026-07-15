import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getUnitWatchProduct, computeUnitWatchRows } from '@/lib/unitWatch';

export const dynamic = 'force-dynamic';

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase credentials not configured');
  return createClient(url, key);
}

export async function GET(request: NextRequest) {
  const ticker = request.nextUrl.searchParams.get('ticker') ?? '00986D';
  const product = getUnitWatchProduct(ticker);
  if (!product) {
    return NextResponse.json({ error: `未設定監測商品：${ticker}` }, { status: 400 });
  }

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('unit_watch')
      .select('date, units')
      .eq('ticker', product.ticker)
      .gte('date', product.listingDate)
      .order('date', { ascending: true });

    if (error) throw new Error(error.message);

    const days = (data ?? []).map(r => ({ date: (r.date as string).slice(0, 10), units: Number(r.units) }));
    const rows = computeUnitWatchRows(product, days);

    return NextResponse.json(
      { product, rows },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
