import { NextRequest, NextResponse } from 'next/server';
import { PEER_GROUPS } from '@/lib/peerGroups';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const YahooFinance = require('yahoo-finance2').default;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yf: any = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TRADING_DAYS = 252;   // 年化因子

export interface RiskRow {
  ticker: string;
  name: string;
  nDays: number;            // 計算用之交易日數
  totalReturn: number | null;   // 區間總報酬 %
  annReturn: number | null;     // 年化報酬 %
  annVol: number | null;        // 年化波動度 %
  mdd: number | null;           // 最大回撤 %（負值）
  beta: number | null;          // 相對基準 Beta
  sharpe: number | null;        // 夏普值
  ir: number | null;            // 資訊比率（相對基準）
  corr: number | null;          // 與基準相關係數
}

// 抓還原收盤(adjclose) → date(YYYY-MM-DD) → 還原價（與 cumulative-return 同邏輯）
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

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
function stdSample(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

// 依共同交易日（基金與基準皆有資料）對齊後計算風險指標
function computeRisk(
  fundMap: Map<string, number>,
  benchMap: Map<string, number>,
  startStr: string,
  endStr: string,
  rf: number,
): Omit<RiskRow, 'ticker' | 'name'> {
  // 共同日期（兩者皆有，且落在區間內），升冪
  const dates = Array.from(fundMap.keys())
    .filter(k => k >= startStr && k <= endStr && benchMap.has(k))
    .sort();
  const empty = { nDays: 0, totalReturn: null, annReturn: null, annVol: null, mdd: null, beta: null, sharpe: null, ir: null, corr: null };
  if (dates.length < 3) return empty;

  const fp = dates.map(d => fundMap.get(d)!);
  const bp = dates.map(d => benchMap.get(d)!);

  // 日報酬（簡單報酬）
  const fr: number[] = [], br: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    fr.push(fp[i] / fp[i - 1] - 1);
    br.push(bp[i] / bp[i - 1] - 1);
  }
  const n = fr.length;

  const totalReturn = (fp[fp.length - 1] / fp[0] - 1) * 100;
  const annReturn = (Math.pow(fp[fp.length - 1] / fp[0], TRADING_DAYS / n) - 1) * 100;

  const volDaily = stdSample(fr);
  const annVol = volDaily * Math.sqrt(TRADING_DAYS) * 100;

  // 最大回撤：以還原價的累積高點計
  let peak = fp[0], mdd = 0;
  for (const p of fp) {
    if (p > peak) peak = p;
    const dd = p / peak - 1;
    if (dd < mdd) mdd = dd;
  }

  // Beta、相關係數
  const fm = mean(fr), bm = mean(br);
  let cov = 0, varB = 0, varF = 0;
  for (let i = 0; i < n; i++) {
    cov += (fr[i] - fm) * (br[i] - bm);
    varB += (br[i] - bm) ** 2;
    varF += (fr[i] - fm) ** 2;
  }
  cov /= (n - 1); varB /= (n - 1); varF /= (n - 1);
  const beta = varB > 0 ? cov / varB : null;
  const corr = (varB > 0 && varF > 0) ? cov / Math.sqrt(varB * varF) : null;

  // 夏普：(年化報酬 − 無風險利率) / 年化波動度
  const sharpe = annVol > 0 ? (annReturn / 100 - rf) / (annVol / 100) : null;

  // 資訊比率：主動報酬年化 / 追蹤誤差年化
  const active = fr.map((x, i) => x - br[i]);
  const teDaily = stdSample(active);
  const annActive = mean(active) * TRADING_DAYS;
  const annTE = teDaily * Math.sqrt(TRADING_DAYS);
  const ir = annTE > 0 ? annActive / annTE : null;

  return {
    nDays: dates.length,
    totalReturn,
    annReturn,
    annVol,
    mdd: mdd * 100,
    beta,
    sharpe,
    ir,
    corr,
  };
}

export async function GET(request: NextRequest) {
  const groupId   = request.nextUrl.searchParams.get('group') ?? 'active';
  const group     = PEER_GROUPS[groupId] ?? PEER_GROUPS['active'];
  const tickersP  = request.nextUrl.searchParams.get('tickers');
  const benchTk   = request.nextUrl.searchParams.get('benchmark') ?? '0050';
  const startStr  = request.nextUrl.searchParams.get('startDate');
  const endStr    = request.nextUrl.searchParams.get('endDate');
  const rfParam   = request.nextUrl.searchParams.get('rf');
  const rf        = rfParam != null ? parseFloat(rfParam) : 0.015;   // 預設無風險利率 1.5%

  if (!startStr || !endStr) {
    return NextResponse.json({ error: '缺少 startDate 或 endDate' }, { status: 400 });
  }

  const wanted = tickersP ? new Set(tickersP.split(',').map(s => s.trim()).filter(Boolean)) : null;
  const items  = group.items.filter(i => (!wanted || wanted.has(i.ticker)) && i.ticker !== benchTk);

  // 基準：先找同組，找不到則直接用代碼推 yfTicker
  const benchItem = group.items.find(i => i.ticker === benchTk)
    ?? Object.values(PEER_GROUPS).flatMap(g => g.items).find(i => i.ticker === benchTk)
    ?? { ticker: benchTk, name: benchTk, yfTicker: benchTk.includes('.') || benchTk.startsWith('^') ? benchTk : `${benchTk}.TW` };

  if (!items.length) {
    return NextResponse.json({ start: startStr, end: endStr, benchmark: { ticker: benchItem.ticker, name: benchItem.name }, rf, rows: [] });
  }

  const from = new Date(startStr + 'T00:00:00Z');
  const to   = new Date(endStr   + 'T23:59:59Z');

  const benchMap = await fetchAdjMap(benchItem.yfTicker, from, to);

  const BATCH = 5;
  const rows: RiskRow[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = await Promise.all(items.slice(i, i + BATCH).map(async it => {
      const map = await fetchAdjMap(it.yfTicker, from, to);
      const m = computeRisk(map, benchMap, startStr, endStr, rf);
      return { ticker: it.ticker, name: it.name, ...m } as RiskRow;
    }));
    rows.push(...batch);
  }

  return NextResponse.json(
    { start: startStr, end: endStr, benchmark: { ticker: benchItem.ticker, name: benchItem.name }, rf, rows },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
