import { buildDayMap, fetchPriceMaps, computePositionPnl } from './stockTrajectory';

/* 經理人選股對帳單（Manager Stock-Picking Scorecard）
   ──────────────────────────────────────────────────
   把「個股軌跡」的成本引擎套到基金「每一檔曾持有的股票」上，產出兩種口徑：

   1) 現有持股（current）：只看目前持股的「未實現」損益＝持倉對帳單。
   2) 含已出清（all）：把所有曾持有的股票都納入，計入「已實現＋未實現」損益 —— 還原
      真實選股勝率，避免「賠錢停損出清就從名單消失」造成的存活者偏誤(survivorship bias)。

   口徑（與 lib/stockTrajectory 一致，UI 會揭露）：
   - 成本／賣出基準＝移動平均成本法；基準價＝台股真實成交均價 → 中間價(海外) → 收盤。
   - 報酬以原始收盤計（未還原息）→ 對除息個股略低估。
   - 現價＝最後一個有報價交易日的收盤；海外股以中間價近似成本。 */

export interface PositionPnl {
  stockid: string;
  stockname: string;
  held: boolean;                // 目前是否持有（false = 已出清）
  lots: number;                 // 目前持股張數（0 = 已出清）
  prate: number;                // 目前佔淨值比 %（已出清為 0）
  mvalue: number;               // 目前市值 NTD
  grossInvested: number;        // 累計買進成本 NTD
  avgCost: number | null;       // 剩餘部位均價 元/股
  currentPrice: number | null;  // 現價 元/股
  realizedPnl: number;          // 已實現損益 NTD
  unrealizedPnl: number;        // 未實現損益 NTD
  totalPnl: number;             // 已實現＋未實現 NTD
  returnUnreal: number | null;  // 未實現報酬 %（held 才有）
  returnAll: number | null;     // 總報酬 % = totalPnl / grossInvested
  contribution: number | null;  // 對現有淨值貢獻 % = prate/100 × returnUnreal
}

export interface ScorecardAgg {
  scope: 'current' | 'all';
  n: number;                    // 檔數
  nEval: number;                // 可評估檔數
  nWin: number;
  nLoss: number;
  winRate: number | null;       // nWin / nEval × 100
  avgWin: number | null;        // 贏家平均報酬 %
  avgLoss: number | null;       // 輸家平均報酬 %（負值）
  payoff: number | null;        // 賺賠比 = avgWin / |avgLoss|
  meanReturn: number | null;    // 簡單平均報酬 %
  weightedReturn: number | null;// current＝依淨值權重加權報酬%；all＝整體資金加權報酬%(ΣtotalPnl/Σ投入)
  totalPnl: number;             // 累計損益 NTD（all 口徑有意義）
}

export interface Scorecard {
  fundId: string;
  asOf: string;                 // 最新持股日期 YYYY/MM/DD
  positions: PositionPnl[];     // 全部曾持有，依 totalPnl 降冪
  current: ScorecardAgg;        // 現有持股（未實現）
  all: ScorecardAgg;            // 含已出清（已實現＋未實現）
}

const CONCURRENCY = 8;
const TTL_MS = 10 * 60 * 1000;
const _cache = new Map<string, { ts: number; data: Scorecard }>();

const mean = (xs: number[]): number | null => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;

interface AggItem { ret: number | null; weight: number; pnl: number; invested: number }

function aggregate(scope: 'current' | 'all', items: AggItem[]): ScorecardAgg {
  const ev = items.filter(i => i.ret != null);
  const wins = ev.filter(i => i.ret! > 0);
  const losses = ev.filter(i => i.ret! < 0);
  const avgWin = mean(wins.map(i => i.ret!));
  const avgLoss = mean(losses.map(i => i.ret!));
  const sumW = ev.reduce((s, i) => s + i.weight, 0);
  const sumInv = ev.reduce((s, i) => s + i.invested, 0);
  const sumPnl = ev.reduce((s, i) => s + i.pnl, 0);
  const weightedReturn = scope === 'current'
    ? (sumW > 0 ? ev.reduce((s, i) => s + i.weight * i.ret!, 0) / sumW : null)  // 依淨值權重
    : (sumInv > 0 ? sumPnl / sumInv * 100 : null);                              // 整體資金加權
  return {
    scope,
    n: items.length,
    nEval: ev.length,
    nWin: wins.length,
    nLoss: losses.length,
    winRate: ev.length ? wins.length / ev.length * 100 : null,
    avgWin, avgLoss,
    payoff: (avgWin != null && avgLoss != null && avgLoss !== 0) ? avgWin / Math.abs(avgLoss) : null,
    meanReturn: mean(ev.map(i => i.ret!)),
    weightedReturn,
    totalPnl: sumPnl,
  };
}

