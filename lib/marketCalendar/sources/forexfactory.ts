import type { EventType } from '../types';
import { FF_TITLE_TO_TYPE } from '../config';
import { fetchJson } from './http';

interface FfRow { title: string; country: string; date: string; impact: string; forecast: string; previous: string }

export interface FfEntry {
  type: EventType;
  label: string;
  etDate: string;            // 美東日期 YYYY-MM-DD
  iso: string;               // UTC 時間
  forecast: string | null;
  previous: string | null;
}

const FEEDS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
];

/* ForexFactory 公開週曆：只有本週（下週檔不一定存在），日期帶美東時區偏移，如 2026-09-22T08:30:00-04:00 */
export async function fetchFfConsensus(): Promise<FfEntry[]> {
  const results = await Promise.allSettled(FEEDS.map(u => fetchJson<FfRow[]>(u)));
  if (results[0].status === 'rejected') throw results[0].reason;
  const rows = results.flatMap(r => (r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : []));
  const out: FfEntry[] = [];
  for (const r of rows) {
    if (r.country !== 'USD') continue;
    const type = FF_TITLE_TO_TYPE[r.title];
    if (!type) continue;
    out.push({
      type, label: r.title, etDate: r.date.slice(0, 10), iso: new Date(r.date).toISOString(),
      forecast: r.forecast || null, previous: r.previous || null,
    });
  }
  return out;
}
