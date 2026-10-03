import { NextRequest, NextResponse } from 'next/server';
import { fetchTpexIndexRows } from '@/lib/tpexIndex';
import { PEER_GROUPS, type PeerItem } from '@/lib/peerGroups';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const YahooFinance = require('yahoo-finance2').default;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yf: any = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

export const dynamic = 'force-dynamic';

export { PEER_GROUPS, type PeerItem };   // 維持原有 re-export，供其他模組沿用

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

// 台股標的（.TW / .TWO）才查得到 TWSE 上市日與 MIS 即時報價。美股 ETF／美股指數一律排除：
// 拿 'QQQ' 去問 isin 會在錯誤頁上比對到任意一個日期、被當成上市日，把所有區間報酬 gate 成 null；
// 塞進 MIS 的 ex_ch 也只是白白汙染批次查詢。
const isTwListed = (yfTicker: string): boolean => /\.TWO?$/.test(yfTicker);
const isIndexTicker = (item: PeerItem): boolean => item.yfTicker.startsWith('^');

// ── TWSE listing date lookup ──────────────────────────────────────────────────

const listingDateCache = new Map<string, Date | null>();

async function fetchListingDate(yfTicker: string): Promise<Date | null> {
  if (!isTwListed(yfTicker)) return null; // 指數與美股標的都沒有 TWSE 上市日
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
// 這樣放假日(z='-') 不會被誤判成 Yahoo 落後。指數與美股標的不在 MIS，略過。
// 同時帶回 MIS 的昨收(y)：Yahoo quote 的 regularMarketPreviousClose 偶爾是錯的
// （曾見 0050 回 102、實際 109.85 → 單日漲幅假顯示 9%），以 y 作為昨收的真相來源交叉驗證。
// date=MIS 交易日；traded=該日是否已有成交價(z 為數字)。z='-'（放假/剛開盤/收盤試撮）時 y 仍有效，故仍保留。
interface TwseLive { date: string; traded: boolean; prevClose: number | null }

async function fetchTwseLatestTraded(items: PeerItem[]): Promise<Map<string, TwseLive>> {
  const map = new Map<string, TwseLive>(); // ticker -> {date 'YYYY-MM-DD', prevClose}
  const codes = items.filter(i => isTwListed(i.yfTicker)).map(i => i.ticker);
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
      const y = parseFloat(x.y);              // 昨收
      const d: string = x.d ?? '';            // 交易日 'YYYYMMDD'
      if (/^\d{8}$/.test(d) && (!Number.isNaN(z) || !Number.isNaN(y))) {
        map.set(x.c, {
          date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
          traded: !Number.isNaN(z),
          prevClose: Number.isNaN(y) ? null : y,
        });
      }
    }
  } catch {
    // TWSE 查詢失敗就不做日期比對，避免誤報異常
  }
  return map;
}

// ── TWSE 指數即時（MIS）：加權/櫃買指數的真相來源 ──
// Yahoo 的 ^TWII/^TWOII 有兩個坑：即時報價常是殭屍值（^TWOII 曾回 269.45、時間戳停在 2024），
// 且日 K 會停更數日（曾停在 7/3、之後 close 皆 null）。這會讓程式退回用過時的最後一根 K 棒當現價，
// 使指數績效嚴重失真（例：櫃買 MTD 假顯示 +4.3%，實際 −2%）。故指數改用 MIS 的 t00/o00 即時值為準。
const INDEX_MIS_CH: Record<string, string> = {
  '^TWII':  'tse_t00.tw',   // 發行量加權股價指數（TAIEX）
  '^TWOII': 'otc_o00.tw',   // 櫃買指數（TPEx / OTC）
};

interface IdxQuote { date: string; value: number; prevClose: number | null }

async function fetchTwseIndices(items: PeerItem[]): Promise<Map<string, IdxQuote>> {
  const map = new Map<string, IdxQuote>(); // yfTicker -> {date,value,prevClose}
  const idxItems = items.filter(i => INDEX_MIS_CH[i.yfTicker]);
  if (!idxItems.length) return map;
  // MIS 回傳的 x.ch 去掉 tse_/otc_ 前綴（如 't00.tw'），用來對回 yfTicker
  const chToYf = new Map<string, string>();
  for (const i of idxItems) chToYf.set(INDEX_MIS_CH[i.yfTicker].replace(/^(tse|otc)_/, ''), i.yfTicker);
  try {
    const ex = idxItems.map(i => INDEX_MIS_CH[i.yfTicker]).join('|');
    const res = await fetch(
      `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(ex)}&json=1&delay=0`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://mis.twse.com.tw/stock/index.jsp' } },
    );
    const data = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const x of (data?.msgArray ?? []) as any[]) {
      const yf = chToYf.get(x.ch ?? '');
      if (!yf) continue;
      const z = parseFloat(x.z);              // 當前/最新指數值（'-' → NaN，如放假）
      const y = parseFloat(x.y);              // 昨收
      const d: string = x.d ?? '';            // 交易日 'YYYYMMDD'
      if (!Number.isNaN(z) && /^\d{8}$/.test(d)) {
        map.set(yf, {
          date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
          value: z,
          prevClose: Number.isNaN(y) ? null : y,
        });
      }
    }
  } catch {
    // MIS 查詢失敗就沿用 Yahoo 資料（下方 anomaly 會標記落後）
  }
  return map;
}

