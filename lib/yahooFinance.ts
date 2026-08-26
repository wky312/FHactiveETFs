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
  priceAsOf: string | null;   // regularMarketTime ISO string
  today: number | null;
  d3: number | null;
  d5: number | null;
  m1: number | null;
  m3: number | null;
  ytd: number | null;
  ytdBasePrice: number | null; // 去年12/31還原權息收盤價（ytd 的分母，供需要顯示還原價的頁面用）
  pctCustom: number | null;
  customStartPrice: number | null; // customStart 當天還原權息收盤價（穩定值，非即時報價；customStart/customEnd 都帶時才有）
  customEndPrice: number | null;   // customEnd 當天還原權息收盤價
  priorHigh: number | null;       // 比較基準日（預設今年1/1，可由 highSince 覆寫）「以前」的最高價（前高）
  priorHighDate: string | null;   // 前高日期 YYYY-MM-DD
  postHigh: number | null;        // 比較基準日「以後」至今的最高價
  postHighDate: string | null;    // 創高日期 YYYY-MM-DD（postHigh 對應日期）
  isNewHigh: boolean;             // 是否突破：postHigh 是否高於 priorHigh
  distFromHighPct: number | null; // 現價距「應比較的高點」百分比（已突破比 postHigh、未突破比 priorHigh；0＝正好在高點）
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

interface QuoteResult {
  price: number | null;
  prevClose: number | null;
  priceAsOf: string | null;  // regularMarketTime ISO string
}

async function tryQuote(ticker: string): Promise<QuoteResult | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = await yf.quote(ticker, {}, { validateResult: false });
    if (!q?.regularMarketPrice) return null;
    return {
      price:      q.regularMarketPrice,
      prevClose:  q.regularMarketPreviousClose ?? null,
      priceAsOf:  q.regularMarketTime ? new Date(q.regularMarketTime).toISOString() : null,
    };
  } catch {
    return null;
  }
}

