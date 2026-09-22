import type { FredReleaseSpec, MetricKind } from '../config';
import { HISTORY_START } from '../config';
import { addDays } from '../time';
import { fetchJson } from './http';

const BASE = 'https://api.stlouisfed.org/fred';

function key(): string {
  const k = process.env.FRED_API_KEY?.trim().replace(/^"|"$/g, '');
  if (!k) throw new Error('未設定 FRED_API_KEY');
  return k;
}

interface Obs { date: string; value: string; realtime_start: string }

async function observations(series: string, params: Record<string, string>): Promise<Obs[]> {
  const qs = new URLSearchParams({ series_id: series, api_key: key(), file_type: 'json', ...params });
  const j = await fetchJson<{ observations?: Obs[]; error_message?: string }>(`${BASE}/series/observations?${qs}`);
  if (j.error_message) throw new Error(`FRED ${series}: ${j.error_message}`);
  return j.observations ?? [];
}

/* 歷史公布日 = 每筆觀測值「首次公布」的日期（output_type=4），比 release/dates 乾淨
   （後者混有季節因子修正等非例行日期）；未來排程則只有 release/dates 查得到。 */
export async function fetchReleaseDates(spec: FredReleaseSpec, todayYmd: string): Promise<string[]> {
  const [initial, future] = await Promise.all([
    observations(spec.datesSeries, {
      output_type: '4', realtime_start: '1776-07-04', realtime_end: '9999-12-31', observation_start: addDays(HISTORY_START, -45),
    }),
    fetchJson<{ release_dates?: { date: string }[] }>(`${BASE}/release/dates?${new URLSearchParams({
      release_id: String(spec.releaseId), api_key: key(), file_type: 'json',
      include_release_dates_with_no_data: 'true', realtime_start: addDays(todayYmd, -3), realtime_end: '9999-12-31',
      sort_order: 'asc', limit: '100',
    })}`),
  ]);
  const set = new Set<string>();
  for (const o of initial) if (o.realtime_start >= HISTORY_START) set.add(o.realtime_start);
  for (const d of future.release_dates ?? []) if (d.date >= todayYmd) set.add(d.date);
  return [...set].sort();
}

const vintageCache = new Map<string, Promise<Obs[]>>();

/* 公布當天那個版本（ALFRED vintage）的數列 —— 月增率要用「當時」的前值才會跟新聞報的一致 */
function vintage(series: string, releaseDate: string): Promise<Obs[]> {
  const k = `${series}@${releaseDate}`;
  if (!vintageCache.has(k)) {
    vintageCache.set(k, observations(series, {
      realtime_start: releaseDate, realtime_end: releaseDate,
      observation_start: addDays(releaseDate, -420), sort_order: 'desc', limit: '14',
    }).catch(e => { vintageCache.delete(k); throw e; }));
  }
  return vintageCache.get(k)!;
}

const monthsBack = (ymd: string, n: number) => {
  const [y, m] = ymd.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return d.toISOString().slice(0, 10);
};
const pct = (x: number) => {
  const s = (x * 100).toFixed(1);
  return `${s === '-0.0' ? '0.0' : s}%`;
};

/* 用日期對齊前期，不能用陣列位置：數列會有缺月（例：2025/10 政府關門 CPI 未公布） */
function fmt(kind: MetricKind, obs: Obs[]): string | null {
  if (!obs.length) return null;
  const byDate = new Map(obs.map(o => [o.date, Number(o.value)]));
  const cur = obs[0];
  const v0 = Number(cur.value);
  const prev = byDate.get(monthsBack(cur.date, 1));
  const yago = byDate.get(monthsBack(cur.date, 12));
  switch (kind) {
    case 'mom':   return prev ? pct(v0 / prev - 1) : null;
    case 'yoy':   return yago ? pct(v0 / yago - 1) : null;
    case 'diffK': return prev ? `${Math.round(v0 - prev)}K` : null;
    case 'level': return `${v0.toFixed(1)}%`;
  }
}

export async function fetchActuals(spec: FredReleaseSpec, releaseDate: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const m of spec.metrics) {
    const obs = (await vintage(m.series, releaseDate)).filter(o => o.value !== '.');
    const s = fmt(m.kind, obs);
    if (s) out[m.label] = s;
  }
  return out;
}

/* 聯邦基金利率目標區間上限（日資料）→ 各次 FOMC 會後生效的利率 */
export async function fetchFedFundsUpper(sinceYmd: string): Promise<Map<string, number>> {
  const obs = await observations('DFEDTARU', { observation_start: sinceYmd });
  return new Map(obs.filter(o => o.value !== '.').map(o => [o.date, Number(o.value)]));
}
