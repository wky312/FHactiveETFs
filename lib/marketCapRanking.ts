import fs from 'fs';
import path from 'path';
import { supabase, supabaseReady } from './supabase';

/* 全台股（上市+上櫃）市值前 N 大普通股，漲跌幅排行 + 00981A/00991A 持股比例。
   ──────────────────────────────────────────────────────────────────
   基準日固定在 2026-07-30（收盤價烘焙進 data/marketcap_baseline_20260730.json，
   永遠不變，省去每次都要重打歷史全市場行情、也避開 TWSE/TPEX 對歷史日期查詢
   可能的地區限制風險）。

   最新資料一律用「latest」型 API（不帶日期參數），今天算到昨天收盤、明天收盤後
   自動算到今天收盤，符合「今天算到8/11、收盤後算到8/12」的需求：
   - TWSE 全市場最新收盤：openapi STOCK_DAY_ALL
   - TPEX 全市場最新收盤：openapi tpex_mainboard_daily_close_quotes
   - 已發行股數（算市值用）：TWSE t187ap03_L / TPEX mopsfin_t187ap03_O 公司基本資料

   已發行股數若跟股本回推值(股本÷10，僅限面額10元)偏離過大，視為資料源異常改用回推值
   （2026-08 實測 6949 沛爾生醫-創 回傳整整 20 倍的異常值，此為通用防呆非個案硬編）。

   普通股篩選：代號 4 碼、首碼非 0；排除名稱含 DR（存託憑證）或以「特」結尾（特別股）。 */

export interface RankedStock {
  code: string;
  name: string;
  market: '上市' | '上櫃';
  mktcap: number;       // 元
  closeBase: number;    // 基準日(07/30)收盤
  closeLatest: number;  // 最新收盤
  pct: number;          // 漲跌幅 %
  p981: number | null;  // 00981A 持股佔比 %（null＝當期未持有）
  p991: number | null;  // 00991A 持股佔比 %
}

export interface MarketCapRankingResult {
  baseDate: string;
  latestDate: string;
  holdingDate981: string | null;
  holdingDate991: string | null;
  total: number;
  stocks: RankedStock[];
}

const BASELINE_PATH = path.join(process.cwd(), 'data', 'marketcap_baseline_20260730.json');
const TOP_N = 150;
const TTL_MS = 15 * 60 * 1000;

interface BaselineFile { date: string; stocks: Record<string, { name: string; market: string; close: number }> }
let _cache: { ts: number; data: MarketCapRankingResult } | null = null;

function isOrdinary(code: string, name: string): boolean {
  if (!/^[1-9]\d{3}$/.test(code)) return false;
  if (name.includes('DR')) return false;
  if (name.endsWith('特')) return false;
  return true;
}

// 民國日期 '1150811'(7碼) 或 '990811'(6碼) → '2026-08-11'
function rocToIso(roc: string): string {
  const y = Number(roc.slice(0, roc.length - 4)) + 1911;
  const m = roc.slice(-4, -2);
  const d = roc.slice(-2);
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function loadBaseline(): BaselineFile {
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
}

async function fetchTwseLatest(): Promise<{ date: string; prices: Map<string, number> }> {
  const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', {
    signal: AbortSignal.timeout(15000), cache: 'no-store',
  });
  if (!res.ok) throw new Error(`TWSE STOCK_DAY_ALL HTTP ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any[] = await res.json();
  const prices = new Map<string, number>();
  let date = '';
  for (const r of data) {
    const code = String(r.Code ?? '').trim();
    const price = parseFloat(r.ClosingPrice);
    if (!date && r.Date) date = rocToIso(String(r.Date));
    if (/^[1-9]\d{3}$/.test(code) && !isNaN(price) && price > 0) prices.set(code, price);
  }
  return { date, prices };
}

async function fetchTpexLatest(): Promise<{ date: string; prices: Map<string, number> }> {
  const res = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', {
    signal: AbortSignal.timeout(15000), cache: 'no-store',
  });
  if (!res.ok) throw new Error(`TPEX daily_close_quotes HTTP ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any[] = await res.json();
  const prices = new Map<string, number>();
  let date = '';
  for (const r of data) {
    const code = String(r.SecuritiesCompanyCode ?? '').trim();
    const price = parseFloat(r.Close);
    if (!date && r.Date) date = rocToIso(String(r.Date));
    if (/^[1-9]\d{3}$/.test(code) && !isNaN(price) && price > 0) prices.set(code, price);
  }
  return { date, prices };
}

interface CompanyInfo { name: string; shares: number; parShares: number | null }

