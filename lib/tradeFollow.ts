/* 換股追蹤（Trade Follow-up）——海外主動式 ETF
   ──────────────────────────────────────────────
   回答兩個問題：
   1) 經理人「新增／加碼」的股票，之後有沒有漲？（買對 vs 買錯）
   2) 經理人「減碼／出清」的股票，之後是不是反而漲了？（賣飛 vs 賣對）
   另附「目前配置」：最新持股權重 vs 約 20 個交易日前，掌握經理人現在的布局方向。

   換股偵測（純持股資料，無網路，detectTrades 可單獨測試）：
   - 新增＝前一份持股沒有、這一份有；出清＝前一份有、這一份沒有。
   - 加碼／減碼看「股數」變化，但 ETF 每天有申購／買回，所有持股股數會一起等比例增減，
     那不是經理人的選擇。所以先取當天所有共同持股「股數變化倍數」的中位數當作資金流因子，
     個股股數變化扣掉這個因子後偏離 ≥ 10% 才算加碼／減碼。
   - 股數剛好變成整數倍（2、3、4…倍或 1/2、1/3…）且權重幾乎沒變 → 視為分割／合併，不算換股。
   - 某一份持股突然有一大批股票消失（>30% 且 ≥5 檔），多半是資料源當天解析不完整，整份略過。
   - 同一檔股票連續幾份持股都在同方向調整（例如連買 3 天）→ 合併成一筆，日期記第一天。

   換股後表現（需網路：Yahoo 個股還原收盤＋匯率＋基金本身市價）：
   - 基準價＝換股日（持股公布日）收盤；個股報酬換算成新台幣（與基金同幣別）。
   - 期間（seg，預設、用來判斷買對／賣飛）：依時間切段——每次操作只算到同一檔股票的「下一次動作」
     （不論買或賣）那天；沒有下一次動作就算到最新一天。例：09/14 新增、09/16 加碼、10/05 減碼
     → 09/14 新增算 09/14~09/16、09/16 加碼算 09/16~10/05，各段不重疊。
   - 另附固定期間：之後第 5／20／60 個交易日（以該 ETF 在台股的交易日計），以及到最新一天。
   - 相對報酬＝個股報酬 − 同期間該 ETF 本身市價（還原）報酬：正值代表「比基金整體強」。 */

import { OVERSEAS_FUNDS } from './overseasFunds';
import { PEER_GROUPS } from './peerGroups';
import { buildOverseasDayMap, isCashLike, canonOf } from './overseasAttribution';
import { resolveYfTicker, stockidToYfTicker } from './exchangeMap';
import { BUILTIN_GROUPS_OVERSEAS } from './sectorGroupsOverseas';
import { canonicalCode } from './sectorExposure';
import { yf } from './marketCalendar/sources/yahoo';
import { fetchTotalReturnSeries } from './yahooFinance';
import { currencyForStockid, fetchFxSeries } from './fx';
import { computeScorecard } from './scorecard';
import type { Holding } from './types';

/* ── 型別 ─────────────────────────────────────────────────────────── */
export type TradeType = 'new' | 'add' | 'trim' | 'exit';   // 新增／加碼／減碼／出清
export type TradeSide = 'buy' | 'sell';
export const WINDOWS = [5, 20, 60] as const;

export interface DetectedTrade {
  id: string;              // canon 代號（跨資料源一致）
  rawId: string;           // 原始代號（顯示用，如 'NVDA US'）
  name: string;
  type: TradeType;
  side: TradeSide;
  date: string;            // 第一天 YYYY/MM/DD
  endDate: string;         // 連續調整的最後一天
  days: number;            // 合併了幾份持股
  weightBefore: number;    // 調整前權重 %
  weightAfter: number;     // 調整後權重 %
}

export interface TradeResult extends DetectedTrade {
  priced: boolean;
  ret: Record<string, number | null>;   // 'seg' | 'd5' | 'd20' | 'd60' | 'now' → 個股報酬 %（新台幣）
  rel: Record<string, number | null>;   // 同上，減去同期基金報酬（百分點）
  nowDate: string | null;               // 「至今」實際算到哪一天
  segEnd: string | null;                // seg 算到哪一天（YYYY-MM-DD）
  segEndBy: TradeType | null;           // 結束 seg 的下一次動作；null＝之後沒有動作（算到最新一天）
}

