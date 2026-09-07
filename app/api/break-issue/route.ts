import { NextResponse } from 'next/server';
import {
  BREAK_ISSUE_FUNDS, BreakIssueFund, BreakIssueRow, BreakIssuePayload, BreakIssueStatus,
} from '@/lib/breakIssue';
import { readPageCache, writePageCache, taipeiDateStr } from '@/lib/pageCache';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const YahooFinance = require('yahoo-finance2').default;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yf: any = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CACHE_KEY = () => `break-issue:v1:${taipeiDateStr()}`;
const round2 = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number | null) => x == null ? null : Math.round(x * 10) / 10;

interface Bar { date: string; close: number; adj: number }

// 抓某標的日 K：同時取原始收盤 close（破發判定）與還原收盤 adjclose（報酬計算）。
async function fetchBars(yfTicker: string, from: Date): Promise<Bar[]> {
  const period2 = new Date(); period2.setDate(period2.getDate() + 1);
  const chart = await yf.chart(yfTicker, { period1: from, period2, interval: '1d' }, { validateResult: false });
  const out: Bar[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const q of (chart?.quotes ?? []) as any[]) {
    const close = q.close;
    const adj = q.adjClose ?? q.adjclose ?? q.close;   // adjclose 為小寫，務必容錯
    if (close == null || adj == null) continue;
    const d = new Date(q.date);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    out.push({ date: key, close, adj });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// 掛牌日 + N 個曆月後的第一個有資料日，對掛牌首日的還原報酬（先進位，對齊券商）。
function retAfterMonths(bars: Bar[], months: number): number | null {
  if (bars.length < 2) return null;
  const start = new Date(bars[0].date + 'T00:00:00Z');
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, start.getUTCDate()));
  const targetKey = `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(target.getUTCDate()).padStart(2, '0')}`;
  const hit = bars.find(b => b.date >= targetKey);
  if (!hit) return null;
  const base = round2(bars[0].adj);
  if (base === 0) return null;
  return (round2(hit.adj) - base) / base * 100;
}

function analyse(fund: BreakIssueFund, bars: Bar[]): BreakIssueRow {
  const issue = fund.issuePrice;
  const n = bars.length;
  const closes = bars.map(b => b.close);

  const day1Break = n > 0 && closes[0] < issue;

  let first10BreakDay: number | null = null;
  for (let i = 0; i < Math.min(10, n); i++) {
    if (closes[i] < issue) { first10BreakDay = i + 1; break; }
  }

  let firstBreakIdx = -1;
  for (let i = 0; i < n; i++) { if (closes[i] < issue) { firstBreakIdx = i; break; } }
  const firstBreakDate = firstBreakIdx >= 0 ? bars[firstBreakIdx].date : null;

  // 掛牌後前 20 個交易日的最低收盤
  const first20 = bars.slice(0, 20);
  let low20 = first20.length ? first20[0].close : (n ? closes[0] : issue);
  let low20Idx = 0;
  first20.forEach((b, i) => { if (b.close < low20) { low20 = b.close; low20Idx = i; } });

  // 首次破發後、首次收盤重新 >= 發行價
  let reclaimDate: string | null = null;
  let reclaimGap: number | null = null;
  let reclaimHeld = true;
  if (firstBreakIdx >= 0) {
    let reclaimIdx = -1;
    for (let i = firstBreakIdx; i < n; i++) { if (closes[i] >= issue) { reclaimIdx = i; break; } }
    if (reclaimIdx >= 0) {
      reclaimDate = bars[reclaimIdx].date;
      reclaimGap = reclaimIdx - firstBreakIdx;
      const tail = closes.slice(reclaimIdx);
      const aboveFrac = tail.filter(c => c >= issue).length / tail.length;
      reclaimHeld = aboveFrac > 0.55;
    } else {
      reclaimHeld = false;
    }
  }

  let status: BreakIssueStatus;
  if (firstBreakIdx < 0) status = 'never';
  else if (n > 0 && closes[n - 1] < issue) status = 'below';
  else status = 'above';

  return {
    ticker: fund.ticker,
    name: fund.name,
    issuer: fund.issuer,
    listDate: fund.listDate,
    issuePrice: issue,
    tpex: !!fund.tpex,
    approxListDate: !!fund.approxListDate,
    tradingDays: n,
    fresh: n < 20,
    day1Break,
    first10BreakDay,
    firstBreakDate,
    low20: round2(low20),
    low20Date: first20.length ? first20[low20Idx].date : (n ? bars[0].date : fund.listDate),
    low20Day: low20Idx + 1,
    reclaimDate,
    reclaimGap,
    reclaimHeld,
    status,
    ret3m: r1(retAfterMonths(bars, 3)),
    ret6m: r1(retAfterMonths(bars, 6)),
    retNow: r1(n >= 2 && round2(bars[0].adj) !== 0
      ? (round2(bars[n - 1].adj) - round2(bars[0].adj)) / round2(bars[0].adj) * 100
      : null),
    lastClose: n ? round2(closes[n - 1]) : null,
  };
}

export async function GET() {
  const key = CACHE_KEY();
  const cached = await readPageCache<BreakIssuePayload>(key);
  if (cached) return NextResponse.json(cached, { headers: { 'Cache-Control': 'no-store' } });

  const rows: BreakIssueRow[] = [];
  const errors: string[] = [];
  const BATCH = 5;

  for (let i = 0; i < BREAK_ISSUE_FUNDS.length; i += BATCH) {
    const slice = BREAK_ISSUE_FUNDS.slice(i, i + BATCH);
    const results = await Promise.all(slice.map(async fund => {
      const from = new Date(fund.listDate + 'T00:00:00Z');
      from.setDate(from.getDate() - 7);
      try {
        const all = await fetchBars(fund.yfTicker, from);
        const bars = all.filter(b => b.date >= fund.listDate);
        if (bars.length < 1) { errors.push(fund.ticker); return null; }
        return analyse(fund, bars);
      } catch {
        errors.push(fund.ticker);
        return null;
      }
    }));
    for (const r of results) if (r) rows.push(r);
  }

  rows.sort((a, b) => a.listDate.localeCompare(b.listDate) || a.ticker.localeCompare(b.ticker));
  const payload: BreakIssuePayload = { asOf: taipeiDateStr(), rows, errors };
  if (rows.length >= BREAK_ISSUE_FUNDS.length - errors.length) await writePageCache(key, payload);

  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
}
