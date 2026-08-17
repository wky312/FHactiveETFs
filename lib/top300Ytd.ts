import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import {
  isOrdinary, fetchTwseLatest, fetchTpexLatest, fetchTwseShares, fetchTpexShares, sanitizeShares,
} from './marketCapRanking';
import { fetchStockPerformance } from './yahooFinance';

/* 2025/12/31 市值前300大，追蹤至今的還原權息報酬 + 市值排名變化。
   ──────────────────────────────────────────────────────────────────
   市值/排名一律用「原始收盤價」計算（市值＝實際成交價×股數，不該用還原價，
   否則市值會失真）；「漲幅」與「股價」欄位用還原權息，但刻意釘死在
   [2025/12/31, 最新一個交易日收盤]這兩個「已收盤、不會再變」的日期上
   （customStart/customEnd），不用 Yahoo 即時報價（quote.price）或還沒收盤的
   當日走勢列——使用者的原話是這頁「平常沒事也不會去看」，沒必要為了即時性
   犧牲穩定性/可快取性，用「最新收盤價」更符合這頁的使用情境，兩個日期都是
   歷史資料，同一天內查幾次結果都一樣，才有辦法做到下面的每日快取。
   算法沿用全站既有 lib/yahooFinance.ts 的 fetchStockPerformance()
   （customStartPrice/customEndPrice/pctCustom），跟其他分頁同一套口徑，
   不另外造一套。

   基準日(2025/12/31)收盤價烘焙進 data/marketcap_baseline_20251231.json，
   理由同 marketCapRanking.ts：基準日資料永遠不變，沒必要每次都查歷史行情。

   300 檔逐一呼叫 Yahoo Finance 抓還原權息序列，成本較高（實測20-30秒）。
   快取兩層：
   1) 記憶體（同一個 serverless instance 內重複請求秒回，10分鐘 TTL）
   2) 本專案自己的 Supabase page_cache 表（key 帶台北時區日期字串）——
      跨 instance / cold start 都能共用，同一天內第一次算完之後，不管
      打到哪一台都直接讀表，不用重算。表需先手動跑一次
      scripts/sql/2026-08-13_create_page_cache.sql（Supabase SQL Editor）。 */

export interface Top300Row {
  code: string;
  name: string;
  market: '上市' | '上櫃';
  closeBase: number;        // 12/31 原始收盤（算市值用）
  closeLatest: number;      // 最新原始收盤（算市值用）
  adjBasePrice: number;     // 12/31 還原權息收盤價（顯示/算漲幅用）
  adjLatestPrice: number;   // 最新交易日還原權息收盤價（顯示/算漲幅用；非即時報價）
  pct: number;              // 還原權息漲幅 %
  pctAdjusted: boolean;     // false＝Yahoo 還原資料抓不到，退回原始收盤算的漲幅（極少數）
  mktcapLatest: number;     // 元，最新原始收盤 × 股數
  rankBase: number;         // 12/31 市值排名（1-300）
  rankLatest: number;       // 最新市值排名（全市場，不限300）
  rankChange: number;       // rankBase - rankLatest，正值＝排名進步
}

export interface TierStats {
  count: number;
  avgPct: number;
  medianPct: number;
  upCount: number;
  droppedOut: number; // 跌出目前前300大的檔數
}

export interface Top300YtdResult {
  baseDate: string;
  latestDate: string;
  tier1: TierStats; // 排名 1-150
  tier2: TierStats; // 排名 151-300
  rows: Top300Row[];
  cacheSource?: 'memory' | 'supabase' | 'fresh'; // 診斷用：這次回應是從哪一層拿到的，不影響顯示邏輯
}

const BASELINE_PATH = path.join(process.cwd(), 'data', 'marketcap_baseline_20251231.json');
const TOP_N = 300;
const BATCH = 8;
const MEM_TTL_MS = 10 * 60 * 1000;

interface BaselineFile { date: string; stocks: Record<string, { name: string; market: string; close: number }> }
let _memCache: { ts: number; dateKey: string; data: Top300YtdResult } | null = null;

function loadBaseline(): BaselineFile {
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
}

// 台北時區的今天日期字串 YYYY-MM-DD，當作 Supabase 快取的 key（同一天只算一次）
function taipeiDateStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }); // en-CA -> YYYY-MM-DD
}

function ownSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function readPageCache(cacheKey: string): Promise<Top300YtdResult | null> {
  const db = ownSupabase();
  if (!db) return null;
  try {
    const { data, error } = await db.from('page_cache').select('payload').eq('cache_key', cacheKey).maybeSingle();
    if (error) { console.error('[top300Ytd] page_cache read failed:', error.message); return null; }
    return (data?.payload as Top300YtdResult) ?? null;
  } catch (err) {
    console.error('[top300Ytd] page_cache read threw:', err); // 表還沒建、或連線失敗都當快取沒命中，照樣重算，不擋主流程
    return null;
  }
}

async function writePageCache(cacheKey: string, payload: Top300YtdResult): Promise<void> {
  const db = ownSupabase();
  if (!db) { console.warn('[top300Ytd] SUPABASE_URL/SUPABASE_SERVICE_KEY 未設定，跳過持久化快取寫入'); return; }
  try {
    const { error } = await db.from('page_cache').upsert({ cache_key: cacheKey, payload, updated_at: new Date().toISOString() });
    if (error) console.error('[top300Ytd] page_cache write failed:', error.message);
  } catch (err) {
    console.error('[top300Ytd] page_cache write threw:', err); // 寫入失敗不影響本次回應，下次請求會再試一次
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i]); }
  }));
  return out;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function tierStats(rows: Top300Row[]): TierStats {
  const pcts = rows.map(r => r.pct);
  return {
    count: rows.length,
    avgPct: pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0,
    medianPct: median(pcts),
    upCount: rows.filter(r => r.pct > 0).length,
    droppedOut: rows.filter(r => r.rankLatest > TOP_N).length,
  };
}

