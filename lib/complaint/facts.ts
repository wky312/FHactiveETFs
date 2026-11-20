/* 客訴回覆助手：事實包（Fact Pack）。
   全部是可查證的數字，Gemini 只能引用這裡的值，compliance.ts 也拿這份來核對回覆裡的百分比。
   刻意不依賴 LLM —— 額度爆了、key 失效，模板稿仍然靠這份產出。 */
import { ETF_LIST } from '@/lib/etfList';
import { PEER_GROUPS, type PeerItem } from '@/lib/peerGroups';
import { computePeerPerformance, type PeerPerfResult } from '@/lib/peerPerformance';
import { fetchTotalReturnSeries, type TrBar } from '@/lib/yahooFinance';
import { loadStoredHoldings } from '@/lib/holdingsStore';
import { fetchHoldings } from '@/lib/fhtrust';
import { onlyStockRows } from '@/lib/holdingRows';
import { resolveYfTicker } from '@/lib/exchangeMap';
import { readPageCache, writePageCache, taipeiDateStr } from '@/lib/pageCache';

export type FundKind = 'tw' | 'overseas';

/** 每檔的屬性。掛牌日用來 gate「掛牌以來」與進場日上下限（Yahoo 常有掛牌前資料，不能拿第一根 K 當掛牌日）。 */
interface FundMeta { kind: FundKind; listing: string; style: string; mainBench: PeerItem; extraBench?: PeerItem }

const B_0050: PeerItem    = { ticker: '0050', yfTicker: '0050.TW', name: '元大台灣50', benchmark: true };
const B_SP500TR: PeerItem = { ticker: '^SP500TR', yfTicker: '^SP500TR', name: 'S&P500(含息)', benchmark: true };
const B_XLF: PeerItem     = { ticker: 'XLF', yfTicker: 'XLF', name: '美國金融類股ETF(XLF)', benchmark: true };

export const FUND_META: Record<string, FundMeta> = {
  '00991A': { kind: 'tw',       listing: '2025-12-18', style: '台股主動式，聚焦具成長動能的台灣中大型企業', mainBench: B_0050 },
  '00418A': { kind: 'tw',       listing: '2026-11-11', style: '台股主動式，聚焦台灣具成長潛力的新星企業',   mainBench: B_0050 },
  '00998A': { kind: 'overseas', listing: '2026-04-15', style: '海外主動式，聚焦全球金融產業（銀行、保險、金融服務）', mainBench: B_SP500TR, extraBench: B_XLF },
  '00409A': { kind: 'overseas', listing: '2026-09-02', style: '海外主動式，聚焦全球具成長性的龍頭企業',     mainBench: B_SP500TR },
};

export const COMPLAINT_TICKERS = Object.keys(FUND_META);

export interface Periods {
  d1: number | null; wtd: number | null; mtd: number | null;
  m1: number | null; m3: number | null; ytd: number | null;
}
export interface NamedPeriods { name: string; ticker: string; periods: Periods }
export interface Rank { period: keyof Periods; label: string; rank: number; total: number }
export interface StockRef { code: string; name: string; weight: number }
export interface WeightMove { code: string; name: string; from: number; to: number; delta: number }
export interface ChangeSet {
  fromDate: string; toDate: string;
  added: StockRef[]; exited: (StockRef & { prevWeight: number })[];
  increased: WeightMove[]; decreased: WeightMove[];
}
export interface Contributor { code: string; name: string; weight: number; ret: number; contrib: number }
export interface Drawdown { name: string; peakDate: string; ddPct: number }
export interface EntryScenario {
  date: string; entryPriceDate: string;
  fundReturn: number; highSinceEntry: number; fromHighPct: number;
  benchName: string; benchReturn: number | null;
}

export interface FactPack {
  ticker: string; name: string; kind: FundKind; style: string;
  listingDate: string; tradingDaysSinceListing: number;
  asOf: string | null;                    // 基金績效採用的資料日
  generatedAt: string;
  fund: Periods;
  sinceListing: number | null;            // 以掛牌首日收盤為基準
  benches: NamedPeriods[];
  peerAvg: Periods; peerCount: number; peerGroupLabel: string;
  ranks: Rank[];
  drawdown: { fund: Drawdown | null; bench: Drawdown | null };
  holdings: {
    latestDate: string | null;
    top10: StockRef[];
    short: ChangeSet | null;              // 約 5 個交易日
    long: ChangeSet | null;               // 約 20 個交易日
  };
  contributors: { period: string; top: Contributor[]; bottom: Contributor[] } | null;
  entry: EntryScenario | null;
  notes: string[];
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

const r2 = (x: number) => Math.round(x * 100) / 100;
const r2n = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? null : r2(x));

