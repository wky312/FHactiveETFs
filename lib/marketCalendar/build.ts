import type { MarketEvent, Metric, SourceStatus } from './types';
import { EARNINGS_WATCHLIST, FRED_RELEASES, HISTORY_START } from './config';
import { addDays, weekday, ymdInTz, zonedToIso } from './time';
import { fetchFomc } from './sources/fed';
import { fetchActuals, fetchFedFundsUpper, fetchReleaseDates } from './sources/fred';
import { fetchFfConsensus, type FfEntry } from './sources/forexfactory';
import { fetchEarnings } from './sources/yahooEarnings';
import { earningsEvent, earningsHistoryEvents, manualEvents } from './manual';

type Quote = { forecast: string | null; previous: string | null };

/* 跨次刷新累積的狀態：ForexFactory 只給本週預期值、FRED 實際值查過就不必再查 */
export interface CalendarState {
  consensus: Record<string, Record<string, Quote>>; // eventId → label → 預期/前值
  actuals: Record<string, Record<string, string>>;  // eventId → label → 實際值
  ffFetchedAt?: number;
}

const FF_MIN_INTERVAL_MS = 60 * 60_000;  // ForexFactory 對頻繁請求回 429，一小時抓一次就夠
const ACTUALS_PER_RUN = 12;               // FRED 每分鐘 120 次上限；首次回補分多次刷新完成

const NY = 'America/New_York';
const ACTUALS_LOOKBACK_DAYS = 190;  // 首次上線回補近半年實際值（FRED 每分鐘 120 次上限）
const ISM_LABELS = ['ISM Manufacturing PMI', 'ISM Manufacturing Prices'];

async function settle<T>(sources: Record<string, SourceStatus>, name: string, p: Promise<T>, count: (v: T) => number): Promise<T | null> {
  try {
    const v = await p;
    sources[name] = { ok: true, count: count(v) };
    return v;
  } catch (e) {
    sources[name] = { ok: false, count: 0, error: e instanceof Error ? e.message : String(e) };
    console.error(`[marketCalendar] ${name} failed:`, e);
    return null;
  }
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    for (let x = queue.shift(); x !== undefined; x = queue.shift()) await fn(x);
  }));
}

