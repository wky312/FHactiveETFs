import raw from '@/config/market-events.json';
import type { Category, EventType, MarketEvent } from './types';
import { EARNINGS_WATCHLIST, type EarningsSpec } from './config';
import { zonedToIso } from './time';

interface ManualRow {
  id: string; type: string; category: string; title: string;
  date: string; endDate?: string; time?: string; tz: string;
  importance: number; historyKey: string; tentative?: boolean; note?: string;
}

export function manualEvents(): MarketEvent[] {
  return (raw.events as ManualRow[]).map(r => {
    const allDay = !r.time;
    const start = zonedToIso(r.date, r.time ?? '00:00', r.tz);
    return {
      id: r.id, type: r.type as EventType, category: r.category as Category, title: r.title,
      start, date: r.date, endDate: r.endDate, allDay,
      importance: r.importance as 1 | 2 | 3, tentative: r.tentative, source: 'manual',
      historyKey: r.historyKey,
      // 整天事件（選舉、會晤）以當地 20:00 當反應時點：台股看下一個交易日、美股選舉看開票後隔日
      reactionAt: allDay ? zonedToIso(r.date, '20:00', r.tz) : start,
      note: r.note,
    };
  });
}

export function earningsEvent(spec: EarningsSpec, date: string, extra: Partial<MarketEvent> = {}): MarketEvent {
  const start = zonedToIso(date, spec.time, spec.tz);
  return {
    id: `earn-${spec.key}-${date}`, type: 'earnings', category: 'earnings', title: spec.title,
    start, date, allDay: false, importance: 3, source: 'manual',
    historyKey: `earnings:${spec.key}`, reactionAt: start, symbol: spec.symbol,
    ...extra,
  };
}

export function earningsHistoryEvents(): MarketEvent[] {
  const hist = raw.earningsHistory as Record<string, string[]>;
  return EARNINGS_WATCHLIST.flatMap(spec => (hist[spec.key] ?? []).map(d => earningsEvent(spec, d)));
}
