import { NextResponse } from 'next/server';
import { ETF_LIST } from '@/lib/etfList';

/* 即時折溢價：轉接復華官網「即時預估淨值」頁背後的 /api/ETFRTnav。
   官網每個營業日 8:30–17:00 更新；預估淨值以前一日持股估算，不含當日交易。
   只回本站追蹤的復華主動式 ETF（lib/etfList.ts 的 ETF_LIST）。 */

export const dynamic = 'force-dynamic';

const SRC = 'https://www.fhtrust.com.tw/api/ETFRTnav';

interface RawRow {
  modifiedTime?: string; etfCode?: string; name?: string;
  prePnav?: string; preDate?: string; pnav?: string; pnav1dChgPct?: string;
  preMVal?: string; mVal?: string; mVal1dChgPct?: string;
  dp?: string; dpPct?: string; f_workDay?: string;
}

export interface RtPremiumRow {
  code: string; name: string;
  prePnav: number | null; preDate: string;
  pnav: number | null; pnavChgPct: number | null;
  mVal: number | null; mValChgPct: number | null;
  dp: number | null; dpPct: number | null;   // 折溢價（元、%）：正＝溢價、負＝折價
  time: string; workDay: boolean;
}

const num = (s?: string) => {
  const v = parseFloat(String(s ?? '').replace(/[,%]/g, ''));
  return Number.isFinite(v) ? v : null;
};

export async function GET() {
  try {
    const res = await fetch(SRC, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', Referer: 'https://www.fhtrust.com.tw/ETF/etf_data_value' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`復華官網回應 HTTP ${res.status}`);
    const j = await res.json() as { result?: RawRow[] };
    const want = new Map(ETF_LIST.map((e, i) => [e.ticker, i]));
    const rows: RtPremiumRow[] = (j.result ?? [])
      .filter(r => r.etfCode && want.has(r.etfCode))
      .sort((a, b) => want.get(a.etfCode!)! - want.get(b.etfCode!)!)
      .map(r => ({
        code: r.etfCode!, name: r.name ?? '',
        prePnav: num(r.prePnav), preDate: r.preDate ?? '',
        pnav: num(r.pnav), pnavChgPct: num(r.pnav1dChgPct),
        mVal: num(r.mVal), mValChgPct: num(r.mVal1dChgPct),
        dp: num(r.dp), dpPct: num(r.dpPct),
        time: r.modifiedTime ?? '', workDay: r.f_workDay === 'Y',
      }));
    return NextResponse.json({ rows, fetchedAt: new Date().toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : '未知錯誤' }, { status: 502 });
  }
}
