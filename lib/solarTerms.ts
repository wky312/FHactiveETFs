/* 二十四節氣：以太陽視黃經（每 15° 一個）推算，換算成台北日期。
   節（月初，黃經 315°+30°k）與氣（月中，黃經 330°+30°k）分開標示。 */

export interface SolarTerm { name: string; kind: '節' | '氣' }

/* 黃經 0° 起算：春分、清明、穀雨… 共 24 個 */
const TERMS: SolarTerm[] = [
  { name: '春分', kind: '氣' }, { name: '清明', kind: '節' }, { name: '穀雨', kind: '氣' }, { name: '立夏', kind: '節' },
  { name: '小滿', kind: '氣' }, { name: '芒種', kind: '節' }, { name: '夏至', kind: '氣' }, { name: '小暑', kind: '節' },
  { name: '大暑', kind: '氣' }, { name: '立秋', kind: '節' }, { name: '處暑', kind: '氣' }, { name: '白露', kind: '節' },
  { name: '秋分', kind: '氣' }, { name: '寒露', kind: '節' }, { name: '霜降', kind: '氣' }, { name: '立冬', kind: '節' },
  { name: '小雪', kind: '氣' }, { name: '大雪', kind: '節' }, { name: '冬至', kind: '氣' }, { name: '小寒', kind: '節' },
  { name: '大寒', kind: '氣' }, { name: '立春', kind: '節' }, { name: '雨水', kind: '氣' }, { name: '驚蟄', kind: '節' },
];

const RAD = Math.PI / 180;
const norm = (x: number) => ((x % 360) + 360) % 360;

/* 太陽視黃經（Meeus 低精度公式，誤差約 0.01° ≈ 15 分鐘）；jd 為儒略日 */
function sunLongitude(jd: number): number {
  const T = (jd - 2451545.0) / 36525;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * RAD;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  const omega = (125.04 - 1934.136 * T) * RAD;
  return norm(L0 + C - 0.00569 - 0.00478 * Math.sin(omega));
}

const jdOf = (ms: number) => ms / 86400000 + 2440587.5;

/* 求某年太陽黃經到達 target 度的時刻（UTC ms）：先抓大致日期，再二分逼近 */
function termTimeMs(year: number, target: number): number {
  // 黃經 0° ≈ 3/20；每度約 1.0146 天
  const base = Date.UTC(year, 2, 20, 12);
  let guess = base + norm(target) * (365.2422 / 360) * 86400000;
  if (target >= 285) guess -= 365.2422 * 86400000; // 小寒/大寒/立春… 落在同一西曆年的年初
  let lo = guess - 12 * 86400000, hi = guess + 12 * 86400000;
  const diff = (ms: number) => ((sunLongitude(jdOf(ms)) - target + 540) % 360) - 180;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (diff(mid) < 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

const cache = new Map<number, Map<string, SolarTerm>>();

/* 該西曆年所有節氣：台北日期 YYYY-MM-DD → 節氣 */
export function solarTermsOfYear(year: number): Map<string, SolarTerm> {
  const hit = cache.get(year);
  if (hit) return hit;
  const map = new Map<string, SolarTerm>();
  TERMS.forEach((t, i) => {
    const ms = termTimeMs(year, i * 15);
    const ymd = new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);   // UTC+8
    if (ymd.startsWith(`${year}-`)) map.set(ymd, t);
  });
  cache.set(year, map);
  return map;
}

export const solarTermOn = (ymd: string): SolarTerm | undefined => solarTermsOfYear(Number(ymd.slice(0, 4))).get(ymd);