function toPeriods(p: PeerPerfResult | undefined): Periods {
  return {
    d1: r2n(p?.pct1d), wtd: r2n(p?.pctWTD), mtd: r2n(p?.pctMTD),
    m1: r2n(p?.pct1m), m3: r2n(p?.pct3m), ytd: r2n(p?.pctYTD),
  };
}

const PERIOD_KEYS: (keyof Periods)[] = ['d1', 'wtd', 'mtd', 'm1', 'm3', 'ytd'];
export const PERIOD_LABEL: Record<keyof Periods, string> = {
  d1: '最近一日', wtd: '本週以來', mtd: '本月以來', m1: '近一個月', m3: '近三個月', ytd: '今年以來',
};

const isoToSlash = (iso: string) => iso.replace(/-/g, '/');
const slashToIso = (s: string) => s.replace(/\//g, '-');

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// ── 持股：存檔＋即時補最新 ─────────────────────────────────────────────────

interface Snapshot { date: string; rows: Map<string, { name: string; weight: number }> }

/* 指數期貨是避險／曝險調整工具，每季換約會被 diff 成「新增＋出清」，寫進客訴回覆會誤導 → 敘事一律排除。 */
const isFuture = (code: string, name: string) => /期貨|FUTURE/i.test(name) || /期貨/.test(code);

async function loadSnapshots(fundId: string): Promise<Snapshot[]> {
  const stored = loadStoredHoldings(fundId);
  const snaps: Snapshot[] = [];
  const names = stored?.names ?? {};
  if (stored) {
    for (const d of Object.keys(stored.days).sort()) {
      const m = new Map<string, { name: string; weight: number }>();
      for (const r of stored.days[d]) {
        if (!r.c?.trim() || !(r.p > 0) && !(r.q > 0)) continue;
        const nm = names[r.c] ?? r.c;
        if (isFuture(r.c, nm)) continue;
        m.set(r.c, { name: nm, weight: r.p });
      }
      if (m.size) snaps.push({ date: d, rows: m });
    }
  }
  // 存檔是部署時打包的 → 最近幾天靠即時補（新→舊試最多 7 個日曆日，碰到存檔最後一天就停）
  const last = snaps.length ? snaps[snaps.length - 1].date : '';
  const extra: Snapshot[] = [];
  const today = new Date(`${taipeiDateStr()}T12:00:00+08:00`);
  for (let k = 0; k < 7; k++) {
    const d = new Date(today.getTime() - k * 86400000);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const key = isoToSlash(d.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }));
    if (key <= last) break;
    try {
      const res = await fetchHoldings(key, fundId);
      const m = new Map<string, { name: string; weight: number }>();
      for (const h of onlyStockRows(res.holdings)) {
        if (!h.stockid.trim() || h.ftype === '期貨' || isFuture(h.stockid, h.stockname)) continue;
        m.set(h.stockid, { name: h.stockname || names[h.stockid] || h.stockid, weight: h.prate_addaccint });
      }
      const date = (res.date || key).slice(0, 10).replace(/-/g, '/');
      if (m.size && date > last && !extra.some(e => e.date === date)) extra.push({ date, rows: m });
    } catch { /* 未公布／休市 → 往前一天 */ }
  }
  return [...snaps, ...extra.sort((a, b) => a.date.localeCompare(b.date))];
}

/* 權重 < 0.05% 視同未持有：存檔會保留 0.00% 的千股零頭部位（軌跡要看股數），
   但寫進客訴回覆會變成「出清 原 0.00%」「加碼 0.00→0.71%」這種雜訊。 */
const MIN_W = 0.05;

