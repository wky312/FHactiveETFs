import { NextRequest, NextResponse } from 'next/server';
import { PEER_GROUPS } from '@/lib/peerGroups';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const YahooFinance = require('yahoo-finance2').default;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yf: any = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const round2 = (x: number) => Math.round(x * 100) / 100;

export interface CumRetSeries {
  ticker: string;
  name: string;
  pct: (number | null)[];   // 對齊 dates；上市前/無資料為 null，起點(該標的首個有資料日)= 0
}
export interface CumRetResult {
  start: string;
  end: string;
  dates: string[];          // 統一日期軸 YYYY-MM-DD（各標的交易日聯集，升冪）
  series: CumRetSeries[];
}

// 抓某標的還原收盤(adjclose) → date(YYYY-MM-DD) → 還原價
async function fetchAdjMap(yfTicker: string, from: Date, to: Date): Promise<Map<string, number>> {
  const period2 = new Date(to); period2.setDate(period2.getDate() + 1);
  try {
    const chart = await yf.chart(yfTicker, { period1: from, period2, interval: '1d' }, { validateResult: false });
    const m = new Map<string, number>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const q of (chart?.quotes ?? []) as any[]) {
      const a = q.adjClose ?? q.adjclose ?? q.close;   // adjclose 為小寫，務必容錯
      if (a == null) continue;
      const d = new Date(q.date);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      m.set(key, a);
    }
    return m;
  } catch {
    return new Map();
  }
}

export async function GET(request: NextRequest) {
  const groupId  = request.nextUrl.searchParams.get('group') ?? 'active';
  const group    = PEER_GROUPS[groupId] ?? PEER_GROUPS['active'];
  const tickersP = request.nextUrl.searchParams.get('tickers'); // 逗號分隔；未帶 = 整組
  const startStr = request.nextUrl.searchParams.get('startDate');
  const endStr   = request.nextUrl.searchParams.get('endDate');
  if (!startStr || !endStr) {
    return NextResponse.json({ error: '缺少 startDate 或 endDate' }, { status: 400 });
  }

  const wanted = tickersP ? new Set(tickersP.split(',').map(s => s.trim()).filter(Boolean)) : null;
  const items  = group.items.filter(i => !wanted || wanted.has(i.ticker));
  if (!items.length) {
    return NextResponse.json({ start: startStr, end: endStr, dates: [], series: [] } as CumRetResult);
  }

  const from = new Date(startStr + 'T00:00:00Z');
  const to   = new Date(endStr   + 'T23:59:59Z');

  // 批量抓還原收盤
  const BATCH = 5;
  const maps: { ticker: string; name: string; map: Map<string, number> }[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = await Promise.all(items.slice(i, i + BATCH).map(async it => ({
      ticker: it.ticker, name: it.name, map: await fetchAdjMap(it.yfTicker, from, to),
    })));
    maps.push(...batch);
  }

  // 統一日期軸：各標的在 [start, end] 內交易日的聯集
  const dateSet = new Set<string>();
  for (const { map } of maps) {
    for (const k of map.keys()) if (k >= startStr && k <= endStr) dateSet.add(k);
  }
  const dates = Array.from(dateSet).sort();

  // 每個標的：對齊日期軸、前向填補、以區間內首個有資料日為基準(0%)，還原+先進位計算累積報酬
  const series: CumRetSeries[] = maps.map(({ ticker, name, map }) => {
    const entries = Array.from(map.entries())
      .filter(([k]) => k >= startStr && k <= endStr)
      .sort((a, b) => a[0].localeCompare(b[0]));
    let ptr = 0, lastAdj: number | null = null, base: number | null = null;
    const pct = dates.map(d => {
      while (ptr < entries.length && entries[ptr][0] <= d) { lastAdj = entries[ptr][1]; ptr++; }
      if (lastAdj == null) return null;                 // 該標的此日前尚無資料（如尚未上市）
      if (base == null) base = lastAdj;                 // 首個有資料日 = 起點 0%
      const b = round2(base);
      return b === 0 ? null : (round2(lastAdj) - b) / b * 100;
    });
    return { ticker, name, pct };
  });

  return NextResponse.json({ start: startStr, end: endStr, dates, series } as CumRetResult,
    { headers: { 'Cache-Control': 'no-store' } });
}
