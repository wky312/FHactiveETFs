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
      { ticker: '00980A', yfTicker: '00980A.TW', name: '主動野村台灣優選' },
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
      { ticker: '00999A', yfTicker: '00999A.TW', name: '主動野村台灣高息' },
      { ticker: '00400A', yfTicker: '00400A.TW', name: '主動國泰動能高息' },
      { ticker: '00401A', yfTicker: '00401A.TW', name: '主動摩根台灣鑫收' },
      { ticker: '00403A', yfTicker: '00403A.TW', name: '主動統一升級50' },
      { ticker: '00405A', yfTicker: '00405A.TW', name: '主動富邦台灣龍耀' },
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
  pctCustom: number | null;
  updatedAt: string | null;
  dataDate: string | null;  // YYYY-MM-DD date of the 'cur' price used for all metrics
  anomaly: boolean;            // Yahoo 報價疑似破值/缺價，績效不可信
  anomalyReason: string | null;
}

interface DayRow { date: Date; adjClose: number; close: number }

// 還原價格先四捨五入到小數 2 位，再相除 —— 對齊券商軟體的「先進位」算法
const round2 = (x: number): number => Math.round(x * 100) / 100;

function pct(curr: number | null | undefined, base: number | null | undefined): number | null {
  if (curr == null || base == null || base === 0) return null;
  const c = round2(curr);
  const b = round2(base);
  if (b === 0) return null;
  return (c - b) / b * 100;
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

// ── TWSE listing date lookup ──────────────────────────────────────────────────

const listingDateCache = new Map<string, Date | null>();

async function fetchListingDate(yfTicker: string): Promise<Date | null> {
  if (yfTicker.startsWith('^')) return null; // indices have no listing date
  const code = yfTicker.replace('.TW', '');
  if (listingDateCache.has(code)) return listingDateCache.get(code)!;
  try {
    const res = await fetch(`https://isin.twse.com.tw/isin/single_main.jsp?owncode=${code}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const html = await res.text();
    const m = html.match(/(\d{4})\/(\d{2})\/(\d{2})/);
    const date = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
    listingDateCache.set(code, date);
    return date;
  } catch {
    listingDateCache.set(code, null);
    return null;
  }
}

// ── TWSE 即時報價（MIS）：取各檔「已成交的最新交易日」，作為偵測 Yahoo 破值/缺價的真相來源 ──
// 一次批量查詢全部上市標的；只有當盤中有實際成交價(z 為數字)時，才把該日 d 視為「已成交交易日」，
// 這樣放假日(z='-') 不會被誤判成 Yahoo 落後。index(^) 不在 MIS，略過。
async function fetchTwseLatestTraded(items: PeerItem[]): Promise<Map<string, string>> {
  const map = new Map<string, string>(); // ticker -> 'YYYY-MM-DD'
  const codes = items.filter(i => !i.yfTicker.startsWith('^')).map(i => i.ticker);
  if (!codes.length) return map;
  try {
    const ex = codes.map(c => `tse_${c}.tw`).join('|');
    const res = await fetch(
      `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(ex)}&json=1&delay=0`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://mis.twse.com.tw/stock/index.jsp' } },
    );
    const data = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const x of (data?.msgArray ?? []) as any[]) {
      const z = parseFloat(x.z);              // 當前成交價（'-' → NaN）
      const d: string = x.d ?? '';            // 交易日 'YYYYMMDD'
      if (!Number.isNaN(z) && /^\d{8}$/.test(d)) {
        map.set(x.c, `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
      }
    }
  } catch {
    // TWSE 查詢失敗就不做日期比對，避免誤報異常
  }
  return map;
}

// Taiwan market closes at 13:30 UTC+8 = 05:30 UTC on weekdays
function taiwanMarketClosed(): boolean {
  const now = new Date();
  const tw  = new Date(now.getTime() + 8 * 3600 * 1000);
  const day = tw.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return true;
  const h = tw.getUTCHours(), m = tw.getUTCMinutes();
  return h > 13 || (h === 13 && m >= 30);
}

// ── Fetch one ticker ──────────────────────────────────────────────────────────

interface CustomRange { start: Date; end: Date }