function diffSnapshots(prev: Snapshot, cur: Snapshot): ChangeSet {
  const added: StockRef[] = [];
  const exited: (StockRef & { prevWeight: number })[] = [];
  const moves: WeightMove[] = [];
  const held = (snap: Snapshot, code: string) => (snap.rows.get(code)?.weight ?? 0) >= MIN_W;
  for (const [code, v] of cur.rows) {
    if (v.weight < MIN_W) continue;
    const p = prev.rows.get(code);
    if (!held(prev, code)) added.push({ code, name: v.name, weight: r2(v.weight) });
    else moves.push({ code, name: v.name, from: r2(p!.weight), to: r2(v.weight), delta: r2(v.weight - p!.weight) });
  }
  for (const [code, p] of prev.rows) {
    if (p.weight >= MIN_W && !held(cur, code)) exited.push({ code, name: p.name, weight: 0, prevWeight: r2(p.weight) });
  }
  added.sort((a, b) => b.weight - a.weight);
  exited.sort((a, b) => b.prevWeight - a.prevWeight);
  const increased = moves.filter(m => m.delta >= 0.1).sort((a, b) => b.delta - a.delta).slice(0, 5);
  const decreased = moves.filter(m => m.delta <= -0.1).sort((a, b) => a.delta - b.delta).slice(0, 5);
  return { fromDate: prev.date, toDate: cur.date, added: added.slice(0, 5), exited: exited.slice(0, 5), increased, decreased };
}

// ── 價格序列 ───────────────────────────────────────────────────────────────

function onOrAfter(bars: TrBar[], dateSlash: string): TrBar | null {
  return bars.find(b => b.date >= dateSlash) ?? null;
}

function drawdownOf(name: string, bars: TrBar[]): Drawdown | null {
  if (bars.length < 2) return null;
  let peak = bars[0];
  for (const b of bars) if (b.adj > peak.adj) peak = b;
  const cur = bars[bars.length - 1];
  return { name, peakDate: slashToIso(peak.date), ddPct: r2((cur.adj / peak.adj - 1) * 100) };
}

// ── 主函式 ─────────────────────────────────────────────────────────────────

export class FactError extends Error {}

/** 驗證進場日：格式、不早於掛牌日、不晚於今天。回傳錯誤訊息或 null。 */
export function validateEntryDate(ticker: string, entryDate: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate) || Number.isNaN(Date.parse(entryDate))) return '進場日格式應為 YYYY-MM-DD';
  const meta = FUND_META[ticker];
  if (meta && entryDate < meta.listing) return `進場日不可早於掛牌日 ${meta.listing}`;
  if (entryDate > taipeiDateStr()) return '進場日不可晚於今天';
  return null;
}

const memCache = new Map<string, { at: number; pack: FactPack }>();
const MEM_TTL_MS = 15 * 60 * 1000;

export async function buildFactPack(ticker: string, entryDate?: string): Promise<FactPack> {
  const meta = FUND_META[ticker];
  const etf = ETF_LIST.find(e => e.ticker === ticker);
  if (!meta || !etf) throw new FactError(`不支援的基金 ${ticker}`);

  // 基礎事實包（不含進場日）可快取；進場日情境每次另算
  const today = taipeiDateStr();
  const hourTw = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', hour12: false }));
  const settled = hourTw >= 17;                       // 17:00 後當日行情、持股都已落定才寫持久快取
  const cacheKey = `complaint-facts:${ticker}:${today}`;
  let base: FactPack | null = null;
  const mem = memCache.get(cacheKey);
  if (mem && Date.now() - mem.at < MEM_TTL_MS) base = mem.pack;
  if (!base && settled) base = await readPageCache<FactPack>(cacheKey);
  if (!base) {
    base = await buildBase(ticker, meta, etf.fundId, etf.name);
    memCache.set(cacheKey, { at: Date.now(), pack: base });
    if (settled) await writePageCache(cacheKey, base);
  } else {
    memCache.set(cacheKey, { at: mem?.at ?? Date.now(), pack: base });
  }

  const pack: FactPack = { ...base, entry: null };
  if (entryDate) pack.entry = await buildEntry(ticker, meta, entryDate);
  return pack;
}