export interface AllocationRow {
  id: string; rawId: string; name: string;
  weight: number;          // 最新權重 %
  weightPrev: number;      // 約 20 個交易日前權重 %（當時沒持有＝0）
  isNew: boolean;          // 20 日前沒持有
}

export interface TradeFollowResult {
  fund: string; fundName: string;
  start: string; end: string;              // 查詢區間（換股日落在此區間）
  asOf: string;                            // 最新持股日
  allocPrevDate: string;                   // 配置比較的基準日
  holdingsCount: number;
  trades: TradeResult[];
  allocation: AllocationRow[];
  exitedRecently: AllocationRow[];         // 20 日前有、現在沒有
  skippedDates: string[];                  // 疑似資料不完整而略過的持股日
  recentDates: string[];                   // 最近 20 份持股日（新→舊，YYYY-MM-DD），給「近期操作」切區間
  sectors: Record<string, string>;         // 個股 id → 產業（近 20 份持股內有換股的股票）
  /* 個股 id → 「選股對帳單」同一套算法的持有總報酬（移動平均成本、當地幣別、未還原息）：
     目前持有＝未實現報酬（現價 vs 剩餘部位平均成本）；已出清＝已實現＋未實現總報酬。
     直接呼叫 lib/scorecard（同一份 10 分鐘快取），兩個分頁的數字一致。基金不支援時為空物件。 */
  costReturn: Record<string, { ret: number | null; held: boolean }>;
  unpriced: string[];                      // 抓不到報價的股票
  warning?: string;
}

/* ── 小工具 ─────────────────────────────────────────────────────────── */
const ADD_THRESHOLD = 0.10;
const MASS_EXIT_RATIO = 0.30;
const MASS_EXIT_MIN = 5;