// 歷史序列不走 Yahoo 的指數（Yahoo 已下架 ^TWOII，見 lib/tpexIndex.ts）
const TPEX_INDEX_TICKERS = new Set(['^TWOII']);

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

// Yahoo 的 1 日漲跌幅與 MIS 昨收算出的值差超過此百分點，視為 Yahoo 昨收壞掉。
// 除息日 Yahoo 與 MIS 的基準可能差一個股息（ETF 約 1~3%），故門檻留寬。
const PCT1D_MISMATCH_PP = 5;

async function fetchOne(
  item: PeerItem, customRange?: CustomRange, idxQuote?: IdxQuote, twseLive?: TwseLive,
): Promise<PeerPerfResult> {
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

    let rows: DayRow[] = rawQuotes
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

    // ^TWOII 已被 Yahoo 下架（chart/quote 都回 "symbol may be delisted"，替代代號也全查無）
    // → 改用 TPEx 官方月報表當歷史序列。沒這段的話 rows 為空，櫃買那一列整列空白。
    if (TPEX_INDEX_TICKERS.has(item.yfTicker)) {
      const tpex = await fetchTpexIndexRows(from, period2).catch(() => []);
      if (tpex.length) {
        rows = tpex
          .map(r => ({ date: r.date, adjClose: r.close, close: r.close }))
          .filter(r => marketClosed || r.date.toISOString().split('T')[0] < todayStr);
      }
    }

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
    // MIS 昨收只在「MIS 交易日 == Yahoo 報價日」時採信：放假/Yahoo 落後時 y 是另一天的昨收，不可拿來比。
    const misPrevClose = (!isIndexTicker(item) && twseLive?.prevClose != null
      && quote?.regularMarketTime != null
      && twseLive.date === new Date(quote.regularMarketTime).toISOString().slice(0, 10))
      ? twseLive.prevClose : null;
    const lastChartDate = lastRow.date;
    const quoteTime = quote?.regularMarketTime ? new Date(quote.regularMarketTime) : null;
    const quoteDate = quoteTime ? quoteTime.toISOString().split('T')[0] : null;

    // 最新交易日本身即為「還原基準日」，其還原係數 = 1，所以即時最新價可直接視為還原價。
    // 但若即時報價恰好等於最後一根 K 棒的「原始收盤價」，代表報價尚未更新到新交易日
    // —— 常見於除息日早盤：歷史價已還原、報價卻仍停在前一日。此時若併入，就會用「除息前原始價」
    // 去比「已還原基準」，把報酬灌高（曾出現 YTD 93.83% 的假數字）。故偵測到即略過，改用 K 棒還原價。
    // ⚠ 但「報價等於最後一根 K 棒收盤」也可能只是**真的平盤**（小型 ETF 很常見）。
    // 實例：00404A 2026-10-01 與 10-02 都收 9.88（TWSE 查證），被誤判成停更後整列停在 10-01、
    // 還被標成 anomaly。用 MIS 交叉確認：若 MIS 的交易日比最後一根 K 棒新，而且 MIS 的昨收
    // 正好等於那根 K 棒的收盤（＝確認它就是上一個交易日），那報價就是新交易日的收盤，不是停更。
    const misConfirmsNewSession = twseLive?.date != null && twseLive.prevClose != null
      && twseLive.date > lastRow.date.toISOString().slice(0, 10)
      && round2(twseLive.prevClose) === round2(lastRow.close);
    const quoteStale = quote?.regularMarketPrice != null
      && round2(quote.regularMarketPrice) === round2(lastRow.close)
      && !misConfirmsNewSession;

    // 指數（^TWII/^TWOII）不用 Yahoo 即時報價（殭屍值）與可能停更的日 K，改用 MIS 補最新交易日：
    // 盤中 → 用昨收（y）對齊個股「以上一完整收盤為準」；收盤後 → 用當日指數值（z）。
    const isIndex = item.yfTicker.startsWith('^');
    if (isIndex) {
      if (idxQuote) {
        if (!marketClosed) {
          if (idxQuote.prevClose != null) {
            const prevDay = new Date();
            do { prevDay.setDate(prevDay.getDate() - 1); } while (prevDay.getDay() === 0 || prevDay.getDay() === 6);
            if (prevDay.getTime() > lastChartDate.getTime()) {
              rows.push({ date: prevDay, adjClose: idxQuote.prevClose, close: idxQuote.prevClose });
            }
          }
        } else {
          const idxDate = new Date(idxQuote.date + 'T05:30:00Z'); // 台股收盤時點
          if (idxDate.getTime() > lastChartDate.getTime()) {
            rows.push({ date: idxDate, adjClose: idxQuote.value, close: idxQuote.value });
          }
        }
      }
    } else if (quoteDate === todayStr && !marketClosed) {
      // Intraday: use previous session's close with last-weekday date
      // 昨收優先用 MIS 的 y（Yahoo 的 regularMarketPreviousClose 偶爾是錯的，會把所有區間報酬帶歪）
      const prevClose = misPrevClose ?? quote?.regularMarketPreviousClose;
      if (prevClose != null) {
        const prevDay = new Date();
        do { prevDay.setDate(prevDay.getDate() - 1); } while (prevDay.getDay() === 0 || prevDay.getDay() === 6);
        // 只比「日期」：prevDay 帶著當下時分，若比 getTime 會恆大於 01:00Z 的 K 棒，
        // 導致 K 棒已含上一交易日時仍被覆蓋成 quote 昨收。
        if (prevDay.toISOString().slice(0, 10) > lastChartDate.toISOString().slice(0, 10)) {
          rows.push({ date: prevDay, adjClose: prevClose, close: prevClose });
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

    // 指數 1 日漲跌用 MIS 的 z/y（最新值 vs 昨收），避開 Yahoo 殭屍 changePercent、
    // 也避開日 K 停更造成的跨數日假 1 日報酬。
    // 個股沿用 Yahoo 的 changePercent，但若與 MIS 昨收算出的值差太多，代表 Yahoo 昨收壞了，改用 MIS。
    const misPct1d = (misPrevClose != null && quote?.regularMarketPrice != null)
      ? pct(quote.regularMarketPrice, misPrevClose)
      : null;
    const yahooPct1d: number | null = !isIndex ? (quote?.regularMarketChangePercent ?? null) : null;
    const pct1d = (isIndex && idxQuote?.value != null && idxQuote?.prevClose != null)
      ? pct(idxQuote.value, idxQuote.prevClose)
      : yahooPct1d != null
        ? (misPct1d != null && Math.abs(yahooPct1d - misPct1d) > PCT1D_MISMATCH_PP ? misPct1d : yahooPct1d)
        : pct(cur, rows.length >= 2 ? rows[rows.length - 2].adjClose : null);

    const pctCustom = customRange
      ? pct(findOnOrBefore(rows, customRange.end), findOnOrBefore(rows, customRange.start))
      : null;

    return {
      ...item,
      price:   isIndex ? (idxQuote?.value ?? cur) : (quote?.regularMarketPrice ?? cur),
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
      updatedAt: isIndex
        ? (idxQuote ? new Date(idxQuote.date + 'T05:30:00Z').toISOString() : null)
        : (quote?.regularMarketTime ? new Date(quote.regularMarketTime).toISOString() : null),
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
  // 先抓 TWSE 即時：個股「已成交最新日」(偵測 Yahoo 落後) + 指數即時值(t00/o00，指數計算的真相來源)
  const [twseLatest, idxMap] = await Promise.all([
    fetchTwseLatestTraded(group.items),
    fetchTwseIndices(group.items),
  ]);
  for (let i = 0; i < group.items.length; i += BATCH) {
    const batch = await Promise.all(
      group.items.slice(i, i + BATCH).map(item => fetchOne(item, customRange, idxMap.get(item.yfTicker), twseLatest.get(item.ticker))),
    );
    results.push(...batch);
  }

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
      // 個股用 tse_<code>，指數用 t00/o00；兩者皆以 TWSE 已成交最新日為準
      const live = twseLatest.get(r.ticker);
      const twseDate = (live?.traded ? live.date : undefined) ?? idxMap.get(r.yfTicker)?.date;
      if (twseDate && r.dataDate && r.dataDate < twseDate) {
        r.anomaly = true;
        r.anomalyReason = `Yahoo 缺最新報價（採用 ${r.dataDate}，TWSE 已有 ${twseDate}）`;
      }
    }
  }

  return NextResponse.json(results, { headers: { 'Cache-Control': 'no-store' } });
}
