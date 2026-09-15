/**
 * 海外主動式 ETF 的「績效差異歸因」——把兩檔基金一段期間的報酬差距拆到每一檔（外國）個股。
 *
 *   R_A − R_B = Σ_t Σ_i ( w^A_{i,t-1} − w^B_{i,t-1} ) · r_{i,t}(TWD)
 *
 * 與國內版 lib/attribution.ts 的差別只在資料層：
 *   - 持股：本 repo 的 data/holdings/{fundId}.json（git 當資料庫）＋ CMoney / 復華 API 即時補當日
 *   - 股價：Yahoo Finance 還原收盤（含息）／原始收盤（純價差）
 *   - 換匯：lib/fx.ts 把各持股當地幣別報酬換算成新台幣（基金 NAV 計價幣別）
 *       r_{i,t}(TWD) = (px_t / px_{t-1}) · (fx_t / fx_{t-1}) − 1
 *
 * 逐日主迴圈（快照日聯集、前一日權重帶入避免 look-ahead、幾何複利、逐檔 gap/contribA/contribB、
 * 缺報價前向填補、尾端缺報價自動截短並附警告）是 lib/attribution.ts 的忠實移植。
 */
import { OVERSEAS_FUNDS, OverseasFundConfig } from './overseasFunds';
import { loadStoredHoldings } from './holdingsStore';
import { fetchCmoneyHoldings } from './cmoneyHoldings';
import { fetchHoldings } from './fhtrust';
import { resolveYfTicker } from './exchangeMap';
import { fetchTotalReturnSeries } from './yahooFinance';
import { currencyForStockid, fetchFxSeries } from './fx';
import { Holding } from './types';

const BATCH = 8;

