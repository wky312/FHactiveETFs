import { NextRequest, NextResponse } from 'next/server';
import { fetchHoldings } from '@/lib/fhtrust';
import { stockidToYfTicker } from '@/lib/exchangeMap';
import { fetchStockPerformance, StockPerformance } from '@/lib/yahooFinance';

// 「創新高強勢股」：持股清單頁的頁內模式，重用 fetchStockPerformance() 已算好的
// YTD 還原權息報酬 + 今年最高價/創高判斷，不另建一套抓取或口徑。
// 目前僅 00991A（fundId ETF23）啟用，前端把關；此路由本身沿用 /api/performance
// 的 fund-agnostic 寫法（不多加限制）。

const BATCH = 8;

async function batchAll<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    out.push(...await Promise.all(items.slice(i, i + BATCH).map(fn)));
  }
  return out;
}

export async function GET(request: NextRequest) {
  const date      = request.nextUrl.searchParams.get('date');
  const fundId    = request.nextUrl.searchParams.get('fundId') ?? 'ETF23';
  const sinceStr  = request.nextUrl.searchParams.get('sinceDate'); // YYYY-MM-DD，「期間最高價」比較基準日
  if (!date) {
    return NextResponse.json({ error: '缺少 date 參數（格式：YYYY/MM/DD）' }, { status: 400 });
  }
  const highSince = sinceStr ? new Date(sinceStr + 'T00:00:00') : undefined;

  try {
    const { holdings, date: holdDate } = await fetchHoldings(date, fundId);

    const stocks = holdings.filter(
      h => h.stockid.trim() && h.ftype !== '期貨' && h.ftype !== '現金' && h.ftype !== '其他資產'
    );

    const isTwOnly = fundId === 'ETF23';

    const results: StockPerformance[] = await batchAll(stocks, h => {
      const { ticker, suffix } = stockidToYfTicker(h.stockid);
      const base     = h.stockid.trim();
      const raw      = isTwOnly && !suffix ? `${base}.TW`  : (ticker || base);
      const yfTicker = raw;
      const fallback = isTwOnly && !suffix ? `${base}.TWO` : undefined;
      return fetchStockPerformance(h.stockid, h.stockname, h.prate_addaccint, yfTicker, fallback, undefined, undefined, highSince);
    });

    return NextResponse.json(
      { date: holdDate, results },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
