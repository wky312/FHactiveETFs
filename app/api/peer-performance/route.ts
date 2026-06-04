import { NextRequest, NextResponse } from 'next/server';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const YahooFinance = require('yahoo-finance2').default;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yf: any = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

export const dynamic = 'force-dynamic';

export interface PeerItem {
  ticker: string;
  yfTicker: string;
  name: string;
}

// ── 群組定義 ──────────────────────────────────────────────────────────────────

export const PEER_GROUPS: Record<string, { label: string; items: PeerItem[] }> = {
  active: {
    label: '台股主動式ETF',
    items: [
      { ticker: '00981A', yfTicker: '00981A.TW', name: '主動統一台股增長' },
      { ticker: '00982A', yfTicker: '00982A.TW', name: '主動群益台灣強棒' },
      { ticker: '00984A', yfTicker: '00984A.TW', name: '主動安聯台灣高息' },
      { ticker: '00985A', yfTicker: '00985A.TW', name: '主動野村台灣50' },
      { ticker: '00987A', yfTicker: '00987A.TW', name: '主動台新優勢成長' },
      { ticker: '00991A', yfTicker: '00991A.TW', name: '主動復華未來50' },
      { ticker: '00992A', yfTicker: '00992A.TW', name: '主動群益科技創新' },
      { ticker: '00993A', yfTicker: '00993A.TW', name: '主動安聯台灣' },
      { ticker: '00994A', yfTicker: '00994A.TW', name: '主動第一金台股優' },
      { ticker: '00995A', yfTicker: '00995A.TW', name: '主動中信台灣卓越' },
      { ticker: '00996A', yfTicker: '00996A.TW', name: '主動兆豐台灣豐收' },
      { ticker: '00400A', yfTicker: '00400A.TW', name: '主動國泰動能高息' },
      { ticker: '00401A', yfTicker: '00401A.TW', name: '主動摩根台灣鑫收' },
      { ticker: '00403A', yfTicker: '00403A.TW', name: '主動統一升級50' },
      { ticker: '0050',   yfTicker: '0050.TW',   name: '元大台灣50' },
      { ticker: '^TWII',  yfTicker: '^TWII',     name: '台灣加權指數' },
      { ticker: '^TWOII', yfTicker: '^TWOII',    name: '台灣OTC指數' },
    ],
  },
  tw50: {
    label: '台股50',
    items: [
      { ticker: '00935',  yfTicker: '00935.TW',  name: '野村臺灣新科技50' },
      { ticker: '006201', yfTicker: '006201.TW', name: '元大富櫃50' },
      { ticker: '00991A', yfTicker: '00991A.TW', name: '主動復華未來50' },
      { ticker: '009802', yfTicker: '009802.TW', name: '富邦旗艦50' },
      { ticker: '009803', yfTicker: '009803.TW', name: '玉山市值動能50' },
      { ticker: '00923',  yfTicker: '00923.TW',  name: '群益台ESG低碳50' },
      { ticker: '009804', yfTicker: '009804.TW', name: '聯邦台精彩50' },
      { ticker: '00985A', yfTicker: '00985A.TW', name: '主動野村台灣50' },
      { ticker: '00952',  yfTicker: '00952.TW',  name: '凱基台灣AI50' },
      { ticker: '00922',  yfTicker: '00922.TW',  name: '國泰台灣領袖50' },
      { ticker: '0050',   yfTicker: '0050.TW',   name: '元大台灣50' },
      { ticker: '009809', yfTicker: '009809.TW', name: '富邦淨零ESG50' },
      { ticker: '006208', yfTicker: '006208.TW', name: '富邦台50' },
      { ticker: '009808', yfTicker: '009808.TW', name: '華南永昌優選50' },
      { ticker: '00912',  yfTicker: '00912.TW',  name: '中信臺灣智慧50' },
      { ticker: '009816', yfTicker: '009816.TW', name: '凱基台灣TOP50' },
      { ticker: '00403A', yfTicker: '00403A.TW', name: '主動統一升級50' },
      { ticker: '^TWII',  yfTicker: '^TWII',     name: '台灣加權指數' },
      { ticker: '^TWOII', yfTicker: '^TWOII',    name: '台灣OTC指數' },
    ],
  },
};

// ── Types & helpers ───────────────────────────────────────────────────────────

