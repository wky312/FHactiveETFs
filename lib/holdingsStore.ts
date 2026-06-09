import path from 'path';
import fs from 'fs';

/* 讀取每日存檔（data/holdings/{fundId}.json），由 scripts/update_holdings.py 產生。
   格式：{ fundId, names: {stockid:name}, days: { 'YYYY/MM/DD': [{c,q,m,p}] } }
   讀法比照 lib/country.ts —— 從打包進 bundle 的檔以 fs 讀取，模組內快取。 */

export interface StoredRecord { c: string; q: number; m: number; p: number }
export interface StoredHoldings {
  fundId: string;
  names: Record<string, string>;
  days: Record<string, StoredRecord[]>;
}

const _cache = new Map<string, StoredHoldings | null>();

export function loadStoredHoldings(fundId: string): StoredHoldings | null {
  if (_cache.has(fundId)) return _cache.get(fundId)!;
  let result: StoredHoldings | null = null;
  try {
    const p = path.join(process.cwd(), 'data', 'holdings', `${fundId}.json`);
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as StoredHoldings;
    if (data && data.days && Object.keys(data.days).length > 0) result = data;
  } catch {
    result = null;
  }
  _cache.set(fundId, result);
  return result;
}
