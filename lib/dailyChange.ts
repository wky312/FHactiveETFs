import { supabase, supabaseReady } from './supabase';
import { fetchAll, mapLimit, isCashLike, closesByDate } from './consensus';

/* 同業當日加減碼 — 全 19 檔主動式 ETF「最新持股日 vs 前一個持股日」的個股股數變動。
   ──────────────────────────────────────────────────────────────────
   口徑＝「全部異動」：原始 Δqshare，不扣除申購贖回造成的等比例稀釋。
   每檔 ETF 各自取自己的最新持股日與其前一個持股日（各檔揭露日不一定同步，所以日期是逐檔回傳）。
   前端依使用者勾選的 ETF 在本地彙總，切換不需重打 API，故這裡一律回傳全 19 檔。

   金額 = Δ股數 × 最新持股日收盤價（沿用共識持股的「往前回溯」收盤窗口，休市日也有價）。
   沒有報價的個股（如海外股）close 為 null，前端顯示「—」、不計入金額合計。 */

export interface DailyChangeFund {
  ticker: string;
  name: string;
  curDate: string | null;
  prevDate: string | null;
  live?: boolean;        // 這檔的最新持股是直接向投信官網即時取得（資料庫尚未入庫）
  liveError?: string;    // 想即時查但官網失敗的原因
}
export interface DailyChangeEntry {
  ticker: string;
  prev: number;   // 前一持股日股數（新倉為 0）
  cur: number;    // 最新持股日股數（清倉為 0）
}
export interface DailyChangeStock {
  stockid: string;
  stockname: string;
  close: number | null;
  changes: DailyChangeEntry[];   // 只含股數有變動的 ETF
}
export interface DailyChangeResult {
  asOf: string;
  funds: DailyChangeFund[];
  stocks: DailyChangeStock[];
}

interface HoldRow { stockid: string; stockname: string; qshare: number | string | null }

const TTL_MS = 10 * 60 * 1000;
const FRESH_MIN_MS = 60 * 1000;      // fresh=1 也至少間隔 60 秒才真的重算，避免被拿來連續打資料庫
const CACHE_MAX = 16;                // 快取鍵數量上限（key＝查詢日期，'latest' 表最新）
const MAX_LOOKBACK_DAYS = 400;
const _cache = new Map<string, { ts: number; data: DailyChangeResult }>();
const _inflight = new Map<string, Promise<DailyChangeResult>>();
const FUND_CONCURRENCY = 4;
const LIVE_AFTER_MINS = 18 * 60;     // 平日 18:00 起，資料庫還沒更新的 ETF 自動改問投信官網
const LIVE_TIMEOUT_MS = 55_000;

/* 台北現在時間 */
function taipeiNow() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date());
  const g = (t: string) => parts.find(p => p.type === t)!.value;
  const ymd = `${g('year')}-${g('month')}-${g('day')}`;
  const wd = new Date(ymd + 'T00:00:00Z').getUTCDay();
  return { ymd, mins: Number(g('hour')) * 60 + Number(g('minute')), weekday: wd >= 1 && wd <= 5 };
}

type Snap = Map<string, { name: string; q: number }>;
interface FundState { e: { ticker: string; name: string }; curDate: string | null; prevDate: string | null; curMap: Snap | null; prevMap: Snap | null; live?: boolean; liveError?: string }
interface LiveResp { funds: Record<string, { date?: string; rows?: [string, string, number][]; error?: string }> }

const sameSnap = (a: Snap, b: Snap) => a.size === b.size && [...a].every(([id, v]) => b.get(id)?.q === v.q);

/* 向 /api/live_holdings（Python，重用官網抓取器）取當下最新持股，疊到資料庫結果上：
   - 官網日期 > 資料庫最新日 → 官網當「最新」、資料庫最新日當「前一日」
   - 官網日期 = 資料庫最新日 → 以官網為準（投信可能盤後修正）
   - 官網內容與資料庫最新日完全相同且日期是今天 → 視為還沒有新資料（無明確持股日的來源早上會把昨晚的公告標成今天）
   - 官網日期 < 資料庫最新日 → 忽略 */