/* ── 日期工具（對齊 lib/stockTrajectory.ts）───────────────────────── */
function toMs(s: string): number { return new Date(s.replace(/\//g, '-')).getTime(); }
function fmtSlash(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr.replace(/\//g, '-'));
  d.setDate(d.getDate() + n);
  return fmtSlash(d);
}
function todayTW(): string {
  const tw = new Date(Date.now() + 8 * 3600 * 1000);
  return `${tw.getUTCFullYear()}/${String(tw.getUTCMonth() + 1).padStart(2, '0')}/${String(tw.getUTCDate()).padStart(2, '0')}`;
}
function weekdaysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start;
  const endMs = toMs(end);
  while (toMs(cur) <= endMs && out.length < 60) {
    const dow = new Date(cur.replace(/\//g, '-')).getDay();
    if (dow !== 0 && dow !== 6) out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}
const isoToSlash = (s: string) => s.replace(/-/g, '/');
const slashToIso = (s: string) => s.replace(/\//g, '-');

/* ── 現金/期貨/其他資產列過濾（合併 consensusOverseas.isCashLike + cmoneyHoldings.isCashRow）── */
export function isCashLike(stockid: string, stockname: string, ftype?: string): boolean {
  if (ftype === '期貨' || ftype === '其他資產' || ftype === '現金') return true;
  if (!stockid.trim()) return true;
  if (/_(NTD|USD|TWD|HKD|JPY|EUR|RMB|CNY)\d*$/i.test(stockid)) return true;
  return /^(CASH|現金|TWD|NTD)$|現金|存款|期貨|AFTER DEDUCTING/i.test(stockname.trim());
}

/* 同一檔個股在兩檔基金的持股表可能寫成不同的彭博後綴（例：三星電機 '009150 KP' vs '009150 KS'、
   英飛凌 'IFX GR' vs 'IFX GY'、輝達 'NVDA US' vs 裸 'NVDA'）——一律收斂成「解析後的 Yahoo 代號」
   當統一 key，否則會被當兩檔、差距互相抵消還各自出現在領先/落後表。比照 consensusOverseas.ts。 */
export function canonOf(stockid: string): string {
  const { yfTicker } = resolveYfTicker(stockid, false);
  return (yfTicker || stockid).trim().toUpperCase();
}

/* ── 前向填補（slash 日期字串版；會用區間起日「之前」最後一筆當種子）── */
function forwardFillMap(raw: Map<string, number>, start: string, end: string): Map<string, number> {
  const filled = new Map<string, number>();
  if (raw.size === 0) return filled;
  const keys = [...raw.keys()].sort();
  let last: number | null = null;
  for (const k of keys) { if (k < start) last = raw.get(k)!; else break; }
  let cur = start;
  const endMs = toMs(end);
  while (toMs(cur) <= endMs) {
    if (raw.has(cur)) last = raw.get(cur)!;
    if (last !== null) filled.set(cur, last);
    cur = addDays(cur, 1);
  }
  return filled;
}

/* ── 某基金「逐交易日持股」對照表：先讀 git 存檔，再即時補到今天 ──
   export：也給 lib/usImpact.ts（美股收盤影響）取用最新一筆持股快照，避免重複實作抓取邏輯。 */
export async function buildOverseasDayMap(cfg: OverseasFundConfig): Promise<Map<string, Holding[]>> {
  const dayMap = new Map<string, Holding[]>();
  const stored = loadStoredHoldings(cfg.fundId);
  if (stored) {
    for (const [date, recs] of Object.entries(stored.days)) {
      dayMap.set(date, recs.map((r) => ({
        stockid: r.c,
        stockname: stored.names[r.c] ?? '',
        qshare: r.q,
        mvalue: r.m,
        prate_addaccint: r.p,
        country: '',
        ftype: '',
      })));
    }
  }

  if (cfg.source === 'cmoney') {
    // CMoney 一次回整段逐日歷史；有存檔只補近端 20 天，無存檔抓 400 天全歷史。
    const live = await fetchCmoneyHoldings(cfg.fundId, dayMap.size > 0 ? 20 : 400).catch(
      () => new Map<string, Holding[]>(),
    );
    for (const [date, holdings] of live) dayMap.set(date, holdings);
  } else {
    // 復華 fhtrust：只即時補「最後存檔日之後」到今天（通常 0–數天）。
    const end = todayTW();
    const lastStored = [...dayMap.keys()].sort().pop();
    const from = lastStored ? addDays(lastStored, 1) : addDays(end, -35);
    const dates = weekdaysBetween(from, end);
    for (let i = 0; i < dates.length; i += BATCH) {
      const chunk = dates.slice(i, i + BATCH);
      const res = await Promise.all(
        chunk.map((d) =>
          fetchHoldings(d, cfg.fundId)
            .then((r) => ({ date: r.date, holdings: r.holdings }))
            .catch(() => null),
        ),
      );
      for (const r of res) if (r) dayMap.set(r.date, r.holdings);
    }
  }
  return dayMap;
}

/* ── 型別 ─────────────────────────────────────────────────────────── */
export interface OverseasFundOption { ticker: string; name: string }

export interface OStockAttr {
  stockid: string; name: string;
  gap: number; ca: number; cb: number;
  avgA: number; avgB: number; sret: number;
  ccy: string; ticker: string;
}
export interface OExcluded {
  stockid: string; name: string; weightA: number; weightB: number; reason: string;
}
export interface OverseasAttrResult {
  fundA: string; fundB: string; fundAName: string; fundBName: string;
  start: string; end: string; days: number; totalReturn: boolean;
  retA_geo: number; retA_arith: number;
  retB_geo: number; retB_arith: number;
  gap_geo: number; gap_arith: number;
  check: number; stocks: OStockAttr[];
  warning?: string; requestedEnd: string;
  asOfA: string; asOfB: string; effectiveStart: string;
  coverageA: number; coverageB: number;
  excludedWeightA: number; excludedWeightB: number;
  cashResidualA: number; cashResidualB: number;
  excluded: OExcluded[];
  fxNote?: string;
}

/** 可比較的海外主動式 ETF 清單（給下拉選單）。 */
export function listOverseasFunds(): OverseasFundOption[] {
  return OVERSEAS_FUNDS.map((f) => ({ ticker: f.ticker, name: f.name }));
}

/* ── 把 dayMap 收成 date → (canonId → 權重)，並蒐集名稱與「代表性原始代號」（給解析/顯示用）── */
function buildWeights(m: Map<string, Holding[]>, startSlash: string, endSlash: string) {
  const byDate = new Map<string, Map<string, number>>();
  const names = new Map<string, string>();
  const rawById = new Map<string, string>();   // canonId → 首次見到的原始 stockid
  for (const [date, holds] of m) {
    if (date < startSlash || date > endSlash) continue;
    const dm = new Map<string, number>();
    for (const h of holds) {
      if (isCashLike(h.stockid, h.stockname, h.ftype)) continue;
      const id = canonOf(h.stockid);
      const w = (Number(h.prate_addaccint) || 0) / 100;
      dm.set(id, (dm.get(id) ?? 0) + w); // 同檔分批進場 / 不同後綴 → 權重相加
      if (h.stockname && !names.has(id)) names.set(id, h.stockname);
      if (!rawById.has(id)) rawById.set(id, h.stockid.trim());
    }
    if (dm.size) byDate.set(date, dm);
  }
  return { byDate, names, rawById };
}

function avgWeight(byDate: Map<string, Map<string, number>>, sid: string): number {
  if (byDate.size === 0) return 0;
  let s = 0;
  for (const dm of byDate.values()) s += dm.get(sid) ?? 0;
  return s / byDate.size;
}
function meanCashResidual(byDate: Map<string, Map<string, number>>): number {
  if (byDate.size === 0) return 0;
  let s = 0;
  for (const dm of byDate.values()) {
    let w = 0;
    for (const v of dm.values()) w += v;
    s += Math.max(0, 1 - w);
  }
  return s / byDate.size;
}

// Yahoo meta.currency → ISO（便士/分類單位收斂到主幣別）。認不得就回 null，維持後綴猜測。
function normalizeMetaCcy(cur: string): { ccy: string | null; minor: boolean } {
  const c = (cur || '').trim();
  if (!c) return { ccy: null, minor: false };
  if (/^GB[pX]$/i.test(c)) return { ccy: 'GBP', minor: true };
  if (/^ZA[cC]$/.test(c)) return { ccy: 'ZAR', minor: true };
  if (/^ILA$/i.test(c)) return { ccy: 'ILS', minor: true };
  const up = c.toUpperCase();
  return /^[A-Z]{3}$/.test(up) ? { ccy: up, minor: false } : { ccy: null, minor: false };
}

interface Resolved { yfTicker: string; fallback?: string; ccy: string; scale: number }

export async function computeOverseas(
  fundA: string, fundB: string, start: string,
  totalReturn = false, end?: string,
): Promise<OverseasAttrResult | { error: string }> {
  const A = OVERSEAS_FUNDS.find((f) => f.ticker === fundA.toUpperCase());
  const B = OVERSEAS_FUNDS.find((f) => f.ticker === fundB.toUpperCase());
  if (!A || !B) return { error: '請選擇兩檔清單內的海外主動式 ETF。' };
  if (A.ticker === B.ticker) return { error: '請選擇兩檔不同的基金。' };

  const startD = start;
  const endD = end || slashToIso(todayTW());
  if (endD < startD) return { error: '結束日不能早於起始日。' };
  const startSlash = isoToSlash(startD);
  const endSlash = isoToSlash(endD);

  const [mapA, mapB] = await Promise.all([buildOverseasDayMap(A), buildOverseasDayMap(B)]);

  const wA = buildWeights(mapA, startSlash, endSlash);
  const wB = buildWeights(mapB, startSlash, endSlash);
  if (wA.byDate.size === 0 || wB.byDate.size === 0) {
    return { error: `查無 ${!wA.byDate.size ? A.ticker : B.ticker} 在此區間的持股快照（可能該基金較晚成立或尚未公布逐日持股）。` };
  }
  const names = new Map<string, string>([...wA.names, ...wB.names]);
  const rawById = new Map<string, string>([...wB.rawById, ...wA.rawById]); // A 優先
  const showId = (id: string) => rawById.get(id) ?? id;

  const asOfA = [...wA.byDate.keys()].sort().pop() ?? '';
  const asOfB = [...wB.byDate.keys()].sort().pop() ?? '';

  const dates = [...new Set([...wA.byDate.keys(), ...wB.byDate.keys()])].sort();
  if (dates.length < 2) return { error: '期間內持股快照不足 2 天。' };
  const firstA = dates.find((d) => wA.byDate.has(d));
  const firstB = dates.find((d) => wB.byDate.has(d));
  const effectiveStart = firstA && firstB ? (firstA > firstB ? firstA : firstB) : dates[0];

  // ── 個股宇宙 → 解析 Yahoo 代號 + 幣別 ──
  const sids = new Set<string>();
  for (const dm of wA.byDate.values()) for (const s of dm.keys()) sids.add(s);
  for (const dm of wB.byDate.values()) for (const s of dm.keys()) sids.add(s);

  const resolved = new Map<string, Resolved>();
  const excludedReason = new Map<string, string>();
  for (const sid of sids) {
    const raw = showId(sid);   // 用原始彭博代號解析（canon 已丟失後綴，無法判幣別）
    const { yfTicker, fallback } = resolveYfTicker(raw, false);
    const ccy = currencyForStockid(raw);
    if (!yfTicker) { excludedReason.set(sid, '無法對應 Yahoo 代號'); continue; }
    if (!ccy) { excludedReason.set(sid, '幣別未知'); continue; }
    resolved.set(sid, { yfTicker, fallback, ccy, scale: 1 });
  }

  // ── 抓每檔還原/原始收盤序列（一次呼叫兩者都拿），順便用 meta.currency 校正幣別 ──
  const from = new Date(startSlash.replace(/\//g, '-')); from.setDate(from.getDate() - 7);
  const to = new Date(endSlash.replace(/\//g, '-'));
  const priceAdj = new Map<string, Map<string, number>>();
  const priceRaw = new Map<string, Map<string, number>>();
  let fxNote = '';

  const entries = [...resolved.entries()];
  for (let i = 0; i < entries.length; i += BATCH) {
    const chunk = entries.slice(i, i + BATCH);
    const results = await Promise.all(
      chunk.map(([sid, r]) =>
        fetchTotalReturnSeries(r.yfTicker, from, to, r.fallback).then((s) => ({ sid, r, s })),
      ),
    );
    for (const { sid, r, s } of results) {
      if (!s.bars.length) { excludedReason.set(sid, 'Yahoo 無報價'); resolved.delete(sid); continue; }
      const meta = normalizeMetaCcy(s.currency ?? '');
      if (meta.ccy) r.ccy = meta.ccy;
      if (meta.minor) {
        r.scale = 0.01;
        if (!fxNote) fxNote = '部分持股 Yahoo 以「便士/分」計價，已換算為主幣別（不影響報酬比率）。';
      }
      // 結算時差註記：這些 ETF 在台股盤中(13:30)定價，歐美持股當下只有「前一交易日」收盤、
      // 亞股約當日——即各持股的日報酬相對台股收盤有不同的時間錯位。實測「把歐美序列往後推
      // 一日對齊」反而讓兩檔基金因台股/歐美占比不同而產生「差別化」的窗口位移，汙染 gap（本
      // 工具的重點）。故一律用各持股當日收盤、不做落後對齊：時差偏誤對兩檔是共模的，相減後
      // 大致抵消；但「基金層總報酬」對照券商/Yahoo 的 ETF 市價會有數 pp 落差（見 UI 註腳）。
      const am = new Map<string, number>();
      const rm = new Map<string, number>();
      for (const b of s.bars) { am.set(b.date, b.adj); rm.set(b.date, b.raw); }
      priceAdj.set(sid, forwardFillMap(am, startSlash, endSlash));
      priceRaw.set(sid, forwardFillMap(rm, startSlash, endSlash));
    }
  }

  // ── 匯率序列（只抓有用到的幣別；抓不到 → 該幣別持股全排除）──
  const ccySet = new Set<string>();
  for (const r of resolved.values()) ccySet.add(r.ccy);
  const fxMap = new Map<string, Map<string, number>>();
  await Promise.all(
    [...ccySet].map(async (c) => { fxMap.set(c, await fetchFxSeries(c, from, to).catch(() => new Map())); }),
  );
  for (const [sid, r] of [...resolved.entries()]) {
    const fm = fxMap.get(r.ccy);
    if (!fm || fm.size === 0) { excludedReason.set(sid, '匯率無法取得'); resolved.delete(sid); }
  }

  // ── 逐日累加（移植 lib/attribution.ts）──
  const gap = new Map<string, number>();
  const contribA = new Map<string, number>();
  const contribB = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

  let retA = 0, retB = 0, compA = 1, compB = 1;
  let lastA = new Map(wA.byDate.get(dates[0]) ?? []);
  let lastB = new Map(wB.byDate.get(dates[0]) ?? []);
  let prev = dates[0];
  let lastPriced = '';

  for (let i = 1; i < dates.length; i++) {
    const d = dates[i];
    let dayA = 0, dayB = 0, priced = false;
    const universe = new Set([...lastA.keys(), ...lastB.keys()]);
    for (const sid of universe) {
      const r = resolved.get(sid);
      if (!r) continue;
      const pxMap = totalReturn ? priceAdj.get(sid) : priceRaw.get(sid);
      const fm = fxMap.get(r.ccy);
      if (!pxMap || !fm) continue;
      const p0 = pxMap.get(prev), p1 = pxMap.get(d);
      const f0 = fm.get(prev), f1 = fm.get(d);
      if (p0 == null || p1 == null || f0 == null || f1 == null || p0 === 0 || f0 === 0) continue;
      priced = true;
      const ret = (p1 / p0) * (f1 / f0) - 1;
      const wa = lastA.get(sid) ?? 0;
      const wb = lastB.get(sid) ?? 0;
      dayA += wa * ret; dayB += wb * ret;
      add(gap, sid, (wa - wb) * ret);
      add(contribA, sid, wa * ret);
      add(contribB, sid, wb * ret);
    }
    retA += dayA; retB += dayB; compA *= 1 + dayA; compB *= 1 + dayB;
    if (priced) lastPriced = d;
    if (wA.byDate.has(d)) lastA = new Map(wA.byDate.get(d)!);
    if (wB.byDate.has(d)) lastB = new Map(wB.byDate.get(d)!);
    prev = d;
  }

  const requestedEnd = dates[dates.length - 1];
  if (!lastPriced) {
    return { error: `此區間（${slashToIso(dates[0])} → ${slashToIso(requestedEnd)}）查無可用個股報價，無法計算。可能報價尚未更新，或持股代號無法對應 Yahoo。` };
  }

  const warnParts: string[] = [];
  if (lastPriced !== requestedEnd) {
    warnParts.push(`報價僅更新至 ${slashToIso(lastPriced)}，${slashToIso(requestedEnd)} 之前部分交易日尚無報價；結果已自動截短至 ${slashToIso(lastPriced)}。`);
  }
  if (asOfA && asOfB && asOfA !== asOfB) {
    warnParts.push(`兩檔持股公布日不同（${A.ticker} 至 ${slashToIso(asOfA)}、${B.ticker} 至 ${slashToIso(asOfB)}），較舊一方權重以最後公布日沿用。`);
  }
  if (effectiveStart !== dates[0]) {
    warnParts.push(`部分基金較晚才開始公布持股，實際比較自 ${slashToIso(effectiveStart)} 起算。`);
  }
  const nDays = dates.indexOf(lastPriced) + 1;
  if (nDays < 5) {
    warnParts.push('區間過短，跨市場交易日對齊誤差占比較高，數字僅供概略參考。');
  }
  const cashA = meanCashResidual(wA.byDate);
  const cashB = meanCashResidual(wB.byDate);
  if (Math.max(cashA, cashB) > 0.15) {
    const hi = cashA > cashB ? A.ticker : B.ticker;
    warnParts.push(`${hi} 期間內平均現金部位偏高（約 ${((cashA > cashB ? cashA : cashB) * 100).toFixed(0)}%，多為新掛牌建倉期），該基金區間報酬與差距僅涵蓋已建倉部分。`);
  }

  // ── 逐檔列 ──
  const spanReturn = (sid: string): number => {
    const pm = priceAdj.get(sid);
    const r = resolved.get(sid);
    const fm = r ? fxMap.get(r.ccy) : undefined;
    if (!pm || !fm || pm.size < 2) return 0;
    const ds = [...pm.keys()].filter((x) => fm.has(x)).sort();
    if (ds.length < 2) return 0;
    const p0 = pm.get(ds[0])!, p1 = pm.get(ds[ds.length - 1])!;
    const g0 = fm.get(ds[0])!, g1 = fm.get(ds[ds.length - 1])!;
    return p0 && g0 ? (p1 * g1) / (p0 * g0) - 1 : 0;
  };

  const stocks: OStockAttr[] = [];
  for (const sid of new Set([...gap.keys(), ...contribA.keys(), ...contribB.keys()])) {
    const r = resolved.get(sid);
    stocks.push({
      stockid: showId(sid),
      name: names.get(sid) ?? '',
      gap: gap.get(sid) ?? 0,
      ca: contribA.get(sid) ?? 0,
      cb: contribB.get(sid) ?? 0,
      avgA: avgWeight(wA.byDate, sid),
      avgB: avgWeight(wB.byDate, sid),
      sret: spanReturn(sid),
      ccy: r?.ccy ?? currencyForStockid(showId(sid)) ?? '',
      ticker: r?.yfTicker ?? '',
    });
  }
  stocks.sort((x, y) => y.gap - x.gap);

  // ── 涵蓋率 / 排除清單 ──
  let coverageA = 0, coverageB = 0, excludedWeightA = 0, excludedWeightB = 0;
  const excluded: OExcluded[] = [];
  for (const sid of sids) {
    const wa = avgWeight(wA.byDate, sid);
    const wb = avgWeight(wB.byDate, sid);
    if (resolved.has(sid)) { coverageA += wa; coverageB += wb; }
    else {
      excludedWeightA += wa; excludedWeightB += wb;
      if (wa > 0 || wb > 0) {
        excluded.push({ stockid: showId(sid), name: names.get(sid) ?? '', weightA: wa, weightB: wb, reason: excludedReason.get(sid) ?? '未涵蓋' });
      }
    }
  }
  excluded.sort((a, b) => (b.weightA + b.weightB) - (a.weightA + a.weightB));

  const check = [...gap.values()].reduce((s, v) => s + v, 0);

  return {
    fundA: A.ticker, fundB: B.ticker, fundAName: A.name, fundBName: B.name,
    start: slashToIso(dates[0]), end: slashToIso(lastPriced), days: nDays, totalReturn,
    retA_geo: compA - 1, retA_arith: retA,
    retB_geo: compB - 1, retB_arith: retB,
    gap_geo: (compA - 1) - (compB - 1), gap_arith: retA - retB,
    check, stocks,
    warning: warnParts.length ? warnParts.join(' ') : undefined,
    requestedEnd: slashToIso(requestedEnd),
    asOfA: slashToIso(asOfA), asOfB: slashToIso(asOfB), effectiveStart: slashToIso(effectiveStart),
    coverageA, coverageB, excludedWeightA, excludedWeightB,
    cashResidualA: cashA, cashResidualB: cashB,
    excluded, fxNote: fxNote || undefined,
  };
}
