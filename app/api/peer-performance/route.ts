import { NextResponse } from 'next/server';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const YahooFinance = require('yahoo-finance2').default;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yf: any = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

export const dynamic = 'force-dynamic';

// 同業績效觀測標的（顯示名稱、Yahoo Finance ticker）
export const PEER_PERF_LIST = [
  { ticker: '00981A', yfTicker: '00981A.TW', name: '統一台灣科技百強' },
  { ticker: '00982A', yfTicker: '00982A.TW', name: '群益台灣精選強棒' },
  { ticker: '00984A', yfTicker: '00984A.TW', name: '安聯台灣智慧' },
  { ticker: '00985A', yfTicker: '00985A.TW', name: '野村台灣價值' },
  { ticker: '00987A', yfTicker: '00987A.TW', name: '台新台灣精選' },
  { ticker: '00991A', yfTicker: '00991A.TW', name: '復華主動式ETF' },
  { ticker: '00992A', yfTicker: '00992A.TW', name: '群益科技創新' },
  { ticker: '00993A', yfTicker: '00993A.TW', name: '安聯台灣多利' },
  { ticker: '00994A', yfTicker: '00994A.TW', name: '第一金主動式' },
  { ticker: '00995A', yfTicker: '00995A.TW', name: '中信台灣科技' },
  { ticker: '00400A', yfTicker: '00400A.TW', name: '國泰台灣高息' },
  { ticker: '00401A', yfTicker: '00401A.TW', name: '摩根台灣主動' },
  { ticker: '00403A', yfTicker: '00403A.TW', name: '統一均衡成長' },
  { ticker: '0050',   yfTicker: '0050.TW',   name: '元大台灣50' },
];

export interface PeerPerfResult {
  ticker: string;
  yfTicker: string;
  name: string;
  price: number | null;
  pct1d:  number | null; // 當日
  pctWTD: number | null; // 週初至今
  pctMTD: number | null; // 月初至今
  pctYTD: number | null; // 年初至今
  pct5d:  number | null; // 近5日
  pct1m:  number | null; // 近1月
  pct3m:  number | null; // 近3月
  pct6m:  number | null; // 近6月
  pct1y:  number | null; // 近一年
  updatedAt: string | null;
}

interface DayRow { date: Date; adjClose: number }

function pct(curr: number | null | undefined, base: number | null | undefined): number | null {
  if (!curr || !base) return null;
  return (curr - base) / base * 100;
}

// Find latest row with date strictly before cutoff
function findBefore(rows: DayRow[], cutoff: Date): number | null {
  const t = cutoff.getTime();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].date.getTime() < t) return rows[i].adjClose;
  }
  return null;
}

function daysAgo(n: number): Date {
  const d = new Date(); d.setDate(d.getDate() - n); d.setHours(23, 59, 59, 999); return d;
}
function prevWeekEnd(): Date {
  // Last Sunday midnight = end of previous week
  const d = new Date(); d.setDate(d.getDate() - d.getDay()); d.setHours(23, 59, 59, 999); return d;
}
function prevMonthEnd(): Date {
  const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 0, 23, 59, 59, 999);
}
function prevYearEnd(): Date {
  return new Date(new Date().getFullYear() - 1, 11, 31, 23, 59, 59, 999);
}

async function fetchOne(item: typeof PEER_PERF_LIST[0]): Promise<PeerPerfResult> {
  const base: PeerPerfResult = {
    ...item, price: null,
    pct1d: null, pctWTD: null, pctMTD: null, pctYTD: null,
    pct5d: null, pct1m: null, pct3m: null, pct6m: null, pct1y: null,
    updatedAt: null,
  };
  try {
    const today = new Date();
    const from  = new Date(today.getFullYear() - 1, today.getMonth() - 2, today.getDate());
    const period2 = new Date(today); period2.setDate(period2.getDate() + 1);

    const [quote, chart] = await Promise.all([
      yf.quote(item.yfTicker, {}, { validateResult: false }).catch(() => null),
      yf.chart(item.yfTicker, { period1: from, period2, interval: '1d' }, { validateResult: false }).catch(() => null),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawQuotes: any[] = chart?.quotes ?? [];
    const rows: DayRow[] = rawQuotes
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((q: any) => (q.adjClose ?? q.adjclose) != null)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((q: any) => ({ date: new Date(q.date), adjClose: q.adjClose ?? q.adjclose }))
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    if (!rows.length) return base;

    const cur = rows[rows.length - 1].adjClose;

    // 當日: prefer Yahoo's regularMarketChangePercent (includes live price)
    const pct1d = quote?.regularMarketChangePercent != null
      ? quote.regularMarketChangePercent
      : pct(cur, rows.length >= 2 ? rows[rows.length - 2].adjClose : null);

    return {
      ...item,
      price:   quote?.regularMarketPrice ?? cur,
      pct1d,
      pctWTD:  pct(cur, findBefore(rows, prevWeekEnd())),
      pctMTD:  pct(cur, findBefore(rows, prevMonthEnd())),
      pctYTD:  pct(cur, findBefore(rows, prevYearEnd())),
      pct5d:   rows.length >= 6  ? pct(cur, rows[rows.length - 6].adjClose)  : null,
      pct1m:   pct(cur, findBefore(rows, daysAgo(30))),
      pct3m:   pct(cur, findBefore(rows, daysAgo(91))),
      pct6m:   pct(cur, findBefore(rows, daysAgo(182))),
      pct1y:   pct(cur, findBefore(rows, daysAgo(365))),
      updatedAt: quote?.regularMarketTime
        ? new Date(quote.regularMarketTime).toISOString()
        : null,
    };
  } catch {
    return base;
  }
}

export async function GET() {
  const BATCH = 4;
  const results: PeerPerfResult[] = [];
  for (let i = 0; i < PEER_PERF_LIST.length; i += BATCH) {
    const batch = await Promise.all(PEER_PERF_LIST.slice(i, i + BATCH).map(fetchOne));
    results.push(...batch);
  }
  return NextResponse.json(results, { headers: { 'Cache-Control': 'no-store' } });
}
