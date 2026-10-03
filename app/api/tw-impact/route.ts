import { NextRequest, NextResponse } from 'next/server';
import { isAdminRequest } from '@/lib/adminAuth';
import { getTwImpactCached } from '@/lib/twImpact';
import { TW_ACTIVE_FUNDS, listTwActiveFunds } from '@/lib/twActiveFunds';

export const dynamic = 'force-dynamic';
// 快取沒命中時，22 檔基金的持股 + 聯集台股個股報價都打 CMoney/Yahoo，首次查詢可能數十秒；
// 命中快取（同一個交易日內任何後續請求）秒回。
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  try {
    // ?refresh=1 會跳過兩層快取、重算全部候選基金（持股＋報價），單次可達 300 秒並對
    // 13 家投信官網各打一輪 → 必須驗證，否則公開端點等於放任何人強制全量重算
    // （成本之外，更實際的風險是把 Vercel 出口 IP 送去被投信站封鎖，見 lib/adminAuth.ts）。
    const wantRefresh = sp.get('refresh') === '1';
    if (wantRefresh && !isAdminRequest(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // ?funds=1 → 可選的台股主動式 ETF 清單（給勾選清單用）
    if (sp.get('funds') === '1') {
      return NextResponse.json(listTwActiveFunds(), { headers: { 'Cache-Control': 'no-store' } });
    }
    const raw = sp.get('tickers');
    const requested = raw
      ? new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))
      : new Set(TW_ACTIVE_FUNDS.map((f) => f.ticker));

    // 一律從「全部 22 檔」共用快取切片，不論這次請求哪幾檔——同一個交易日內第一個人查詢才會
    // 真的重算，之後任何人查任何組合都直接命中同一份快取（見 lib/marketImpact.ts）。
    const full = await getTwImpactCached({ refresh: wantRefresh });
    const funds = full.funds.filter((f) => requested.has(f.ticker));
    return NextResponse.json(
      { sessionDate: full.sessionDate, prevSessionDate: full.prevSessionDate, funds, cacheSource: full.cacheSource },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : '未知錯誤' },
      { status: 500 },
    );
  }
}