function emptyAgg(scope: 'current' | 'all'): ScorecardAgg {
  return { scope, n: 0, nEval: 0, nWin: 0, nLoss: 0, winRate: null, avgWin: null, avgLoss: null, payoff: null, meanReturn: null, weightedReturn: null, totalPnl: 0 };
}

export async function computeScorecard(fundId: string): Promise<Scorecard> {
  const cached = _cache.get(fundId);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

  const { dayMap, sortedDates, end } = await buildDayMap(fundId);
  if (sortedDates.length === 0) {
    return { fundId, asOf: '', positions: [], current: emptyAgg('current'), all: emptyAgg('all') };
  }
  const asOf = sortedDates[sortedDates.length - 1];

  // 最新持股（目前持有）對照表
  const latest = new Map<string, { name: string; lots: number; prate: number; mvalue: number }>();
  for (const h of dayMap.get(asOf) ?? []) {
    if (h.stockid && h.qshare > 0) latest.set(h.stockid, { name: h.stockname, lots: h.qshare / 1000, prate: h.prate_addaccint, mvalue: h.mvalue });
  }

  // 所有「曾持有」的股票（任一交易日張數 > 0）。名稱取最後一次出現者。
  const everNames = new Map<string, string>();
  for (const date of sortedDates) {
    for (const h of dayMap.get(date) ?? []) {
      if (h.stockid && h.qshare > 0) everNames.set(h.stockid, h.stockname || everNames.get(h.stockid) || '');
    }
  }
  const everIds = Array.from(everNames.keys());

  // 某股逐交易日張數序列（從首次持有日 trim）。只用 dayMap，無網路。
  const buildTrimmed = (stockid: string): { date: string; lots: number }[] => {
    const raw = sortedDates.map(date => {
      const h = (dayMap.get(date) ?? []).find(x => x.stockid === stockid);
      return { date, lots: h ? h.qshare / 1000 : 0 };
    });
    const firstIdx = raw.findIndex(p => p.lots > 0);
    return firstIdx === -1 ? [] : raw.slice(firstIdx);
  };

  // 併發抓價、逐檔算損益（concurrency 受限）
  const positions: PositionPnl[] = [];
  let idx = 0;
  const worker = async () => {
    while (idx < everIds.length) {
      const stockid = everIds[idx++];
      const trimmed = buildTrimmed(stockid);
      let raw = { avgCost: null as number | null, currentPrice: null as number | null, currentShares: 0, grossInvested: 0, realizedPnl: 0, unrealizedPnl: 0 };
      if (trimmed.length > 0) {
        try {
          const { mid, close, avg } = await fetchPriceMaps(stockid, fundId, trimmed[0].date, end);
          raw = computePositionPnl(trimmed, mid, close, avg);
        } catch { /* 無報價 → 維持 0/null，計為不可評估 */ }
      }
      const cur = latest.get(stockid);
      const held = !!cur && raw.currentShares > 0;
      const prate = cur?.prate ?? 0;
      const totalPnl = raw.realizedPnl + raw.unrealizedPnl;
      const returnUnreal = (held && raw.avgCost && raw.currentPrice)
        ? (raw.currentPrice - raw.avgCost) / raw.avgCost * 100 : null;
      const returnAll = raw.grossInvested > 0 ? totalPnl / raw.grossInvested * 100 : null;
      positions.push({
        stockid,
        stockname: cur?.name ?? everNames.get(stockid) ?? '',
        held,
        lots: cur?.lots ?? 0,
        prate,
        mvalue: cur?.mvalue ?? 0,
        grossInvested: raw.grossInvested,
        avgCost: raw.avgCost,
        currentPrice: raw.currentPrice,
        realizedPnl: raw.realizedPnl,
        unrealizedPnl: raw.unrealizedPnl,
        totalPnl,
        returnUnreal,
        returnAll,
        contribution: returnUnreal != null ? (prate / 100) * returnUnreal : null,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, everIds.length) }, worker));

  positions.sort((a, b) => b.totalPnl - a.totalPnl);

  const current = aggregate('current', positions.filter(p => p.held).map(p => ({
    ret: p.returnUnreal, weight: p.prate, pnl: p.unrealizedPnl, invested: p.grossInvested,
  })));
  const all = aggregate('all', positions.map(p => ({
    ret: p.returnAll, weight: p.grossInvested, pnl: p.totalPnl, invested: p.grossInvested,
  })));

  const data: Scorecard = { fundId, asOf, positions, current, all };
  _cache.set(fundId, { ts: Date.now(), data });
  return data;
}