/* ISM 製造業 PMI：每月第一個營業日美東 10:00（避開元旦與勞動節） */
function ismDates(fromYmd: string, toYmd: string): string[] {
  const out: string[] = [];
  let [y, m] = fromYmd.split('-').map(Number);
  for (;;) {
    const first = `${y}-${String(m).padStart(2, '0')}-01`;
    if (first > toYmd) break;
    for (let d = 1; d <= 7; d++) {
      const ymd = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const wd = weekday(ymd);
      if (wd === 0 || wd === 6) continue;
      if (m === 1 && (d === 1 || (d === 2 && wd === 1))) continue; // 元旦（逢週日則週一補假）
      if (m === 9 && wd === 1) continue;                           // 勞動節＝九月第一個週一
      out.push(ymd);
      break;
    }
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

const etDate = (e: MarketEvent) => ymdInTz(Date.parse(e.start), NY);

export async function buildEvents(state: CalendarState, nowMs: number) {
  const sources: Record<string, SourceStatus> = {};
  const today = ymdInTz(nowMs, NY);

  const [fomc, fredDates, ff, earnings, fedFunds] = await Promise.all([
    settle(sources, 'Fed FOMC 行事曆', fetchFomc(), v => v.length),
    Promise.all(FRED_RELEASES.map(spec =>
      settle(sources, `FRED ${spec.title}`, fetchReleaseDates(spec, today), v => v.length).then(dates => ({ spec, dates })))),
    nowMs - (state.ffFetchedAt ?? 0) < FF_MIN_INTERVAL_MS
      ? Promise.resolve(null).then(() => { sources['ForexFactory 市場預期'] = { ok: true, count: 0, error: '一小時內已抓過，沿用累積資料' }; return null; })
      : settle(sources, 'ForexFactory 市場預期', fetchFfConsensus(), v => v.length).then(v => { if (v) state.ffFetchedAt = nowMs; return v; }),
    Promise.all(EARNINGS_WATCHLIST.map(spec =>
      settle(sources, `Yahoo ${spec.title}`, fetchEarnings(spec), v => (v.next ? 1 : 0)))),
    settle(sources, 'FRED 聯邦基金利率', fetchFedFundsUpper(addDays(today, -420)), v => v.size),
  ]);

  const byId = new Map<string, MarketEvent>();
  const put = (e: MarketEvent) => byId.set(e.id, { ...byId.get(e.id), ...e });

  for (const e of manualEvents()) put(e);
  for (const e of earningsHistoryEvents()) put(e);
  for (const e of fomc ?? []) put(e);

  for (const { spec, dates } of fredDates) {
    for (const d of dates ?? []) {
      const start = zonedToIso(d, '08:30', NY);
      put({
        id: `${spec.type}-${d}`, type: spec.type, category: 'macro', title: spec.title,
        start, date: d, allDay: false, importance: spec.importance, source: 'fred',
        historyKey: spec.type, reactionAt: start,
      });
    }
  }

  // ISM：規則推算，本週若 ForexFactory 有列出就以它的日期為準
  const ffIsm = (ff ?? []).filter(x => x.type === 'ism_mfg');
  const ffIsmMonths = new Map(ffIsm.map(x => [x.etDate.slice(0, 7), x.etDate]));
  for (const rule of ismDates(HISTORY_START, addDays(today, 400))) {
    const d = ffIsmMonths.get(rule.slice(0, 7)) ?? rule;
    const start = zonedToIso(d, '10:00', NY);
    const confirmed = d < today || ffIsmMonths.has(d.slice(0, 7));
    put({
      id: `ism_mfg-${d}`, type: 'ism_mfg', category: 'macro', title: 'ISM 製造業 PMI',
      start, date: d, allDay: false, importance: 3, source: confirmed && d >= today ? 'ff' : 'rule',
      historyKey: 'ism_mfg', reactionAt: start,
      tentative: !confirmed || undefined,
      note: confirmed ? undefined : '依「每月第一個營業日」慣例推算，實際日期以 ISM 公告為準。',
    });
  }

  for (const info of earnings) {
    if (!info) continue;
    if (info.lastCallDate) put(earningsEvent(info.spec, info.lastCallDate));
    if (info.next) {
      put(earningsEvent(info.spec, info.next.date, {
        source: 'yahoo', tentative: info.next.estimate || undefined,
        note: info.next.estimate ? 'Yahoo 預估日期，公司尚未正式公告。' : undefined,
        metrics: info.next.eps != null ? [{ label: 'EPS', forecast: info.next.eps.toFixed(2) }] : undefined,
      }));
    }
  }

  const all = [...byId.values()].sort((a, b) => a.start.localeCompare(b.start));

  mergeConsensus(state, all, ff ?? []);
  await fillFredActuals(state, all, today, nowMs, sources);
  fillFomcActuals(state, all, today, fedFunds);
  attachMetrics(state, all);

  return { events: all, sources };
}

function mergeConsensus(state: CalendarState, all: MarketEvent[], ff: FfEntry[]) {
  const index = new Map(all.map(e => [`${e.type}|${etDate(e)}`, e]));
  const ism = all.filter(e => e.type === 'ism_mfg');
  for (const x of ff) {
    const ev = index.get(`${x.type}|${x.etDate}`);
    if (!ev) continue;
    (state.consensus[ev.id] ??= {})[x.label] = { forecast: x.forecast, previous: x.previous };
    // ISM 沒有免費的實際值來源 → 用下一期公布時列出的「前值」回填上一期
    if (x.type === 'ism_mfg' && x.previous) {
      const i = ism.findIndex(e => e.id === ev.id);
      if (i > 0) (state.actuals[ism[i - 1].id] ??= {})[x.label] = x.previous;
    }
  }
}

async function fillFredActuals(state: CalendarState, all: MarketEvent[], today: string, nowMs: number, sources: Record<string, SourceStatus>) {
  const since = addDays(today, -ACTUALS_LOOKBACK_DAYS);
  const specOf = new Map(FRED_RELEASES.map(s => [s.type, s]));
  const todo = all.filter(e => {
    const spec = specOf.get(e.type as never);
    if (!spec || e.date < since) return false;
    if (Date.parse(e.start) + 10 * 60_000 > nowMs) return false;   // 公布 10 分鐘後 FRED 才有資料
    const have = state.actuals[e.id] ?? {};
    return spec.metrics.some(m => !have[m.label]);
  }).reverse().slice(0, ACTUALS_PER_RUN);   // 最近的優先
  let failed = 0;
  await pool(todo, 3, async e => {
    try {
      const got = await fetchActuals(specOf.get(e.type as never)!, e.date);
      if (Object.keys(got).length) state.actuals[e.id] = { ...state.actuals[e.id], ...got };
    } catch (err) {
      failed++;
      console.error(`[marketCalendar] FRED actual ${e.id}:`, err);
    }
  });
  sources['FRED 實際值'] = { ok: failed === 0, count: todo.length - failed, error: failed ? `${failed} 筆查詢失敗，下次刷新重試` : undefined };
}

function fillFomcActuals(state: CalendarState, all: MarketEvent[], today: string, fedFunds: Map<string, number> | null) {
  if (!fedFunds?.size) return;
  const dates = [...fedFunds.keys()].sort();
  for (const e of all) {
    if (e.type !== 'fomc' || e.date >= today) continue;
    const eff = dates.find(d => d > e.date);           // 決議隔天生效
    if (!eff || eff > addDays(e.date, 5)) continue;    // 超出資料區間的舊會議不猜
    (state.actuals[e.id] ??= {})['Federal Funds Rate'] = `${fedFunds.get(eff)!.toFixed(2)}%`;
  }
}

function attachMetrics(state: CalendarState, all: MarketEvent[]) {
  const specOf = new Map(FRED_RELEASES.map(s => [s.type, s]));
  const lastActual = new Map<string, Record<string, string>>(); // type → 上一期實際值（ForexFactory 前值出來前的替代）
  for (const e of all) {
    const prevActual = lastActual.get(e.type);
    lastActual.set(e.type, state.actuals[e.id] ?? {});   // 只取緊鄰上一期；上一期沒值就留空，不往前找
    const labels = new Set<string>();
    specOf.get(e.type as never)?.metrics.forEach(m => labels.add(m.label));
    if (e.type === 'ism_mfg') ISM_LABELS.forEach(l => labels.add(l));
    if (e.type === 'fomc') labels.add('Federal Funds Rate');
    Object.keys(state.consensus[e.id] ?? {}).forEach(l => labels.add(l));
    if (!labels.size) continue;
    const metrics: Metric[] = [...labels].map(label => ({
      label,
      forecast: state.consensus[e.id]?.[label]?.forecast ?? null,
      previous: state.consensus[e.id]?.[label]?.previous ?? prevActual?.[label] ?? null,
      actual: state.actuals[e.id]?.[label] ?? null,
    }));
    e.metrics = [...(e.metrics ?? []), ...metrics];
  }
}