async function buildBase(ticker: string, meta: FundMeta, fundId: string, fullName: string): Promise<FactPack> {
  const notes: string[] = [];
  const groupKey = meta.kind === 'tw' ? 'active' : 'overseas';
  const group = PEER_GROUPS[groupKey];
  const items = [...group.items];
  if (meta.extraBench && !items.some(i => i.ticker === meta.extraBench!.ticker)) items.push(meta.extraBench);
  if (!items.some(i => i.ticker === meta.mainBench.ticker)) items.push(meta.mainBench);

  const seriesFrom = new Date(`${meta.listing}T00:00:00+08:00`);
  seriesFrom.setDate(seriesFrom.getDate() - 7);
  const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const ddFrom = seriesFrom > sixMonthsAgo ? seriesFrom : sixMonthsAgo;
  const to = new Date(Date.now() + 86400000);
  const etf = ETF_LIST.find(e => e.ticker === ticker)!;

  const [perf, fundSeries, benchSeries, snaps] = await Promise.all([
    computePeerPerformance(items),
    fetchTotalReturnSeries(etf.yfTicker, seriesFrom, to),
    fetchTotalReturnSeries(meta.mainBench.yfTicker, ddFrom, to),
    loadSnapshots(fundId),
  ]);

  const fundRow = perf.find(p => p.ticker === ticker);
  if (fundRow?.anomaly) notes.push(`報價資料提示：${fundRow.anomalyReason}`);
  const peers = perf.filter(p => !p.benchmark);
  const benchRows = perf.filter(p => p.benchmark);
  const fund = toPeriods(fundRow);

  // 同業等權平均（不含基準、不含本檔）
  const others = peers.filter(p => p.ticker !== ticker);
  const peerAvg = {} as Periods;
  for (const k of PERIOD_KEYS) {
    const vals = others.map(p => toPeriods(p)[k]).filter((v): v is number => v != null);
    peerAvg[k] = vals.length ? r2(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  }
  const ranks: Rank[] = [];
  for (const k of ['m1', 'm3', 'ytd'] as (keyof Periods)[]) {
    const mine = fund[k];
    if (mine == null) continue;
    const vals = peers.map(p => toPeriods(p)[k]).filter((v): v is number => v != null);
    if (vals.length < 3) continue;
    ranks.push({ period: k, label: PERIOD_LABEL[k], rank: vals.filter(v => v > mine).length + 1, total: vals.length });
  }

  // 基準：主基準＋額外基準＋（台股）加權指數
  const benchOrder = [meta.mainBench.ticker, meta.extraBench?.ticker, meta.kind === 'tw' ? '^TWII' : '^XCMP'].filter(Boolean) as string[];
  const benches: NamedPeriods[] = benchOrder
    .map(t => benchRows.find(b => b.ticker === t))
    .filter((b): b is PeerPerfResult => !!b && b.price != null)
    .map(b => ({ name: b.name, ticker: b.ticker, periods: toPeriods(b) }));

  // 掛牌以來（掛牌首日收盤為基準）＋回檔
  const listingSlash = isoToSlash(meta.listing);
  const fundBars = fundSeries.bars.filter(b => b.date >= listingSlash);
  const tradingDaysSinceListing = fundBars.length;
  const first = fundBars[0];
  const last = fundBars[fundBars.length - 1];
  const sinceListing = first && last && fundBars.length >= 2 ? r2((last.adj / first.adj - 1) * 100) : null;
  const ddFromSlash = isoToSlash(ddFrom.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }));
  const fundDd = drawdownOf(etf.ticker, fundBars.filter(b => b.date >= ddFromSlash));
  const benchDd = drawdownOf(meta.mainBench.name, benchSeries.bars.filter(b => b.date >= ddFromSlash));
  if (tradingDaysSinceListing < 22) notes.push(`本基金掛牌僅 ${tradingDaysSinceListing} 個交易日，多數期間績效尚無法計算，短期波動不宜過度解讀。`);

  // 持股調整
  let latestDate: string | null = null;
  let top10: StockRef[] = [];
  let short: ChangeSet | null = null;
  let long: ChangeSet | null = null;
  if (snaps.length) {
    const cur = snaps[snaps.length - 1];
    latestDate = slashToIso(cur.date);
    top10 = [...cur.rows.entries()]
      .map(([code, v]) => ({ code, name: v.name, weight: r2(v.weight) }))
      .sort((a, b) => b.weight - a.weight).slice(0, 10);
    if (snaps.length >= 2) short = diffSnapshots(snaps[Math.max(0, snaps.length - 6)], cur);
    if (snaps.length >= 8) long = diffSnapshots(snaps[Math.max(0, snaps.length - 21)], cur);
  } else {
    notes.push('持股資料暫時取不到，回覆中不描述持股調整。');
  }

  // 前十大近一個月貢獻（估算：期末權重 × 個股報酬，當地幣別）
  let contributors: FactPack['contributors'] = null;
  if (top10.length) {
    let mFrom = new Date(); mFrom.setMonth(mFrom.getMonth() - 1);
    const listedFrom = new Date(`${meta.listing}T12:00:00+08:00`);
    const sinceListingPeriod = listedFrom > mFrom;
    if (sinceListingPeriod) mFrom = listedFrom;
    const startSlash = isoToSlash(mFrom.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }));
    const cFrom = new Date(mFrom.getTime() - 7 * 86400000);
    const list = await mapLimit(top10, 5, async (s): Promise<Contributor | null> => {
      const { yfTicker, fallback } = resolveYfTicker(s.code, meta.kind === 'tw');
      const ser = await fetchTotalReturnSeries(yfTicker, cFrom, to, fallback).catch(() => null);
      const bars = ser?.bars ?? [];
      const b0 = [...bars].reverse().find(b => b.date <= startSlash) ?? bars[0];
      const b1 = bars[bars.length - 1];
      if (!b0 || !b1 || b0 === b1) return null;
      const ret = r2((b1.adj / b0.adj - 1) * 100);
      return { ...s, ret, contrib: r2(s.weight * ret / 100) };
    });
    const ok = list.filter((c): c is Contributor => !!c);
    if (ok.length) {
      const sorted = [...ok].sort((a, b) => b.contrib - a.contrib);
      contributors = {
        period: sinceListingPeriod ? '掛牌以來' : '近一個月',
        top: sorted.filter(c => c.contrib > 0).slice(0, 3),
        bottom: sorted.filter(c => c.contrib < 0).reverse().slice(0, 3),
      };
    }
  }

  return {
    ticker, name: `${fullName}（${ticker}）`, kind: meta.kind, style: meta.style,
    listingDate: meta.listing, tradingDaysSinceListing,
    asOf: fundRow?.dataDate ?? (last ? slashToIso(last.date) : null),
    generatedAt: new Date().toISOString(),
    fund, sinceListing, benches, peerAvg, peerCount: others.length, peerGroupLabel: group.label,
    ranks, drawdown: { fund: fundDd, bench: benchDd },
    holdings: { latestDate, top10, short, long },
    contributors, entry: null, notes,
  };
}

