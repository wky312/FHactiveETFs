// 國泰投信 (Cathay SITE) ETF 規模/申贖 — for 00400A 主動國泰動能高息.
//
//   GET https://cwapi.cathaysite.com.tw/api/ETF/GetETFAssets?FundCode=EA&SearchDate=YYYY-MM-DD
//       → result { preDate, fundNav, fundOutstandingShares, fundPerNav }
//
// 國泰官網**沒有**公開「與前日已發行單位差異數」，所以淨申贖是推算的：
//   netSub = (當日已發行單位數 − 前一交易日已發行單位數) × 當日每受益權單位淨資產價值
// 這與 00998A 走 CMoney 的推算法同口徑。SearchDate 就是資料日（非交易日回 result:null），
// 但**未來日期會靜默回退到最新一日**，所以每筆都要驗 preDate === 查詢日才採用。

export interface CathayDay {
  date: string;   // YYYY/MM/DD (資料日)
  netSub: number; // 億元；negative = net redemption
  aum: number;    // 億元 (fundNav / 1e8)
  pnav: number;   // 每受益權單位淨資產價值
}

interface Snapshot { units: number; nav: number; pnav: number }

const BASE = 'https://cwapi.cathaysite.com.tw/api/ETF/GetETFAssets';
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function parseNum(v: unknown): number {
  if (typeof v === 'number') return v;
  return parseFloat(String(v ?? '').replace(/,/g, '')) || 0;
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr.replace(/\//g, '-'));
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

function weekdaysBetween(start: string, end: string): string[] {
  const result: string[] = [];
  let cur = start;
  while (cur <= end) {
    const dow = new Date(cur.replace(/\//g, '-')).getDay();
    if (dow !== 0 && dow !== 6) result.push(cur);
    cur = addDays(cur, 1);
  }
  return result;
}

async function fetchSnapshot(fundCode: string, dateDash: string): Promise<Snapshot | null> {
  try {
    const res = await fetch(`${BASE}?FundCode=${encodeURIComponent(fundCode)}&SearchDate=${dateDash}`, {
      headers: { 'User-Agent': UA }, cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = await res.json();
    const r = json?.result;
    if (!r) return null;
    if (String(r.preDate ?? '').replace(/\//g, '-') !== dateDash) return null; // 回退到別日 → 丟棄

    const units = parseNum(r.fundOutstandingShares);
    const nav   = parseNum(r.fundNav);
    const pnav  = parseNum(r.fundPerNav);
    if (units === 0 || nav === 0 || pnav === 0) return null;
    return { units, nav, pnav };
  } catch {
    return null;
  }
}

export async function fetchCathayRange(
  fundCode: string,
  startDate: string, // YYYY-MM-DD (transaction date range)
  endDate: string,
): Promise<CathayDay[]> {
  // 區間最前面那天也要算差額 → 往前多抓 16 個日曆日當基準。
  // ⚠ 16 不是 10：2026 春節休 9 天，2/23 的前一交易日是 2/11（差 12 天），-10 摸不到。
  const dates = weekdaysBetween(addDays(startDate, -16), endDate);
  if (!dates.length) return [];

  const BATCH = 5;
  const snaps = new Map<string, Snapshot>();
  for (let i = 0; i < dates.length; i += BATCH) {
    const batch = dates.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(d => fetchSnapshot(fundCode, d)));
    batch.forEach((d, idx) => { const s = results[idx]; if (s) snaps.set(d, s); });
  }

  const ordered = Array.from(snaps.keys()).sort();
  const out: CathayDay[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const d = ordered[i];
    if (d < startDate || d > endDate) continue;
    const cur  = snaps.get(d)!;
    const prev = snaps.get(ordered[i - 1])!;
    out.push({
      date:   d.replace(/-/g, '/'),
      netSub: ((cur.units - prev.units) * cur.pnav) / 1e8,
      aum:    cur.nav / 1e8,
      pnav:   cur.pnav,
    });
  }
  return out;
}
