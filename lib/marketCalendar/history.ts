import type { MarketEvent, MarketReaction, MoveStats, ReactionSample, ReactionStats } from './types';
import { HISTORY_LABELS, HISTORY_START, REACTION_MARKETS, type ReactionMarket } from './config';
import { addDays, ymdInTz, zonedToUtcMs } from './time';
import { yf } from './sources/yahoo';

interface Series { market: ReactionMarket; closeMs: number[]; px: number[]; normalAbs: number }

const SAMPLE_LIMIT = 12;
const round2 = (x: number) => Math.round(x * 100) / 100;

async function loadSeries(market: ReactionMarket): Promise<Series> {
  const res = await yf.chart(market.symbol, { period1: addDays(HISTORY_START, -30), interval: '1d' });
  const closeMs: number[] = [];
  const px: number[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const q of (res?.quotes ?? []) as any[]) {
    const p = q.adjclose ?? q.adjClose ?? q.close;   // yahoo-finance2 還原價欄位是小寫 adjclose
    if (typeof p !== 'number' || !Number.isFinite(p)) continue;
    const day = ymdInTz(new Date(q.date).getTime(), market.tz);
    const ms = zonedToUtcMs(day, market.close, market.tz);
    if (closeMs.length && ms <= closeMs[closeMs.length - 1]) continue;
    closeMs.push(ms);
    px.push(p);
  }
  if (px.length < 100) throw new Error(`${market.symbol} 日K不足`);
  let sum = 0;
  for (let i = 1; i < px.length; i++) sum += Math.abs(px[i] / px[i - 1] - 1);
  return { market, closeMs, px, normalAbs: (sum / (px.length - 1)) * 100 };
}

/* 最後一個「收盤時間 ≤ 事件時間」的交易日 */
function baseIndex(closeMs: number[], t: number): number {
  let lo = 0, hi = closeMs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (closeMs[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function move(s: Series, t: number, k: number): number | null {
  const b = baseIndex(s.closeMs, t);
  if (b < 0 || b + k >= s.px.length) return null;
  return (s.px[b + k] / s.px[b] - 1) * 100;
}

function stats(xs: number[]): MoveStats {
  if (!xs.length) return { mean: NaN, median: NaN, upPct: NaN };
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return {
    mean: round2(xs.reduce((a, b) => a + b, 0) / xs.length),
    median: round2(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2),
    upPct: Math.round((xs.filter(x => x > 0).length / xs.length) * 100),
  };
}

export async function computeHistory(events: MarketEvent[], nowMs: number): Promise<Record<string, ReactionStats>> {
  const series = await Promise.all(REACTION_MARKETS.map(loadSeries));
  const past = events.filter(e => Date.parse(e.reactionAt) < nowMs && e.date >= HISTORY_START);
  const groups = new Map<string, MarketEvent[]>();
  for (const e of past) groups.set(e.historyKey, [...(groups.get(e.historyKey) ?? []), e]);

  const out: Record<string, ReactionStats> = {};
  for (const [key, evs] of groups) {
    const rows = evs.map(e => {
      const t = Date.parse(e.reactionAt);
      const moves: ReactionSample['moves'] = {};
      for (const s of series) {
        const t1 = move(s, t, 1), t5 = move(s, t, 5);
        moves[s.market.symbol] = { t1: t1 == null ? null : round2(t1), t5: t5 == null ? null : round2(t5) };
      }
      return { id: e.id, date: e.date, title: e.title, moves };
    });
    const markets: MarketReaction[] = series.map(s => {
      const t1 = rows.map(r => r.moves[s.market.symbol].t1).filter((x): x is number => x != null);
      const t5 = rows.map(r => r.moves[s.market.symbol].t5).filter((x): x is number => x != null);
      const absMean = t1.length ? t1.reduce((a, b) => a + Math.abs(b), 0) / t1.length : NaN;
      return {
        symbol: s.market.symbol, name: s.market.name, n: t1.length,
        t1: stats(t1), t5: stats(t5), volRatio: round2(absMean / s.normalAbs),
      };
    });
    const n = Math.max(0, ...markets.map(m => m.n));
    if (!n) continue;
    out[key] = {
      historyKey: key, label: HISTORY_LABELS[key] ?? key, n, markets,
      samples: rows.sort((a, b) => b.date.localeCompare(a.date)).slice(0, SAMPLE_LIMIT),
    };
  }
  return out;
}