async function buildEntry(ticker: string, meta: FundMeta, entryDate: string): Promise<EntryScenario | null> {
  const etf = ETF_LIST.find(e => e.ticker === ticker)!;
  const from = new Date(`${entryDate}T00:00:00+08:00`); from.setDate(from.getDate() - 7);
  const to = new Date(Date.now() + 86400000);
  const [fs, bs] = await Promise.all([
    fetchTotalReturnSeries(etf.yfTicker, from, to),
    fetchTotalReturnSeries(meta.mainBench.yfTicker, from, to),
  ]);
  const slash = isoToSlash(entryDate);
  const e0 = onOrAfter(fs.bars, slash);
  const e1 = fs.bars[fs.bars.length - 1];
  if (!e0 || !e1) return null;
  const after = fs.bars.filter(b => b.date >= e0.date);
  const high = after.reduce((m, b) => Math.max(m, b.adj), e0.adj);
  const b0 = onOrAfter(bs.bars, slash);
  const b1 = bs.bars[bs.bars.length - 1];
  return {
    date: entryDate, entryPriceDate: slashToIso(e0.date),
    fundReturn: r2((e1.adj / e0.adj - 1) * 100),
    highSinceEntry: r2((high / e0.adj - 1) * 100),
    fromHighPct: r2((e1.adj / high - 1) * 100),
    benchName: meta.mainBench.name,
    benchReturn: b0 && b1 ? r2((b1.adj / b0.adj - 1) * 100) : null,
  };
}
