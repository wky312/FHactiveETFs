import { UNIVERSE_TICKERS, UNIVERSE_NAMES } from './twseUniverse';
import { Stock } from './tw0050';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const YahooFinance = require('yahoo-finance2').default;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yf: any = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

const YUANTA_URL =
  'https://etfapi.yuantaetfs.com/ectranslation/api/bridge' +
  '?APIType=ETFAPI&CompanyName=YUANTAFUNDS' +
  '&PageName=%2Fproduct%2Fdetail%2F0050%2Fratio' +
  '&DeviceId=66c056e6-27f2-44c0-919e-473a82c778fb' +
  '&FuncId=PCF%2FDaily&AppName=ETF&Device=3&Platform=ETF&ticker=0050';

// Hardcoded fallback — 0050 members as of 2026-Q1
const FALLBACK_MEMBERS = [
  '2330', '2454', '2308', '2382', '3711', '2412', '1301', '1303',
  '2002', '2317', '3008', '2881', '2882', '2886', '2891', '2892',
  '2884', '2885', '2887', '2890', '5880', '2883', '1326', '1216',
  '1101', '2303', '2408', '2357', '2395', '3045', '4904', '2379',
  '5871', '2207', '6505', '5876', '2880', '1402', '6669', '2327',
  '3034', '4938', '1590', '3017', '2449', '2345', '2376', '9910',
  '2474', '1476',
];

async function fetchMembers(): Promise<{ members: string[]; nameMap: Record<string, string> }> {
  try {
    const res = await fetch(YUANTA_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json();
    const weights = json?.FundWeights?.StockWeights;
    if (!Array.isArray(weights) || !weights.length) throw new Error('empty');
    const members: string[] = [];
    const nameMap: Record<string, string> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const s of weights as any[]) {
      const code = String(s.code).trim();
      if (code) {
        members.push(code);
        if (s.name) nameMap[code] = s.name;
      }
    }
    return { members, nameMap };
  } catch {
    return { members: FALLBACK_MEMBERS, nameMap: {} };
  }
}

interface UniverseEntry {
  code: string;
  name: string;
  shares: number; // 已發行普通股數
}

// Fetch all TWSE ordinary listed stocks with shares outstanding from t187ap03_L
async function fetchTWSEUniverse(): Promise<UniverseEntry[]> {
  try {
    const res = await fetch('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', {
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any[] = await res.json();
    return data
      // Only 4-digit codes starting with 1-9 (excludes ETFs like 0050, preferred shares like 2330A)
      .filter((s: any) => /^[1-9]\d{3}$/.test(String(s['公司代號'] ?? '').trim()))
      .map((s: any) => ({
        code: String(s['公司代號']).trim(),
        name: String(s['公司簡稱'] ?? s['公司名稱'] ?? '').trim(),
        shares: Number(s['已發行普通股數或TDR原股發行股數'] ?? 0),
      }))
      .filter(s => s.code && s.name && s.shares > 0);
  } catch {
    return UNIVERSE_TICKERS.map(t => {
      const code = t.replace('.TW', '');
      return { code, name: UNIVERSE_NAMES[code] ?? code, shares: 0 };
    });
  }
}

// Fetch latest closing prices for all TWSE stocks from STOCK_DAY_ALL
async function fetchTWSEPrices(): Promise<Record<string, number>> {
  try {
    const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', {
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any[] = await res.json();
    const priceMap: Record<string, number> = {};
    for (const s of data) {
      const code = String(s.Code ?? '').trim();
      const price = parseFloat(s.ClosingPrice);
      if (/^[1-9]\d{3}$/.test(code) && !isNaN(price) && price > 0) {
        priceMap[code] = price;
      }
    }
    return priceMap;
  } catch {
    return {};
  }
}

// Fallback when TWSE APIs are geo-blocked: use Yahoo Finance quote for each universe stock.
// yf.quote() returns marketCap in TWD for .TW tickers.
async function fetchStocksViaYahoo(
  universe: UniverseEntry[],
  nameMap: Record<string, string>,
): Promise<Stock[]> {
  const BATCH = 8;
  const stocks: Stock[] = [];

  for (let i = 0; i < universe.length; i += BATCH) {
    const batch = universe.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async entry => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const q: any = await yf.quote(`${entry.code}.TW`, {}, { validateResult: false });
          if (!q?.regularMarketPrice || !q?.marketCap) return null;
          return {
            ticker: `${entry.code}.TW`,
            stockid: entry.code,
            name: nameMap[entry.code] ?? entry.name,
            marketCap: Math.round(q.marketCap / 1e8), // TWD → 億
            price: q.regularMarketPrice as number,
          };
        } catch {
          return null;
        }
      }),
    );
    for (const s of results) {
      if (s && s.marketCap > 0) stocks.push(s);
    }
  }

  return stocks;
}

export async function fetch0050Data(): Promise<{ members: string[]; stocks: Stock[] }> {
  // Fetch 0050 members, TWSE universe (with shares), and prices in parallel
  const [{ members, nameMap }, universe, priceMap] = await Promise.all([
    fetchMembers(),
    fetchTWSEUniverse(),
    fetchTWSEPrices(),
  ]);

  // Add any 0050 member codes not already in the universe
  const codeSet = new Set(universe.map(s => s.code));
  const extraMembers: UniverseEntry[] = members
    .filter(m => !codeSet.has(m))
    .map(m => ({ code: m, name: nameMap[m] ?? m, shares: 0 }));

  const allEntries = [...universe, ...extraMembers];

  const stocks: Stock[] = [];
  for (const entry of allEntries) {
    const price = priceMap[entry.code] ?? null;
    if (price === null) continue;
    const marketCap = entry.shares > 0 ? Math.round(price * entry.shares / 1e8) : 0;
    if (marketCap <= 0) continue;
    stocks.push({
      ticker: `${entry.code}.TW`,
      stockid: entry.code,
      name: nameMap[entry.code] ?? entry.name,
      marketCap,
      price,
    });
  }

  // If TWSE returned fewer than 30 stocks it was likely geo-blocked.
  // Fall back to Yahoo Finance which works from any region.
  if (stocks.length < 30) {
    const yfStocks = await fetchStocksViaYahoo(universe, nameMap);
    return { members, stocks: yfStocks };
  }

  return { members, stocks };
}