export interface PeerPerfResult extends PeerItem {
  price: number | null;
  pct1d:  number | null;
  pctWTD: number | null;
  pctMTD: number | null;
  pctYTD: number | null;
  pct5d:  number | null;
  pct1m:  number | null;
  pct3m:  number | null;
  pct6m:  number | null;
  pct1y:  number | null;
  updatedAt: string | null;
}

interface DayRow { date: Date; adjClose: number }

function pct(curr: number | null | undefined, base: number | null | undefined): number | null {
  if (curr == null || base == null || base === 0) return null;
  return (curr - base) / base * 100;
}

function findOnOrBefore(rows: DayRow[], cutoff: Date): number | null {
  const t = cutoff.getTime();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].date.getTime() <= t) return rows[i].adjClose;
  }
  return null;
}

function prevWeekEnd(): Date {
  const d = new Date();
  const day = d.getDay(); // 0=Sun
  d.setDate(d.getDate() - (day === 0 ? 7 : day));
  d.setHours(23, 59, 59, 999);
  return d;
}
function prevMonthEnd(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 0, 23, 59, 59, 999);
}
function prevYearEnd(): Date {
  return new Date(new Date().getFullYear() - 1, 11, 31, 23, 59, 59, 999);
}
function exactMonthsAgo(n: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  d.setHours(23, 59, 59, 999);
  return d;
}

// ── Fetch one ticker ──────────────────────────────────────────────────────────

async function fetchOne(item: PeerItem): Promise<PeerPerfResult> {
  const base: PeerPerfResult = {
    ...item, price: null,
    pct1d: null, pctWTD: null, pctMTD: null, pctYTD: null,
    pct5d: null, pct1m: null, pct3m: null, pct6m: null, pct1y: null,
    updatedAt: null,
  };
  try {
    const today   = new Date();
    const from    = new Date(today.getFullYear() - 1, today.getMonth() - 2, today.getDate());
    const period2 = new Date(today); period2.setDate(period2.getDate() + 1);

    const [quote, chart] = await Promise.all([
      yf.quote(item.yfTicker, {}, { validateResult: false }).catch(() => null),
      yf.chart(item.yfTicker, { period1: from, period2, interval: '1d' }, { validateResult: false }).catch(() => null),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawQuotes: any[] = chart?.quotes ?? [];
    const rows: DayRow[] = rawQuotes
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((q: any) => (q.adjClose ?? q.adjclose ?? q.close) != null)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((q: any) => ({ date: new Date(q.date), adjClose: q.adjClose ?? q.adjclose ?? q.close }))
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    if (!rows.length) return base;

    const cur = rows[rows.length - 1].adjClose;

    const pct1d = quote?.regularMarketChangePercent != null
      ? quote.regularMarketChangePercent
      : pct(cur, rows.length >= 2 ? rows[rows.length - 2].adjClose : null);

    return {
      ...item,
      price:   quote?.regularMarketPrice ?? cur,
      pct1d,
      pctWTD:  pct(cur, findOnOrBefore(rows, prevWeekEnd())),
      pctMTD:  pct(cur, findOnOrBefore(rows, prevMonthEnd())),
      pctYTD:  pct(cur, findOnOrBefore(rows, prevYearEnd())),
      pct5d:   rows.length >= 6 ? pct(cur, rows[rows.length - 6].adjClose) : null,
      pct1m:   pct(cur, findOnOrBefore(rows, exactMonthsAgo(1))),
      pct3m:   pct(cur, findOnOrBefore(rows, exactMonthsAgo(3))),
      pct6m:   pct(cur, findOnOrBefore(rows, exactMonthsAgo(6))),
      pct1y:   pct(cur, findOnOrBefore(rows, exactMonthsAgo(12))),
      updatedAt: quote?.regularMarketTime
        ? new Date(quote.regularMarketTime).toISOString()
        : null,
    };
  } catch {
    return base;
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const groupId = request.nextUrl.searchParams.get('group') ?? 'active';
  const group   = PEER_GROUPS[groupId] ?? PEER_GROUPS['active'];

  const BATCH = 4;
  const results: PeerPerfResult[] = [];
  for (let i = 0; i < group.items.length; i += BATCH) {
    const batch = await Promise.all(group.items.slice(i, i + BATCH).map(fetchOne));
    results.push(...batch);
  }
  return NextResponse.json(results, { headers: { 'Cache-Control': 'no-store' } });
}
