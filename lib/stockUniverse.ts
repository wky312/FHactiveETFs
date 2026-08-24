import { fetchTwseShares, isOrdinary } from './marketCapRanking';

/* 全台股（上市+上櫃）代碼＋名稱清單，給「個股軌跡」的搜尋自動完成用。
   TWSE 端複用 marketCapRanking 的 t187ap03_L 抓取（公司簡稱已是短名，如「台泥」）。
   TPEX 端自己另外打 mopsfin_t187ap03_O，取 CompanyAbbreviation（簡稱，如「台燿」）而非
   CompanyName（會是「台燿科技股份有限公司」全稱）——marketCapRanking.fetchTpexShares 拿的是全稱，
   算市值沒差，但拿來當自動完成顯示名稱會太長，故不共用那支。
   記憶體快取 6 小時（公司清單變動很慢，沒必要每次都重打 openapi）。 */

export interface UniverseStock {
  code: string;
  name: string;
  market: '上市' | '上櫃';
}

let _cache: { ts: number; data: UniverseStock[] } | null = null;
const TTL_MS = 6 * 60 * 60 * 1000;

async function fetchTpexAbbrev(): Promise<Map<string, string>> {
  const res = await fetch('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O', {
    signal: AbortSignal.timeout(15000),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`TPEX mopsfin_t187ap03_O HTTP ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any[] = await res.json();
  const out = new Map<string, string>();
  for (const r of data) {
    const code = String(r.SecuritiesCompanyCode ?? '').trim();
    const name = String(r.CompanyAbbreviation ?? r.CompanyName ?? '').trim();
    if (code && name) out.set(code, name);
  }
  return out;
}

export async function fetchStockUniverse(): Promise<UniverseStock[]> {
  if (_cache && Date.now() - _cache.ts < TTL_MS) return _cache.data;

  const [twse, tpex] = await Promise.all([fetchTwseShares(), fetchTpexAbbrev()]);
  const out: UniverseStock[] = [];
  for (const [code, info] of twse) {
    if (isOrdinary(code, info.name)) out.push({ code, name: info.name, market: '上市' });
  }
  for (const [code, name] of tpex) {
    if (!twse.has(code) && isOrdinary(code, name)) out.push({ code, name, market: '上櫃' });
  }
  out.sort((a, b) => a.code.localeCompare(b.code));

  _cache = { ts: Date.now(), data: out };
  return out;
}
