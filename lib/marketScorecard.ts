import { supabase, supabaseReady } from './supabase';

/* 全 19 檔主動式 ETF「同區間」選股總覽
   ──────────────────────────────────────────
   資料源＝共用 Supabase（twActiveETFs 的 holding / price 表，每日更新全 19 檔）。
   口徑（與單檔對帳單不同，UI 會揭露）：
   - 固定區間：每檔「目前持股」在 [startDate, endDate] 區間的收盤漲跌，依 prate 加權。
   - 量的是「現有持股在這段期間的表現」，不是進場成本 —— 期間內才買進的也以全期間計，公平比較。
   - 勝率＝期間上漲的持股檔數 ÷ 可評估檔數；報酬用原始收盤（未還原息）。
   注意：2026-06-19 這類「只有部分基金回報」的日子不可當共同基準，故每檔各取自身最新持股日。 */

export interface FundComparisonRow {
  ticker: string;
  name: string;
  issuer: string;
  holdingDate: string | null;   // 該檔採用的持股日期
  nHoldings: number;
  nEval: number;
  nWin: number;
  nLoss: number;
  winRate: number | null;
  weightedReturn: number | null; // 依 prate 加權的區間報酬 %
  avgWin: number | null;
  avgLoss: number | null;
  payoff: number | null;
}

export interface MarketComparison {
  startDate: string;
  endDate: string;
  funds: FundComparisonRow[];
}

const TTL_MS = 10 * 60 * 1000;
const _cache = new Map<string, { ts: number; data: MarketComparison }>();
const CHUNK = 150;

const mean = (xs: number[]): number | null => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;

async function latestPriceDate(onOrBefore?: string): Promise<string | null> {
  let q = supabase!.from('price').select('date').order('date', { ascending: false }).limit(1);
  if (onOrBefore) q = q.lte('date', onOrBefore);
  const { data } = await q.maybeSingle();
  return (data?.date as string) ?? null;
}

// 某交易日、一組個股的收盤價對照表（chunk 化避免 in() 過長）
async function closeMapOn(date: string, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const { data } = await supabase!.from('price').select('stockid,close').eq('date', date).in('stockid', batch);
    for (const r of (data ?? []) as { stockid: string; close: number | null }[]) {
      if (r.close != null) out.set(r.stockid, Number(r.close));
    }
  }
  return out;
}

export async function computeMarketComparison(fromReq: string, toReq?: string): Promise<MarketComparison> {
  if (!supabaseReady || !supabase) throw new Error('Supabase 未設定（缺 NEXT_PUBLIC_SUPABASE_URL / KEY）');

  const cacheKey = `${fromReq}|${toReq ?? ''}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

  const endDate = await latestPriceDate(toReq);
  const startDate = await latestPriceDate(fromReq);
  if (!endDate || !startDate) throw new Error('查無股價資料');

  const { data: etfs } = await supabase
    .from('etf').select('ticker,name,issuer')
    .eq('market', 'tw').eq('type', 'equity').order('ticker');
  const etfList = (etfs ?? []) as { ticker: string; name: string; issuer: string }[];

  // 每檔各取「自身最新持股日（≤ endDate）」的持股，避開部分基金提前回報造成的殘缺日。
  const holdingsByFund = await Promise.all(etfList.map(async (e) => {
    const { data: latest } = await supabase!
      .from('holding').select('date').eq('ticker', e.ticker).lte('date', endDate)
      .order('date', { ascending: false }).limit(1).maybeSingle();
    const hDate = (latest?.date as string) ?? null;
    if (!hDate) return { e, hDate, holds: [] as { stockid: string; prate: number }[] };
    const { data } = await supabase!
      .from('holding').select('stockid,prate').eq('ticker', e.ticker).eq('date', hDate).gt('qshare', 0);
    return { e, hDate, holds: (data ?? []) as { stockid: string; prate: number }[] };
  }));

  const ids = [...new Set(holdingsByFund.flatMap((f) => f.holds.map((h) => h.stockid)))];
  const [closeStart, closeEnd] = await Promise.all([closeMapOn(startDate, ids), closeMapOn(endDate, ids)]);

  const funds: FundComparisonRow[] = holdingsByFund.map(({ e, hDate, holds }) => {
    const items = holds.map((h) => {
      const cs = closeStart.get(h.stockid);
      const ce = closeEnd.get(h.stockid);
      const ret = (cs != null && ce != null && cs > 0) ? (ce - cs) / cs * 100 : null;
      return { prate: Number(h.prate), ret };
    });
    const ev = items.filter((i) => i.ret != null);
    const wins = ev.filter((i) => i.ret! > 0);
    const losses = ev.filter((i) => i.ret! < 0);
    const avgWin = mean(wins.map((i) => i.ret!));
    const avgLoss = mean(losses.map((i) => i.ret!));
    const sumW = ev.reduce((s, i) => s + i.prate, 0);
    return {
      ticker: e.ticker, name: e.name, issuer: e.issuer, holdingDate: hDate,
      nHoldings: holds.length, nEval: ev.length, nWin: wins.length, nLoss: losses.length,
      winRate: ev.length ? wins.length / ev.length * 100 : null,
      weightedReturn: sumW > 0 ? ev.reduce((s, i) => s + i.prate * i.ret!, 0) / sumW : null,
      avgWin, avgLoss,
      payoff: (avgWin != null && avgLoss != null && avgLoss !== 0) ? avgWin / Math.abs(avgLoss) : null,
    };
  });

  funds.sort((a, b) => (b.weightedReturn ?? -Infinity) - (a.weightedReturn ?? -Infinity));
  const data: MarketComparison = { startDate, endDate, funds };
  _cache.set(cacheKey, { ts: Date.now(), data });
  return data;
}