async function fetchOne(item: PeerItem, customRange?: CustomRange): Promise<PeerPerfResult> {
  const base: PeerPerfResult = {
    ...item, price: null,
    pct1d: null, pctWTD: null, pctMTD: null, pctYTD: null,
    pct5d: null, pct1m: null, pct3m: null, pct6m: null, pct1y: null,
    pctCustom: null,
    updatedAt: null, dataDate: null,
    anomaly: false, anomalyReason: null,
  };
  try {
    const today    = new Date();
    const baseFrom = new Date(today.getFullYear() - 1, today.getMonth() - 2, today.getDate());
    const from     = customRange && customRange.start < baseFrom
      ? new Date(customRange.start.getTime() - 7 * 86400 * 1000)
      : baseFrom;
    const period2 = new Date(today); period2.setDate(period2.getDate() + 1);

    const [quote, chart, listingDate] = await Promise.all([
      yf.quote(item.yfTicker, {}, { validateResult: false }).catch(() => null),
      yf.chart(item.yfTicker, { period1: from, period2, interval: '1d' }, { validateResult: false }).catch(() => null),
      fetchListingDate(item.yfTicker),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawQuotes: any[] = chart?.quotes ?? [];
    const marketClosed = taiwanMarketClosed();
    const todayStr = new Date().toISOString().split('T')[0];

    const rows: DayRow[] = rawQuotes
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((q: any) => (q.adjClose ?? q.adjclose ?? q.close) != null)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((q: any) => ({
        date: new Date(q.date),
        adjClose: q.adjClose ?? q.adjclose ?? q.close,
        close: q.close ?? q.adjClose ?? q.adjclose,   // 保留原始收盤價，供下方還原基準換算
      }))
      // Exclude today's intraday data when market hasn't closed yet
      .filter(r => marketClosed || r.date.toISOString().split('T')[0] < todayStr)
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    if (!rows.length) return base;

    // Use TWSE listing date to gate metrics; fall back to first chart row if unavailable
    const effectiveStart: Date = listingDate ?? rows[0].date;

    // Returns null if the ETF wasn't listed before cutoff; otherwise calculates pct
    const pctSince = (cutoff: Date): number | null =>
      effectiveStart > cutoff ? null : pct(cur, findOnOrBefore(rows, cutoff));

    // Append latest completed close when chart data lags:
    // - Market open today   → use regularMarketPreviousClose (prev session's close)
    //   with date = last weekday before today
    // - Market closed today → use regularMarketPrice (today's close) if newer than chart
    // - quoteTime is a prev day → use regularMarketPrice directly
    const lastRow = rows[rows.length - 1];
    const lastChartDate = lastRow.date;
    const quoteTime = quote?.regularMarketTime ? new Date(quote.regularMarketTime) : null;
    const quoteDate = quoteTime ? quoteTime.toISOString().split('T')[0] : null;

    // 最新交易日本身即為「還原基準日」，其還原係數 = 1，所以即時最新價可直接視為還原價。
    // 但若即時報價恰好等於最後一根 K 棒的「原始收盤價」，代表報價尚未更新到新交易日
    // —— 常見於除息日早盤：歷史價已還原、報價卻仍停在前一日。此時若併入，就會用「除息前原始價」
    // 去比「已還原基準」，把報酬灌高（曾出現 YTD 93.83% 的假數字）。故偵測到即略過，改用 K 棒還原價。
    const quoteStale = quote?.regularMarketPrice != null
      && round2(quote.regularMarketPrice) === round2(lastRow.close);

    if (quoteDate === todayStr && !marketClosed) {
      // Intraday: use previous session's close with last-weekday date
      if (quote?.regularMarketPreviousClose != null) {
        const prevDay = new Date();
        do { prevDay.setDate(prevDay.getDate() - 1); } while (prevDay.getDay() === 0 || prevDay.getDay() === 6);
        if (prevDay.getTime() > lastChartDate.getTime()) {
          rows.push({
            date: prevDay,
            adjClose: quote.regularMarketPreviousClose,
            close: quote.regularMarketPreviousClose,
          });
        }
      }
    } else if (quoteTime && quote?.regularMarketPrice != null
        && quoteTime.getTime() > lastChartDate.getTime() && !quoteStale) {
      // 收盤後：最新交易日即還原基準（係數=1），直接採用最新原始價
      rows.push({
        date: quoteTime,
        adjClose: quote.regularMarketPrice,
        close: quote.regularMarketPrice,
      });
    }

    const cur = rows[rows.length - 1].adjClose;

    const pct1d = quote?.regularMarketChangePercent != null
      ? quote.regularMarketChangePercent
      : pct(cur, rows.length >= 2 ? rows[rows.length - 2].adjClose : null);

    const pctCustom = customRange
      ? pct(findOnOrBefore(rows, customRange.end), findOnOrBefore(rows, customRange.start))
      : null;

    return {
      ...item,
      price:   quote?.regularMarketPrice ?? cur,
      pct1d,
      pctWTD:  pctSince(prevWeekEnd()),
      pctMTD:  pctSince(prevMonthEnd()),
      pctYTD:  pctSince(prevYearEnd()),
      pct5d:   rows.length >= 6 ? pct(cur, rows[rows.length - 6].adjClose) : null,
      pct1m:   pctSince(exactMonthsAgo(1)),
      pct3m:   pctSince(exactMonthsAgo(3)),
      pct6m:   pctSince(exactMonthsAgo(6)),
      pct1y:   pctSince(exactMonthsAgo(12)),
      pctCustom,
      updatedAt: quote?.regularMarketTime
        ? new Date(quote.regularMarketTime).toISOString()
        : null,
      dataDate: rows[rows.length - 1].date.toISOString().split('T')[0],
      anomaly: false, anomalyReason: null,   // 由 route handler 比對 TWSE 後填入
    };
  } catch {
    return base;
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const groupId     = request.nextUrl.searchParams.get('group') ?? 'active';
  const group       = PEER_GROUPS[groupId] ?? PEER_GROUPS['active'];
  const startStr    = request.nextUrl.searchParams.get('startDate');
  const endStr      = request.nextUrl.searchParams.get('endDate');
  // 兩端都用當日 23:59:59 當截止點：Yahoo 日 K 棒時間戳為 01:00Z（台股開盤），
  // 若起始日用 00:00:00 會落在「前一個交易日」，導致基準價抓錯（區間報酬被灌高）。
  // 以還原收盤計算，起始日的基準即為「起始日當天收盤」，與年初至今(去年底收盤)同口徑。
  const customRange: CustomRange | undefined = startStr && endStr ? {
    start: new Date(startStr + 'T23:59:59'),
    end:   new Date(endStr   + 'T23:59:59'),
  } : undefined;

  const BATCH = 4;
  const results: PeerPerfResult[] = [];
  // 同時抓 TWSE 即時，作為偵測 Yahoo 破值/缺價的真相來源
  const [, twseLatest] = await Promise.all([
    (async () => {
      for (let i = 0; i < group.items.length; i += BATCH) {
        const batch = await Promise.all(group.items.slice(i, i + BATCH).map(item => fetchOne(item, customRange)));
        results.push(...batch);
      }
    })(),
    fetchTwseLatestTraded(group.items),
  ]);

  // ── 數值異常判定 ──
  // 1) 完全無報價（price 為 null）
  // 2) 收盤後，Yahoo 採用的最新日期落後於 TWSE 已成交的最新交易日（代表 Yahoo 缺最新報價、
  //    findOnOrBefore 拿到舊價計算）。僅在收盤後比對，盤中 Yahoo 日線本就尚未更新，避免誤報。
  const closed = taiwanMarketClosed();
  for (const r of results) {
    if (r.price == null) {
      r.anomaly = true;
      r.anomalyReason = '無報價';
      continue;
    }
    if (closed) {
      const twseDate = twseLatest.get(r.ticker);
      if (twseDate && r.dataDate && r.dataDate < twseDate) {
        r.anomaly = true;
        r.anomalyReason = `Yahoo 缺最新報價（採用 ${r.dataDate}，TWSE 已有 ${twseDate}）`;
      }
    }
  }

  return NextResponse.json(results, { headers: { 'Cache-Control': 'no-store' } });
}
