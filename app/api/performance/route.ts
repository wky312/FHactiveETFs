import { NextRequest, NextResponse } from 'next/server';
import { fetchHoldings } from '@/lib/fhtrust';
import { resolveYfTicker } from '@/lib/exchangeMap';
import { fetchStockPerformance, StockPerformance } from '@/lib/yahooFinance';
import { fetchTwseLive } from '@/lib/twseLive';

// 純數字代碼＝台股（上市或上櫃），才查得到 MIS 即時報價；美股/其他海外標的的 stockid 帶國別後綴（如 'PLTR US'）
const isTwCode = (id: string): boolean => /^\d+$/.test(id);

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

    // 批量查台股標的的 MIS 即時報價，交叉驗證 Yahoo 現價/昨收（見 lib/twseLive.ts）。
    // 0050 基準列也是台股代碼，一併查（見下方 TW_BENCHES）。
    const twCodes = stocks.map(h => h.stockid).filter(isTwCode);
    if (isTwOnly) twCodes.push('0050');
    const twseLiveMap = await fetchTwseLive(twCodes);

    const results: StockPerformance[] = await batchAll(stocks, h => {
      const { yfTicker: raw, fallback } = resolveYfTicker(h.stockid, isTwOnly);
      const yfTicker = TICKER_OVERRIDES[raw] ?? raw;
      return fetchStockPerformance(
        h.stockid, h.stockname, h.prate_addaccint, yfTicker, fallback, customStart, customEnd,
        undefined, twseLiveMap.get(h.stockid),
      );
    });

    /* 基準列：供使用者一眼看出個股/整體相對強弱。台股基金拿 0050(含息) 與加權指數比，
       海外基金拿美股四大指數比——00998A/00409A 的成分幾乎全是美股與其他海外股，
       拿台股大盤當基準沒有參考意義。
       四大指數用各自的價格指數：^DJI/^SOX 在 Yahoo 沒有含息版，若只把 S&P500 換成
       ^SP500TR 會讓四條基準口徑不一致，反而更難解讀。 */
    const TW_BENCHES = [
      { stockid: '0050',  stockname: '元大台灣50', yf: '0050.TW' },
      { stockid: '^TWII', stockname: '加權指數',   yf: '^TWII'   },
    ];
    const US_BENCHES = [
      { stockid: '^DJI',  stockname: '道瓊工業指數', yf: '^DJI'  },
      { stockid: '^GSPC', stockname: '標普500',     yf: '^GSPC' },
      { stockid: '^IXIC', stockname: '那斯達克',     yf: '^IXIC' },
      { stockid: '^SOX',  stockname: '費城半導體',   yf: '^SOX'  },
    ];
    const benchmarks: StockPerformance[] = await Promise.all(
      (isTwOnly ? TW_BENCHES : US_BENCHES)
        .map(b => fetchStockPerformance(
          b.stockid, b.stockname, 0, b.yf, undefined, customStart, customEnd,
          undefined, twseLiveMap.get(b.stockid),
        )),
    );

    return NextResponse.json(
      { date: holdDate, results, benchmarks },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
