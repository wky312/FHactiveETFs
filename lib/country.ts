import path from 'path';
import fs from 'fs';

let _cache: Record<string, string> | null = null;

function loadCache(): Record<string, string> {
  if (_cache) return _cache;
  try {
    const p = path.join(process.cwd(), 'data', 'country_cache.json');
    _cache = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    _cache = {};
  }
  return _cache!;
}

export function getCountry(ticker: string): string | null {
  return loadCache()[ticker] ?? null;
}