async function fetchTwseShares(): Promise<Map<string, CompanyInfo>> {
  const res = await fetch('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', {
    signal: AbortSignal.timeout(15000), cache: 'no-store',
  });
  if (!res.ok) throw new Error(`TWSE t187ap03_L HTTP ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any[] = await res.json();
  const out = new Map<string, CompanyInfo>();
  for (const r of data) {
    const code = String(r['公司代號'] ?? '').trim();
    if (!/^[1-9]\d{3}$/.test(code)) continue;
    const shares = Number(r['已發行普通股數或TDR原股發行股數'] ?? 0);
    const capital = Number(r['實收資本額'] ?? 0);
    const parNote = String(r['普通股每股面額'] ?? '');
    const parShares = parNote.includes('10.0000') && capital > 0 ? capital / 10 : null;
    if (shares > 0) out.set(code, { name: String(r['公司簡稱'] ?? '').trim(), shares, parShares });
  }
  return out;
}

async function fetchTpexShares(): Promise<Map<string, CompanyInfo>> {
  const res = await fetch('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O', {
    signal: AbortSignal.timeout(15000), cache: 'no-store',
  });
  if (!res.ok) throw new Error(`TPEX mopsfin_t187ap03_O HTTP ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any[] = await res.json();
  const out = new Map<string, CompanyInfo>();
  for (const r of data) {
    const code = String(r['SecuritiesCompanyCode'] ?? '').trim();
    if (!/^[1-9]\d{3}$/.test(code)) continue;
    const shares = Number(r['IssueShares'] ?? 0);
    const capital = Number(r['Paidin.Capital.NTDollars'] ?? 0);
    const parNote = String(r['ParValueOfCommonStock'] ?? '');
    const parShares = parNote.includes('10.0000') && capital > 0 ? capital / 10 : null;
    if (shares > 0) out.set(code, { name: String(r['CompanyName'] ?? '').trim(), shares, parShares });
  }
  return out;
}

// 已發行股數與股本回推值偏離超過 50% → 視為資料源異常，改用回推值
function sanitizeShares(info: CompanyInfo): number {
  if (info.parShares && info.parShares > 0) {
    const ratio = info.shares / info.parShares;
    if (ratio > 1.5 || ratio < 0.5) return info.parShares;
  }
  return info.shares;
}

interface HoldRow { stockid: string; prate: number | string | null }

async function fetchHoldingPrate(ticker: string): Promise<{ date: string | null; map: Map<string, number> }> {
  const map = new Map<string, number>();
  if (!supabaseReady || !supabase) return { date: null, map };
  const { data: latest } = await supabase
    .from('holding').select('date').eq('ticker', ticker)
    .order('date', { ascending: false }).limit(1).maybeSingle();
  const date = (latest?.date as string) ?? null;
  if (!date) return { date: null, map };
  const { data: rows } = await supabase
    .from('holding').select('stockid,prate').eq('ticker', ticker).eq('date', date);
  for (const r of (rows ?? []) as HoldRow[]) {
    const sid = String(r.stockid ?? '').trim();
    if (!sid || r.prate == null) continue;
    const p = Number(r.prate);
    if (!isNaN(p)) map.set(sid, p);
  }
  return { date, map };
}

export async function computeMarketCapRanking(topN: number = TOP_N): Promise<MarketCapRankingResult> {
  if (_cache && Date.now() - _cache.ts < TTL_MS) return _cache.data;

  const baseline = loadBaseline();
  const [twseLatest, tpexLatest, twseShares, tpexShares, h981, h991] = await Promise.all([
    fetchTwseLatest(), fetchTpexLatest(), fetchTwseShares(), fetchTpexShares(),
    fetchHoldingPrate('00981A'), fetchHoldingPrate('00991A'),
  ]);

  const latestDate = twseLatest.date || tpexLatest.date;
  const codes = new Set<string>([...twseLatest.prices.keys(), ...tpexLatest.prices.keys()]);

  const rows: RankedStock[] = [];
  for (const code of codes) {
    const isTwse = twseLatest.prices.has(code);
    const closeLatest = isTwse ? twseLatest.prices.get(code)! : tpexLatest.prices.get(code)!;
    const info = (isTwse ? twseShares.get(code) : tpexShares.get(code)) ?? twseShares.get(code) ?? tpexShares.get(code);
    if (!info) continue;
    if (!isOrdinary(code, info.name)) continue;
    const shares = sanitizeShares(info);
    if (shares <= 0) continue;
    const base = baseline.stocks[code];
    if (!base) continue; // 07/30 無資料（後續新掛牌等）→ 無法算漲跌幅，排除

    const mktcap = closeLatest * shares;
    const pct = ((closeLatest - base.close) / base.close) * 100;
    rows.push({
      code, name: info.name, market: isTwse ? '上市' : '上櫃',
      mktcap, closeBase: base.close, closeLatest, pct,
      p981: h981.map.get(code) ?? null,
      p991: h991.map.get(code) ?? null,
    });
  }

  rows.sort((a, b) => b.mktcap - a.mktcap);
  const stocks = rows.slice(0, topN);

  const result: MarketCapRankingResult = {
    baseDate: baseline.date,
    latestDate,
    holdingDate981: h981.date,
    holdingDate991: h991.date,
    total: stocks.length,
    stocks,
  };
  _cache = { ts: Date.now(), data: result };
  return result;
}
