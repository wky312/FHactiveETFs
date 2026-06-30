import { NextRequest, NextResponse } from 'next/server';
import { fetchHoldings } from '@/lib/fhtrust';
import { stockidToYfTicker } from '@/lib/exchangeMap';
import { fetchStockPerformance, StockPerformance } from '@/lib/yahooFinance';

const BATCH = 8;

// Bloomberg base ticker → Yahoo Finance ticker（改名或代碼不同時手動對應）
const TICKER_OVERRIDES: Record<string, string> = {
  'BNY':     'BK',      // BNY Mellon 改代號
  'OCBC.SI': 'O39.SI',  // 華僑銀行 SGX 數字代號
};

async function batchAll<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    out.push(...await Promise.all(items.slice(i, i + BATCH).map(fn)));
  }
  return out;
}

export async function GET(request: NextRequest) {
  const date       = request.nextUrl.searchParams.get('date');
  const fundId     = request.nextUrl.searchParams.get('fundId') ?? 'ETF23';
  const startStr   = request.nextUrl.searchParams.get('startDate');
  const endStr     = request.nextUrl.searchParams.get('endDate');
  if (!date) {
    return NextResponse.json({ error: '缺少 date 參數（格式：YYYY/MM/DD）' }, { status: 400 });
  }

  const customStart = startStr ? new Date(startStr + 'T00:00:00') : undefined;
  const customEnd   = endStr   ? new Date(endStr   + 'T23:59:59') : undefined;

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
      const yfTicker = TICKER_OVERRIDES[raw] ?? raw;
      const fallback = isTwOnly && !suffix ? `${base}.TWO` : undefined;
      return fetchStockPerformance(h.stockid, h.stockname, h.prate_addaccint, yfTicker, fallback, customStart, customEnd);
    });

    // 基準：0050(含息) 與 加權指數 ^TWII，供使用者一眼看出個股/整體相對強弱
    const benchmarks: StockPerformance[] = await Promise.all([
      { stockid: '0050',  stockname: '元大台灣50', yf: '0050.TW' },
      { stockid: '^TWII', stockname: '加權指數',   yf: '^TWII'   },
    ].map(b => fetchStockPerformance(b.stockid, b.stockname, 0, b.yf, undefined, customStart, customEnd)));

    return NextResponse.json(
      { date: holdDate, results, benchmarks },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