async function computeFresh(): Promise<Top300YtdResult> {
  const baseline = loadBaseline();
  const [twseLatest, tpexLatest, twseShares, tpexShares] = await Promise.all([
    fetchTwseLatest(), fetchTpexLatest(), fetchTwseShares(), fetchTpexShares(),
  ]);
  const latestDate = twseLatest.date || tpexLatest.date;
  const latestDateObj = new Date(`${latestDate}T00:00:00`);
  const baseDateObj = new Date(`${baseline.date}T00:00:00`);

  const sharesOf = (code: string) => {
    const info = twseShares.get(code) ?? tpexShares.get(code);
    return info ? sanitizeShares(info) : 0;
  };

  // 全市場最新市值排名（不限300，供「最新排名」查詢用）
  const latestCodes = new Set<string>([...twseLatest.prices.keys(), ...tpexLatest.prices.keys()]);
  const latestMktcap: { code: string; mktcap: number; close: number; market: '上市' | '上櫃' }[] = [];
  for (const code of latestCodes) {
    const isTwse = twseLatest.prices.has(code);
    const close = isTwse ? twseLatest.prices.get(code)! : tpexLatest.prices.get(code)!;
    const sh = sharesOf(code);
    if (sh <= 0) continue;
    latestMktcap.push({ code, mktcap: close * sh, close, market: isTwse ? '上市' : '上櫃' });
  }
  latestMktcap.sort((a, b) => b.mktcap - a.mktcap);
  const rankLatestMap = new Map<string, number>();
  const latestByCode = new Map<string, { mktcap: number; close: number; market: '上市' | '上櫃' }>();
  latestMktcap.forEach((r, i) => { rankLatestMap.set(r.code, i + 1); latestByCode.set(r.code, r); });

  // 12/31 市值排名，取前300
  interface BaseEntry { code: string; name: string; market: '上市' | '上櫃'; close: number; shares: number; mktcap: number }
  const baseEntries: BaseEntry[] = Object.entries(baseline.stocks)
    .filter(([code, s]) => isOrdinary(code, s.name))
    .map(([code, s]) => {
      const shares = sharesOf(code);
      return { code, name: s.name, market: s.market as '上市' | '上櫃', close: s.close, shares, mktcap: s.close * shares };
    })
    .filter(e => e.shares > 0 && e.close > 0 && latestByCode.has(e.code)); // 需同時有最新資料才追得下去

  baseEntries.sort((a, b) => b.mktcap - a.mktcap);
  const top300 = baseEntries.slice(0, TOP_N);

  // 逐檔抓還原權息報酬：釘死在 [12/31, 最新交易日] 兩個已收盤日期，不用即時報價
  const perf = await mapLimit(top300, BATCH, async (e) => {
    const primary  = e.market === '上市' ? `${e.code}.TW`  : `${e.code}.TWO`;
    const fallback = e.market === '上市' ? `${e.code}.TWO` : `${e.code}.TW`;
    const p = await fetchStockPerformance(e.code, e.name, 0, primary, fallback, baseDateObj, latestDateObj);
    return { e, p };
  });

  const rows: Top300Row[] = perf.map(({ e, p }, i) => {
    const latest = latestByCode.get(e.code)!;
    const hasAdj = p.customStartPrice != null && p.customStartPrice > 0 && p.customEndPrice != null;
    const pct = hasAdj ? p.pctCustom! : ((latest.close - e.close) / e.close) * 100;
    return {
      code: e.code, name: e.name, market: e.market,
      closeBase: e.close, closeLatest: latest.close,
      adjBasePrice: hasAdj ? p.customStartPrice! : e.close,
      adjLatestPrice: hasAdj ? p.customEndPrice! : latest.close,
      pct, pctAdjusted: hasAdj,
      mktcapLatest: latest.mktcap,
      rankBase: i + 1,
      rankLatest: rankLatestMap.get(e.code) ?? 99999,
      rankChange: (i + 1) - (rankLatestMap.get(e.code) ?? 99999),
    };
  });

  const tier1 = rows.filter(r => r.rankBase <= 150);
  const tier2 = rows.filter(r => r.rankBase > 150 && r.rankBase <= 300);

  return {
    baseDate: baseline.date,
    latestDate,
    tier1: tierStats(tier1),
    tier2: tierStats(tier2),
    rows,
  };
}

export async function computeTop300Ytd(): Promise<Top300YtdResult> {
  const dateKey = taipeiDateStr();
  const cacheKey = `top300-ytd:${dateKey}`;

  // L1：記憶體，同一 instance 內短 TTL 就能秒回，省掉 Supabase 來回
  if (_memCache && _memCache.dateKey === dateKey && Date.now() - _memCache.ts < MEM_TTL_MS) {
    return { ..._memCache.data, cacheSource: 'memory' };
  }

  // L2：本專案 Supabase，跨 instance / cold start 共用，當天算過就不用重算
  const cached = await readPageCache(cacheKey);
  if (cached) {
    _memCache = { ts: Date.now(), dateKey, data: cached };
    return { ...cached, cacheSource: 'supabase' };
  }

  const result = await computeFresh();
  _memCache = { ts: Date.now(), dateKey, data: result };
  await writePageCache(cacheKey, result);
  return { ...result, cacheSource: 'fresh' };
}
