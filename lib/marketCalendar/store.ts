import { after } from 'next/server';
import { readPageCache, writePageCache } from '@/lib/pageCache';
import type { CalendarPayload, MarketEvent, ReactionStats, SourceStatus } from './types';
import { buildEvents, type CalendarState } from './build';
import { computeHistory } from './history';
import { addDays, ymdInTz } from './time';

/* 三份快取（本專案 Supabase page_cache）：
   - events：頁面/ics 直接讀（只存近 400 天起的事件，歷史樣本不必送前端）
   - state：跨次累積的市場預期與實際值（ForexFactory 只有本週，錯過就沒了）
   - history：歷史市場反應，約每週或有新樣本滿 T+5 時重算
   本機沒設 Supabase 時退回記憶體，行為相同只是不持久。 */
const K_EVENTS = 'market_calendar_events_v4';
const K_STATE = 'market_calendar_state_v1';
const K_HIST = 'market_calendar_history_v1';

const STALE_MS = 3 * 3600_000;
const HIST_STALE_MS = 7 * 86400_000;
const DISPLAY_LOOKBACK_DAYS = 400;

interface EventsCache { generatedAt: string; events: MarketEvent[]; sources: Record<string, SourceStatus> }
interface HistCache { generatedAt: string; stats: Record<string, ReactionStats> }

const mem = new Map<string, unknown>();
async function read<T>(k: string): Promise<T | null> {
  return (await readPageCache<T>(k)) ?? ((mem.get(k) as T | undefined) ?? null);
}
async function write<T>(k: string, v: T) {
  mem.set(k, v);
  await writePageCache(k, v);
}

let inflight: Promise<CalendarPayload> | null = null;

export function refresh(opts: { forceHistory?: boolean } = {}): Promise<CalendarPayload> {
  inflight ??= doRefresh(opts).finally(() => { inflight = null; });
  return inflight;
}

async function doRefresh({ forceHistory = false }: { forceHistory?: boolean }): Promise<CalendarPayload> {
  const now = Date.now();
  const state = (await read<CalendarState>(K_STATE)) ?? { consensus: {}, actuals: {} };
  const { events: all, sources } = await buildEvents(state, now);
  await write(K_STATE, state);

  const since = addDays(ymdInTz(now, 'Asia/Taipei'), -DISPLAY_LOOKBACK_DAYS);
  const ev: EventsCache = {
    generatedAt: new Date(now).toISOString(),
    events: all.filter(e => (e.endDate ?? e.date) >= since),
    sources,
  };

  let hist = await read<HistCache>(K_HIST);
  if (forceHistory || needsHistory(hist, all, now)) {
    try {
      hist = { generatedAt: new Date(now).toISOString(), stats: await computeHistory(all, now) };
      await write(K_HIST, hist);
      sources['歷史市場反應'] = { ok: true, count: Object.keys(hist.stats).length };
    } catch (e) {
      console.error('[marketCalendar] history failed:', e);
      sources['歷史市場反應'] = { ok: false, count: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }
  await write(K_EVENTS, ev);
  return toPayload(ev, hist);
}

/* 有樣本剛湊滿 T+5（約 8 個日曆天）就重算，否則每週一次 */
function needsHistory(hist: HistCache | null, all: MarketEvent[], now: number): boolean {
  if (!hist) return true;
  const gen = Date.parse(hist.generatedAt);
  if (now - gen > HIST_STALE_MS) return true;
  const settleMs = 8 * 86400_000;
  return all.some(e => {
    const done = Date.parse(e.reactionAt) + settleMs;
    return done > gen && done < now;
  });
}

function toPayload(ev: EventsCache, hist: HistCache | null): CalendarPayload {
  return {
    generatedAt: ev.generatedAt, events: ev.events, sources: ev.sources,
    history: hist?.stats ?? {}, historyGeneratedAt: hist?.generatedAt ?? null,
  };
}

/* 事件剛公布（36 小時內）而快取是公布前產生的 → 需要刷新以取得實際值 */
function isStale(ev: EventsCache, now: number): boolean {
  const gen = Date.parse(ev.generatedAt);
  if (now - gen > STALE_MS) return true;
  return ev.events.some(e => {
    if (e.allDay) return false;
    const t = Date.parse(e.start);
    return t < now - 15 * 60_000 && t > now - 36 * 3600_000 && gen < t + 15 * 60_000;
  });
}

export async function getCalendar(): Promise<CalendarPayload> {
  const ev = await read<EventsCache>(K_EVENTS);
  if (!ev) return refresh();
  if (isStale(ev, Date.now())) {
    after(() => refresh().catch(e => console.error('[marketCalendar] background refresh failed:', e)));
  }
  return toPayload(ev, await read<HistCache>(K_HIST));
}
