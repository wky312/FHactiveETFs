import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const YahooFinance = require('yahoo-finance2').default;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yf: any = new YahooFinance({ suppressNotices: ['ripHistorical'] });

export async function GET() {
  const ticker = '2330.TW';
  const today  = new Date();
  const period2 = new Date(today); period2.setDate(period2.getDate() + 1);
  const from   = new Date(today); from.setDate(from.getDate() - 5);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [quote, chart]: [any, any] = await Promise.all([
    yf.quote(ticker, {}, { validateResult: false }).catch(() => null),
    yf.chart(ticker, { period1: from, period2, interval: '1d' }, { validateResult: false }).catch(() => null),
  ]);

  const quotes = (chart?.quotes ?? []).filter((q: any) => q.close != null);

  return NextResponse.json({
    serverUtcNow: today.toISOString(),
    quote: {
      regularMarketPrice:         quote?.regularMarketPrice,
      regularMarketPreviousClose: quote?.regularMarketPreviousClose,
      regularMarketTime:          quote?.regularMarketTime,
    },
    chartMeta: {
      regularMarketPrice: chart?.meta?.regularMarketPrice,
    },
    latestBars: quotes.slice(-3).map((q: any) => ({
      date:  q.date,
      close: q.close,
    })),
  });
}