const isoToSlash = (s: string) => s.replace(/-/g, '/');
const slashToIso = (s: string) => s.replace(/\//g, '-');
function todayTW(): string {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}/${String(t.getUTCMonth() + 1).padStart(2, '0')}/${String(t.getUTCDate()).padStart(2, '0')}`;
}
function addDaysSlash(s: string, n: number): string {
  const d = new Date(slashToIso(s) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** 股數倍數是否為分割／合併（整數倍或整數分之一，誤差 1%）。 */
function looksLikeSplit(ratio: number): boolean {
  if (!Number.isFinite(ratio) || ratio <= 0) return false;
  const r = ratio >= 1 ? ratio : 1 / ratio;
  const k = Math.round(r);
  return k >= 2 && Math.abs(r - k) / k < 0.01;
}

interface Pos { q: number; w: number; name: string; raw: string }
type Snapshot = Map<string, Pos>;

/** dayMap → 依日期排序的持股快照（去現金、同一檔不同後綴合併）。 */
export function toSnapshots(dayMap: Map<string, Holding[]>, canon: (s: string) => string = canonOf): { date: string; snap: Snapshot }[] {
  const out: { date: string; snap: Snapshot }[] = [];
  for (const date of [...dayMap.keys()].sort()) {
    const snap: Snapshot = new Map();
    for (const h of dayMap.get(date) ?? []) {
      if (!h.qshare || h.qshare <= 0) continue;
      if (isCashLike(h.stockid, h.stockname ?? '', h.ftype)) continue;
      const id = canon(h.stockid);
      const cur = snap.get(id);
      if (cur) { cur.q += h.qshare; cur.w += h.prate_addaccint || 0; }
      else snap.set(id, { q: h.qshare, w: h.prate_addaccint || 0, name: h.stockname || '', raw: h.stockid.trim() });
    }
    if (snap.size > 0) out.push({ date, snap });
  }
  return out;
}

/** 純函式：從逐日持股快照找出換股事件。 */
export function detectTrades(snaps: { date: string; snap: Snapshot }[]): { trades: DetectedTrade[]; skipped: string[]; goodDates: string[] } {
  const skipped: string[] = [];
  const good: { date: string; snap: Snapshot }[] = [];
  for (const s of snaps) {
    const prev = good[good.length - 1];
    if (prev) {
      let gone = 0;
      for (const id of prev.snap.keys()) if (!s.snap.has(id)) gone++;
      if (gone >= MASS_EXIT_MIN && gone > prev.snap.size * MASS_EXIT_RATIO) { skipped.push(s.date); continue; }
    }
    good.push(s);
  }

  const raw: DetectedTrade[] = [];
  for (let i = 1; i < good.length; i++) {
    const { snap: a } = good[i - 1];
    const { date, snap: b } = good[i];
    const ratios: number[] = [];
    for (const [id, pb] of b) { const pa = a.get(id); if (pa) ratios.push(pb.q / pa.q); }
    const flow = ratios.length >= 5 ? median(ratios) : 1;

    const mk = (id: string, type: TradeType, pa: Pos | undefined, pb: Pos | undefined): DetectedTrade => ({
      id, rawId: (pb ?? pa)!.raw, name: (pb?.name || pa?.name || ''),
      type, side: type === 'new' || type === 'add' ? 'buy' : 'sell',
      date, endDate: date, days: 1,
      weightBefore: pa?.w ?? 0, weightAfter: pb?.w ?? 0,
    });

    for (const [id, pb] of b) {
      const pa = a.get(id);
      if (!pa) { raw.push(mk(id, 'new', undefined, pb)); continue; }
      const ratio = pb.q / pa.q;
      const dev = ratio / flow - 1;
      if (Math.abs(dev) < ADD_THRESHOLD) continue;
      // 分割／合併：股數整數倍、權重幾乎沒變
      const wChange = pa.w > 0 ? Math.abs(pb.w / pa.w - 1) : 1;
      if (looksLikeSplit(ratio) && wChange < 0.2) continue;
      raw.push(mk(id, dev > 0 ? 'add' : 'trim', pa, pb));
    }
    for (const [id, pa] of a) if (!b.has(id)) raw.push(mk(id, 'exit', pa, undefined));
  }

  // 合併同一檔「相鄰快照、同方向」的調整
  const idx = new Map(good.map((g, i) => [g.date, i]));
  const byStock = new Map<string, DetectedTrade[]>();
  for (const t of raw) { const l = byStock.get(t.id) ?? []; l.push(t); byStock.set(t.id, l); }
  const merged: DetectedTrade[] = [];
  for (const list of byStock.values()) {
    list.sort((x, y) => x.date.localeCompare(y.date));
    let cur: DetectedTrade | null = null;
    for (const t of list) {
      if (cur && cur.side === t.side && idx.get(t.date)! === idx.get(cur.endDate)! + 1) {
        cur.endDate = t.date;
        cur.days += 1;
        cur.weightAfter = t.weightAfter;
        if (t.type === 'exit') cur.type = 'exit';           // 減碼後接著出清 → 算出清
        if (t.name && !cur.name) cur.name = t.name;
        continue;
      }
      if (cur) merged.push(cur);
      cur = { ...t };
    }
    if (cur) merged.push(cur);
  }
  merged.sort((x, y) => y.date.localeCompare(x.date) || x.id.localeCompare(y.id));
  return { trades: merged, skipped, goodDates: good.map(g => g.date) };
}

/* ── 報價 ─────────────────────────────────────────────────────────── */
function normalizeMetaCcy(cur: string): { ccy: string | null; minor: boolean } {
  const c = (cur || '').trim();
  if (!c) return { ccy: null, minor: false };
  if (/^GB[pX]$/i.test(c)) return { ccy: 'GBP', minor: true };
  if (/^ZA[cC]$/.test(c)) return { ccy: 'ZAR', minor: true };
  if (/^ILA$/i.test(c)) return { ccy: 'ILS', minor: true };
  const up = c.toUpperCase();
  return /^[A-Z]{3}$/.test(up) ? { ccy: up, minor: false } : { ccy: null, minor: false };
}

/** 逐日曆日前向填補（YYYY/MM/DD）。 */
function ffill(raw: Map<string, number>, start: string, end: string): Map<string, number> {
  const out = new Map<string, number>();
  let last: number | null = null;
  // 種子：起日之前最後一筆
  for (const k of [...raw.keys()].sort()) { if (k < start) last = raw.get(k)!; else break; }
  for (let d = start; d <= end; d = addDaysSlash(d, 1)) {
    if (raw.has(d)) last = raw.get(d)!;
    if (last !== null) out.set(d, last);
  }
  return out;
}

/* ── 產業分類：先用內建海外族群（科技股為主，名稱去掉括號英文），沒有的再問 Yahoo 的 sector ── */
const groupOfCode = new Map<string, string>();
for (const g of BUILTIN_GROUPS_OVERSEAS) for (const c of g.codes) {
  const k = canonicalCode(c).toUpperCase();
  if (!groupOfCode.has(k)) groupOfCode.set(k, g.name.replace(/\s*[(（].*$/, '').trim());
}
const YAHOO_SECTOR_ZH: Record<string, string> = {
  'Technology': '其他科技', 'Communication Services': '通訊與媒體', 'Consumer Cyclical': '非必需消費',
  'Consumer Defensive': '必需消費', 'Healthcare': '醫療保健', 'Financial Services': '金融',
  'Industrials': '工業', 'Energy': '能源', 'Basic Materials': '原物料', 'Real Estate': '不動產',
  'Utilities': '公用事業',
};
const _sectorCache = new Map<string, string>();
export async function sectorOf(rawId: string): Promise<string> {
  const code = canonicalCode(stockidToYfTicker(rawId).ticker || rawId.trim()).toUpperCase();
  const builtin = groupOfCode.get(code) ?? groupOfCode.get(rawId.trim().split(/\s+/)[0].toUpperCase());
  if (builtin) return builtin;
  if (_sectorCache.has(rawId)) return _sectorCache.get(rawId)!;
  let out = '其他／未分類';
  const { yfTicker, fallback } = resolveYfTicker(rawId, false);
  for (const sym of [yfTicker, fallback].filter(Boolean) as string[]) {
    try {
      const q = await yf.quoteSummary(sym, { modules: ['assetProfile', 'quoteType'] }, { validateResult: false });
      const sec: string | undefined = q?.assetProfile?.sector;
      if (sec) { out = YAHOO_SECTOR_ZH[sec] ?? sec; break; }
      if (q?.quoteType?.quoteType === 'ETF') { out = 'ETF'; break; }
    } catch { /* 查不到就換下一個代號 */ }
  }
  _sectorCache.set(rawId, out);
  return out;
}

const BATCH = 8;
const TTL_MS = 10 * 60 * 1000;
const _cache = new Map<string, { ts: number; data: TradeFollowResult }>();

export function listTradeFollowFunds() {
  return OVERSEAS_FUNDS.map(f => ({ ticker: f.ticker, name: f.name }));
}

export async function computeTradeFollow(fund: string, start: string, end?: string): Promise<TradeFollowResult | { error: string }> {
  const cfg = OVERSEAS_FUNDS.find(f => f.ticker === fund.toUpperCase());
  if (!cfg) return { error: '請選擇清單內的海外主動式 ETF。' };
  const endIso = end || slashToIso(todayTW());
  if (endIso < start) return { error: '結束日不能早於起始日。' };
  const key = `${cfg.ticker}|${start}|${endIso}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;

  // 選股對帳單的平均成本報酬：與本頁的報價抓取並行（各自有快取）
  const scorecardP = computeScorecard(cfg.fundId).catch(() => null);
  const dayMap = await buildOverseasDayMap(cfg);
  const snaps = toSnapshots(dayMap);
  if (snaps.length < 2) return { error: `${cfg.ticker} 目前查不到足夠的逐日持股資料。` };
  const { trades: allTrades, skipped, goodDates } = detectTrades(snaps);
  const snapByDate = new Map(snaps.map(s => [s.date, s.snap]));

  // ── 目前配置：最新 vs 約 20 份持股前 ──
  const asOf = goodDates[goodDates.length - 1];
  const prevDate = goodDates[Math.max(0, goodDates.length - 1 - 20)];
  const latest = snapByDate.get(asOf)!;
  const prevSnap = snapByDate.get(prevDate)!;
  const allocation: AllocationRow[] = [...latest.entries()]
    .map(([id, p]) => ({ id, rawId: p.raw, name: p.name, weight: p.w, weightPrev: prevSnap.get(id)?.w ?? 0, isNew: !prevSnap.has(id) }))
    .sort((x, y) => y.weight - x.weight);
  const exitedRecently: AllocationRow[] = [...prevSnap.entries()]
    .filter(([id]) => !latest.has(id))
    .map(([id, p]) => ({ id, rawId: p.raw, name: p.name, weight: 0, weightPrev: p.w, isNew: false }))
    .sort((x, y) => y.weightPrev - x.weightPrev);

  // ── 區間內的換股 ──
  const s = isoToSlash(start), e = isoToSlash(endIso);
  const trades = allTrades.filter(t => t.date >= s && t.date <= e);
  const base: Omit<TradeFollowResult, 'trades' | 'unpriced'> = {
    fund: cfg.ticker, fundName: cfg.name, start, end: endIso, asOf: slashToIso(asOf),
    allocPrevDate: slashToIso(prevDate), holdingsCount: latest.size, allocation, exitedRecently,
    skippedDates: skipped.map(slashToIso),
    recentDates: goodDates.slice(-20).reverse().map(slashToIso),
    sectors: {},
    costReturn: {},
  };
  // 近 20 份持股內有換股的股票 → 產業
  const recentFrom = goodDates[Math.max(0, goodDates.length - 20)];
  const recentIds = new Map<string, string>();
  for (const t of allTrades) if (t.date >= recentFrom) recentIds.set(t.id, t.rawId);
  const recentEntries = [...recentIds.entries()];
  for (let i = 0; i < recentEntries.length; i += BATCH) {
    await Promise.all(recentEntries.slice(i, i + BATCH).map(async ([id, raw]) => { base.sectors[id] = await sectorOf(raw); }));
  }
  if (trades.length === 0) {
    const data = { ...base, trades: [], unpriced: [] };
    _cache.set(key, { ts: Date.now(), data });
    return data;
  }

  // ── 報價：基金本身（交易日曆＋相對報酬基準）──
  const today = todayTW();
  const earliest = trades.reduce((m, t) => (t.date < m ? t.date : m), trades[0].date);
  const from = new Date(slashToIso(addDaysSlash(earliest, -10)) + 'T00:00:00Z');
  const to = new Date(slashToIso(addDaysSlash(today, 1)) + 'T00:00:00Z');
  const fundYf = PEER_GROUPS.overseas.items.find(i => i.ticker === cfg.ticker)?.yfTicker ?? `${cfg.ticker}.TW`;
  const fundSeries = await fetchTotalReturnSeries(fundYf, from, to);
  if (!fundSeries.bars.length) return { error: `抓不到 ${cfg.ticker} 本身的市價（${fundYf}），暫時無法計算換股後表現。` };
  const calendar = fundSeries.bars.map(b => b.date);                       // 台股交易日
  const fundPx = new Map(fundSeries.bars.map(b => [b.date, b.adj]));
  const lastCal = calendar[calendar.length - 1];

  // ── 報價：個股（新台幣計）──
  const ids = [...new Set(trades.map(t => t.id))];
  const rawOf = new Map(trades.map(t => [t.id, t.rawId]));
  const twdPx = new Map<string, Map<string, number>>();   // id → 日曆日 → 新台幣還原價
  const unpriced: string[] = [];
  const fxCache = new Map<string, Promise<Map<string, number>>>();
  const fx = (ccy: string) => {
    if (!fxCache.has(ccy)) fxCache.set(ccy, fetchFxSeries(ccy, from, to).catch(() => new Map<string, number>()));
    return fxCache.get(ccy)!;
  };
  const firstDay = addDaysSlash(earliest, -10);
  for (let i = 0; i < ids.length; i += BATCH) {
    await Promise.all(ids.slice(i, i + BATCH).map(async (id) => {
      const raw = rawOf.get(id)!;
      const { yfTicker, fallback } = resolveYfTicker(raw, false);
      let ccy = currencyForStockid(raw);
      if (!yfTicker) { unpriced.push(raw); return; }
      const series = await fetchTotalReturnSeries(yfTicker, from, to, fallback).catch(() => ({ currency: null, bars: [] }));
      if (!series.bars.length) { unpriced.push(raw); return; }
      const meta = normalizeMetaCcy(series.currency ?? '');
      if (meta.ccy) ccy = meta.ccy;
      if (!ccy) { unpriced.push(raw); return; }
      const fm = await fx(ccy);
      if (!fm.size) { unpriced.push(raw); return; }
      const px = ffill(new Map(series.bars.map(b => [b.date, b.adj])), firstDay, today);
      const out = new Map<string, number>();
      for (const [d, p] of px) { const f = fm.get(d); if (f != null) out.set(d, p * f); }
      if (out.size) twdPx.set(id, out); else unpriced.push(raw);
    }));
  }

  // ── 逐筆計算 ──
  const pct = (a: number | undefined, b: number | undefined) =>
    a != null && b != null && b !== 0 ? (a / b - 1) * 100 : null;
  // 每檔股票的全部換股（不受查詢區間限制），用來找「下一次動作」
  const allByStock = new Map<string, DetectedTrade[]>();
  for (const x of allTrades) { const l = allByStock.get(x.id) ?? []; l.push(x); allByStock.set(x.id, l); }
  for (const l of allByStock.values()) l.sort((a, b) => a.date.localeCompare(b.date));
  const calIndexAtOrBefore = (d: string) => {
    let k = -1;
    for (let i = 0; i < calendar.length; i++) { if (calendar[i] <= d) k = i; else break; }
    return k;
  };

  const results: TradeResult[] = trades.map((t) => {
    const series = twdPx.get(t.id);
    const ret: Record<string, number | null> = {};
    const rel: Record<string, number | null> = {};
    // 換股日在台股交易日曆上的位置（公布日當天或之前最後一個交易日）
    const i0 = calIndexAtOrBefore(t.date);
    const d0 = i0 >= 0 ? calendar[i0] : null;
    const opp = (allByStock.get(t.id) ?? []).find(x => x.date > t.endDate) ?? null;
    let segDate: string | null = null;
    if (d0) {
      const j = opp ? calIndexAtOrBefore(opp.date) : calendar.length - 1;
      segDate = j > i0 ? calendar[j] : null;
    }
    const targets: [string, string | null][] = [
      ['seg', segDate],
      ...WINDOWS.map(n => [`d${n}`, d0 && i0 + n < calendar.length ? calendar[i0 + n] : null] as [string, string | null]),
      ['now', d0 && lastCal > d0 ? lastCal : null],
    ];
    for (const [k, d1] of targets) {
      if (!series || !d0 || !d1) { ret[k] = null; rel[k] = null; continue; }
      const r = pct(series.get(d1), series.get(d0));
      const f = pct(fundPx.get(d1), fundPx.get(d0));
      ret[k] = r;
      rel[k] = r != null && f != null ? r - f : null;
    }
    return {
      ...t, priced: !!series, ret, rel,
      nowDate: ret.now != null ? slashToIso(lastCal) : null,
      segEnd: segDate ? slashToIso(segDate) : null,
      segEndBy: opp ? opp.type : null,
    };
  });

  const sc = await scorecardP;
  if (sc) for (const p of sc.positions) {
    base.costReturn[canonOf(p.stockid)] = { ret: p.held ? p.returnUnreal : p.returnAll, held: p.held };
  }

  const warn: string[] = [];
  if (skipped.length) warn.push(`有 ${skipped.length} 天的持股資料疑似不完整（大量股票同時消失），已略過，不列入換股判斷。`);
  const data: TradeFollowResult = { ...base, trades: results, unpriced: [...new Set(unpriced)].sort(), warning: warn.join(' ') || undefined };
  _cache.set(key, { ts: Date.now(), data });
  return data;
}