async function tryFetch(ticker: string, from: Date, today: Date, interval: '1d' | '1wk' = '1d'): Promise<FetchResult | null> {
  try {
    // period2 is exclusive in Yahoo Finance API, so add 1 day to include today's bar
    const period2 = new Date(today);
    period2.setDate(period2.getDate() + 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await yf.chart(
      ticker,
      { period1: from, period2, interval },
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

export interface DailyBar {
  date: string;   // 台灣交易日 YYYY/MM/DD
  high: number;
  low: number;
  mid: number;    // (high + low) / 2
  close: number;
}

// 以台灣時區（UTC+8）推出該日 K 棒的日期字串
function twDateKey(d: Date): string {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}/${String(t.getUTCMonth() + 1).padStart(2, '0')}/${String(t.getUTCDate()).padStart(2, '0')}`;
}

// 抓某檔股票區間內的每日最高/最低價，回傳依日期排序的 K 棒（含中間價）
export async function fetchDailyBars(
  yfTicker: string,
  from: Date,
  to: Date,
  fallbackTicker?: string,
): Promise<DailyBar[]> {
  let data = await tryFetch(yfTicker, from, to);
  if (!data && fallbackTicker) data = await tryFetch(fallbackTicker, from, to);
  if (!data) return [];

  const bars: DailyBar[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const q of data.quotes as any[]) {
    const high  = q.high ?? q.close;
    const low   = q.low ?? q.close;
    const close = q.close;
    if (close == null) continue;
    const h = high ?? close;
    const l = low ?? close;
    bars.push({ date: twDateKey(new Date(q.date)), high: h, low: l, mid: (h + l) / 2, close });
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  return bars;
}

export interface CloseBar {
  date: string;    // 台灣時區日期字串 YYYY/MM/DD（該根 K 棒的時間戳換算）
  close: number;   // 還原權息收盤（adjClose，見 adj()）
}

/* 抓某檔標的區間內的還原收盤序列，供族群相對強度(RRG)用——interval 可選日線/週線。
   primary 失敗才試 fallback（同 fetchDailyBars）。 */
export async function fetchAdjCloseSeries(
  yfTicker: string,
  from: Date,
  to: Date,
  interval: '1d' | '1wk',
  fallbackTicker?: string,
): Promise<CloseBar[]> {
  let data = await tryFetch(yfTicker, from, to, interval);
  if (!data && fallbackTicker) data = await tryFetch(fallbackTicker, from, to, interval);
  if (!data) return [];

  const bars: CloseBar[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const q of data.quotes as any[]) {
    const close = adj(q);
    if (close == null) continue;
    bars.push({ date: twDateKey(new Date(q.date)), close });
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  return bars;
}

export async function fetchStockPerformance(
  stockid: string,
  stockname: string,
  prate: number,
  yfTicker: string,
  fallbackTicker?: string,
  customStart?: Date,
  customEnd?: Date,
  highSince?: Date, // 「前高 vs 突破後新高」比較基準日；不帶時沿用 ytdTarget（今年1/1）
): Promise<StockPerformance> {
  try {
    const today   = new Date();
    const baseFrom = new Date(today.getFullYear() - 1, 0, 1);
    let from = baseFrom;
    if (customStart && customStart < from) from = new Date(customStart.getTime() - 7 * 86400 * 1000);
    if (highSince && highSince < from)     from = new Date(highSince.getTime() - 7 * 86400 * 1000);

    // Fetch quote and chart in parallel; quote is more reliable for today's price
    let [quote, data] = await Promise.all([
      tryQuote(yfTicker),
      tryFetch(yfTicker, from, today),
    ]);
    let usedTicker = yfTicker;

    if (!data && fallbackTicker) {
      const [fbQuote, fbData] = await Promise.all([
        !quote ? tryQuote(fallbackTicker) : Promise.resolve(null),
        tryFetch(fallbackTicker, from, today),
      ]);
      if (fbData) { data = fbData; usedTicker = fallbackTicker; }
      if (!quote && fbQuote) quote = fbQuote;
    }

    if (!data) throw new Error('no data');

    const sorted = [...data.quotes].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    const m1Target  = new Date(today); m1Target.setMonth(m1Target.getMonth() - 1);
    const m3Target  = new Date(today); m3Target.setMonth(m3Target.getMonth() - 3);
    const ytdTarget = new Date(today.getFullYear() - 1, 11, 31);

    const todayDn = dn(new Date());
    const marketClosedToday = sorted.length > 0 && dn(sorted[0].date) === todayDn;

    // Priority: yf.quote() → chart regularMarketPrice → today's chart close
    const curPrice  = quote?.price
      ?? data.regularMarketPrice
      ?? (marketClosedToday ? sorted[0]?.close ?? null : null);
    // Priority: yf.quote() prevClose → chart prev close row
    const prevClose = quote?.prevClose
      ?? (marketClosedToday ? sorted[1]?.close : sorted[0]?.close);

    let pctCustom: number | null = null;
    let customStartPrice: number | null = null;
    let customEndPrice: number | null = null;
    if (customStart && customEnd) {
      const startDn = dn(customStart);
      const endDn   = dn(customEnd);
      // sorted is descending; find last row <= target date
      const startRow = sorted.find((d: any) => dn(d.date) <= startDn);
      const endRow   = sorted.find((d: any) => dn(d.date) <= endDn);
      customStartPrice = adj(startRow) ?? null;
      customEndPrice   = adj(endRow) ?? null;
      pctCustom = pct(adj(endRow), adj(startRow));
    }

    // 前高（比較基準日以前）／創新高（比較基準日以後）：分別在 sorted 中找 adj() 最大值與對應日期。
    const highBoundary = highSince ?? ytdTarget;
    let priorHigh: number | null = null;
    let priorHighDate: string | null = null;
    let postHigh: number | null = null;
    let postHighDate: string | null = null;
    for (const row of sorted as any[]) {
      const v = adj(row);
      if (v == null) continue;
      if (dn(row.date) <= dn(highBoundary)) {
        if (priorHigh == null || v > priorHigh) {
          priorHigh = v;
          priorHighDate = new Date(row.date).toISOString().slice(0, 10);
        }
      } else {
        if (postHigh == null || v > postHigh) {
          postHigh = v;
          postHighDate = new Date(row.date).toISOString().slice(0, 10);
        }
      }
    }
    // 突破＝比較基準日以後的最高價，高於比較基準日以前的前高（沒有前高可比時，只要有 postHigh 就算突破）
    const isNewHigh = postHigh != null && (priorHigh == null || postHigh > priorHigh + 1e-6);
    const referenceHigh = isNewHigh ? postHigh : priorHigh;
    const distFromHighPct = curPrice != null && referenceHigh != null && referenceHigh > 0
      ? Math.abs(pct(curPrice ?? undefined, referenceHigh ?? undefined) as number)
      : null;

    return {
      stockid,
      stockname,
      prate,
      ticker: usedTicker,
      currentPrice: curPrice,
      priceAsOf: quote?.priceAsOf ?? null,
      today: pct(curPrice ?? undefined, prevClose ?? undefined),
      d3:    pct(adj(sorted[0]), adj(sorted[3])),
      d5:    pct(adj(sorted[0]), adj(sorted[5])),
      m1:    pct(adj(sorted[0]), adj(sorted.find((d: any) => dn(d.date) <= dn(m1Target)))),
      m3:    pct(adj(sorted[0]), adj(sorted.find((d: any) => dn(d.date) <= dn(m3Target)))),
      ytd:   pct(adj(sorted[0]), adj(sorted.find((d: any) => dn(d.date) <= dn(ytdTarget)))),
      ytdBasePrice: adj(sorted.find((d: any) => dn(d.date) <= dn(ytdTarget))) ?? null,
      pctCustom,
      customStartPrice,
      customEndPrice,
      priorHigh,
      priorHighDate,
      postHigh,
      postHighDate,
      isNewHigh,
      distFromHighPct,
    };
  } catch {
    return {
      stockid, stockname, prate, ticker: yfTicker,
      currentPrice: null, priceAsOf: null,
      today: null, d3: null, d5: null, m1: null, m3: null, ytd: null, ytdBasePrice: null,
      pctCustom: null, customStartPrice: null, customEndPrice: null,
      priorHigh: null, priorHighDate: null, postHigh: null, postHighDate: null,
      isNewHigh: false, distFromHighPct: null,
    };
  }
}