async function applyLive(states: FundState[], tickers: string[], origin: string | undefined) {
  if (!tickers.length) return;
  const base = process.env.LIVE_HOLDINGS_URL ?? (origin ? `${origin}/api/live_holdings` : '');
  const fail = (msg: string) => { for (const f of states) if (tickers.includes(f.e.ticker)) f.liveError = msg; };
  if (!base) return fail('未設定即時來源網址');
  let resp: LiveResp;
  try {
    const r = await fetch(`${base}?tickers=${tickers.join(',')}`, { cache: 'no-store', signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    resp = await r.json() as LiveResp;
  } catch (e) {
    return fail(`即時來源失敗：${e instanceof Error ? e.message : String(e)}`);
  }
  const todayYmd = taipeiNow().ymd;
  for (const f of states) {
    if (!tickers.includes(f.e.ticker)) continue;
    const got = resp.funds?.[f.e.ticker];
    if (!got || got.error || !got.date || !got.rows?.length) { f.liveError = got?.error ?? '官網無回應'; continue; }
    const liveMap: Snap = new Map();
    for (const [id, name, q] of got.rows) {
      const sid = String(id).trim();
      if (isCashLike(sid, String(name)) || liveMap.has(sid) || !Number.isFinite(Number(q))) continue;
      liveMap.set(sid, { name: String(name).trim(), q: Number(q) });
    }
    if (!liveMap.size) continue;
    const L = got.date, C = f.curDate;
    if (C && L < C) continue;
    // 內容與資料庫最新日相同：日期沒前進、或日期是「今天」（無明確持股日的來源會把昨晚公告標成今天）→ 視為尚未公布；
    // 日期是更早的明確日期（如聯博 10/28 持股剛好與 10/27 一模一樣）則照樣前進，代表當日沒有調整。
    if (C && f.curMap && sameSnap(liveMap, f.curMap) && (L <= C || L >= todayYmd)) continue;
    if (!C || L > C) { f.prevDate = C; f.prevMap = f.curMap; }
    f.curDate = L; f.curMap = liveMap; f.live = true;
  }
}

async function loadSnapshot(ticker: string, date: string): Promise<Map<string, { name: string; q: number }>> {
  const rows = await fetchAll<HoldRow>((from, to) =>
    supabase!.from('holding').select('stockid,stockname,qshare')
      .eq('ticker', ticker).eq('date', date).range(from, to));
  const m = new Map<string, { name: string; q: number }>();
  for (const r of rows) {
    const id = String(r.stockid ?? '').trim();
    const name = String(r.stockname ?? '').trim();
    if (isCashLike(id, name) || m.has(id)) continue;   // 同檔同日去重
    const q = r.qshare == null ? NaN : Number(r.qshare);
    if (isNaN(q)) continue;
    m.set(id, { name, q });
  }
  return m;
}

/* opts.date（YYYY-MM-DD）：查指定持股日 vs 其前一持股日；該檔當天沒有持股就 curDate=null（前端標示「該日無資料」）。
   opts.fresh：繞過 10 分鐘快取（17:30 後使用者要立刻看到剛入庫的當日持股）。 */
export async function computeDailyChange(opts: { date?: string; fresh?: boolean; live?: boolean; origin?: string } = {}): Promise<DailyChangeResult> {
  if (!supabaseReady || !supabase) throw new Error('Supabase 未設定（缺 NEXT_PUBLIC_SUPABASE_URL / KEY）');
  if (opts.date) {
    const t = Date.parse(opts.date + 'T00:00:00Z');
    if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== opts.date) throw new Error('date 不是有效日期');
    const age = (Date.now() - t) / 86400_000;
    if (age > MAX_LOOKBACK_DAYS || age < -1) throw new Error(`date 只能查最近 ${MAX_LOOKBACK_DAYS} 天內`);
  }
  const key = opts.date ?? (opts.live ? 'latest|live' : 'latest');
  const hit = _cache.get(key);
  const ttl = opts.fresh ? FRESH_MIN_MS : TTL_MS;
  if (hit && Date.now() - hit.ts < ttl) return hit.data;
  const running = _inflight.get(key);                 // 同一個 key 同時多個請求只算一次
  if (running) return running;
  const p = doCompute(opts, key).finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

async function doCompute(opts: { date?: string; live?: boolean; origin?: string }, key: string): Promise<DailyChangeResult> {
  if (!supabase) throw new Error('Supabase 未設定');

  const { data: etfs } = await supabase
    .from('etf').select('ticker,name')
    .eq('market', 'tw').eq('type', 'equity').order('ticker');
  const etfList = (etfs ?? []) as { ticker: string; name: string }[];
  if (!etfList.length) throw new Error('查無 ETF 清單');

  const perFund: FundState[] = await mapLimit(etfList, FUND_CONCURRENCY, async (e) => {
    let q = supabase!.from('holding').select('date').eq('ticker', e.ticker);
    if (opts.date) q = q.eq('date', opts.date);
    const { data: cur } = await q.order('date', { ascending: false }).limit(1).maybeSingle();
    const curDate = (cur?.date as string) ?? null;
    if (!curDate) return { e, curDate: null, prevDate: null, curMap: null, prevMap: null };
    const { data: prv } = await supabase!.from('holding').select('date')
      .eq('ticker', e.ticker).lt('date', curDate).order('date', { ascending: false }).limit(1).maybeSingle();
    const prevDate = (prv?.date as string) ?? null;
    const curMap = await loadSnapshot(e.ticker, curDate);
    const prevMap = prevDate ? await loadSnapshot(e.ticker, prevDate) : null;
    return { e, curDate, prevDate, curMap, prevMap };
  });

  // 即時層：強制查最新＝全部問官網；平日 18:00 起＝只補資料庫還沒更新到今天的 ETF
  if (!opts.date) {
    const tp = taipeiNow();
    const liveTickers = opts.live
      ? perFund.map(f => f.e.ticker)
      : tp.weekday && tp.mins >= LIVE_AFTER_MINS ? perFund.filter(f => (f.curDate ?? '') < tp.ymd).map(f => f.e.ticker) : [];
    await applyLive(perFund, liveTickers, opts.origin);
  }

  // 前一持股日離最新日超過 14 天（資料庫中間缺很多天）→ 變動會是一整個月的累計，金額會被灌大，視為無法比較
  for (const f of perFund) {
    if (f.curDate && f.prevDate && (Date.parse(f.curDate) - Date.parse(f.prevDate)) / 86400_000 > 14) { f.prevDate = null; f.prevMap = null; }
  }

  // 逐檔算 Δ，彙整成 stockid → 各 ETF 變動
  const agg = new Map<string, { stockname: string; changes: DailyChangeEntry[] }>();
  for (const { e, curMap, prevMap } of perFund) {
    if (!curMap || !prevMap) continue;   // 沒有前一日可比就不算（避免整份持股被當成新倉）
    for (const id of new Set([...curMap.keys(), ...prevMap.keys()])) {
      const cur = curMap.get(id)?.q ?? 0;
      const prev = prevMap.get(id)?.q ?? 0;
      if (cur === prev) continue;
      const a = agg.get(id) ?? { stockname: curMap.get(id)?.name || prevMap.get(id)?.name || id, changes: [] };
      a.changes.push({ ticker: e.ticker, prev, cur });
      agg.set(id, a);
    }
  }

  // 只替「有變動」的個股補收盤價
  const dates = [...new Set(perFund.map(f => f.curDate).filter((d): d is string => !!d))];
  const ids = [...agg.keys()];
  const closes = dates.length && ids.length ? await closesByDate(dates, ids) : new Map<string, Map<string, number>>();
  const asOf = dates.reduce((mx, d) => (d > mx ? d : mx), '');
  // 同一個股在各 ETF 的最新持股日通常相同；取 asOf 那天的收盤，抓不到再退而取其他日期
  const closeOf = (id: string): number | null => {
    const primary = closes.get(asOf)?.get(id);
    if (primary != null) return primary;
    for (const m of closes.values()) { const c = m.get(id); if (c != null) return c; }
    return null;
  };

  const stocks: DailyChangeStock[] = [...agg.entries()].map(([stockid, a]) => ({
    stockid, stockname: a.stockname, close: closeOf(stockid), changes: a.changes,
  }));

  const funds: DailyChangeFund[] = perFund.map(({ e, curDate, prevDate, live, liveError }) => ({
    ticker: e.ticker, name: e.name, curDate, prevDate, ...(live ? { live } : {}), ...(liveError ? { liveError } : {}),
  }));

  const data: DailyChangeResult = { asOf, funds, stocks };
  _cache.delete(key);
  _cache.set(key, { ts: Date.now(), data });
  while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value as string);   // 淘汰最舊
  return data;
}
