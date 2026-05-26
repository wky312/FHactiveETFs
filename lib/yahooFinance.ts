// eslint-disable-next-line @typescript-eslint/no-require-imports
const YahooFinance = require('yahoo-finance2').default;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yf: any = new YahooFinance({ suppressNotices: ['ripHistorical'] });

export interface StockPerformance {
  stockid: string;
  stockname: string;
  prate: number;
  ticker: string;
  currentPrice: number | null;
  today: number | null;
  d3: number | null;
  d5: number | null;
  m1: number | null;
  m3: number | null;
  ytd: number | null;
}

function dn(d: Date): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adj(row: any): number | undefined {
  return row?.adjClose ?? row?.adjclose ?? row?.close ?? undefined;
}

function pct(curr: number | undefined, base: number | undefined): number | null {
  if (!curr || !base) return null;
  return (curr - base) / base * 100;
}

interface FetchResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  quotes: any[];
  regularMarketPrice: number | null;
}

async function tryFetch(ticker: string, from: Date, today: Date): Promise<FetchResult | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await yf.chart(
      ticker,
      { period1: from, period2: today, interval: '1d' },
      { validateResult: false }
    );
    const rawQuotes = result?.quotes ?? result;
    if (!Array.isArray(rawQuotes) || !rawQuotes.length) return null;
    // Filter rows with null close (incomplete current session)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const quotes = rawQuotes.filter((q: any) => q.close != null);
    if (!quotes.length) return null;

    return {
      quotes,
      // regularMarketPrice: intraday during regular session, last close otherwise — no extended hours
      regularMarketPrice: result?.meta?.regularMarketPrice ?? null,
    };
  } catch {
    return null;
  }
}

export async function fetchStockPerformance(
  stockid: string,
  stockname: string,
  prate: number,
  yfTicker: string,
  fallbackTicker?: string
): Promise<StockPerformance> {
  try {
    const today = new Date();
    const from  = new Date(today.getFullYear() - 1, 0, 1);

    let data = await tryFetch(yfTicker, from, today);
    let usedTicker = yfTicker;

    if (!data && fallbackTicker) {
      data = await tryFetch(fallbackTicker, from, today);
      if (data) usedTicker = fallbackTicker;
    }

    if (!data) throw new Error('no data');

    const sorted = [...data.quotes].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    const m1Target  = new Date(today); m1Target.setMonth(m1Target.getMonth() - 1);
    const m3Target  = new Date(today); m3Target.setMonth(m3Target.getMonth() - 3);
    const ytdTarget = new Date(today.getFullYear() - 1, 11, 31);

    // Determine whether today's session is already in the chart data
    // (close != null rows only, sorted newest-first)
    const todayDn = dn(new Date());
    const marketClosedToday = sorted.length > 0 && dn(sorted[0].date) === todayDn;

    // today%: current price vs previous trading day's close (unadjusted)
    // If market closed today → sorted[0]=today close, sorted[1]=prev close
    // If market still open  → sorted[0]=prev close (today filtered), regularMarketPrice=intraday
    const curPrice  = data.regularMarketPrice;
    const prevClose = marketClosedToday ? sorted[1]?.close : sorted[0]?.close;

    return {
      stockid,
      stockname,
      prate,
      ticker: usedTicker,
      currentPrice: curPrice,
      today: pct(curPrice ?? undefined, prevClose ?? undefined),
      d3:    pct(adj(sorted[0]), adj(sorted[3])),
      d5:    pct(adj(sorted[0]), adj(sorted[5])),
      m1:    pct(adj(sorted[0]), adj(sorted.find((d: any) => dn(d.date) <= dn(m1Target)))),
      m3:    pct(adj(sorted[0]), adj(sorted.find((d: any) => dn(d.date) <= dn(m3Target)))),
      ytd:   pct(adj(sorted[0]), adj(sorted.find((d: any) => dn(d.date) <= dn(ytdTarget)))),
    };
  } catch {
    return {
      stockid, stockname, prate, ticker: yfTicker,
      currentPrice: null, today: null, d3: null, d5: null, m1: null, m3: null, ytd: null,
    };
  }
}
