import { fetchAdjCloseSeries } from './yahooFinance';
import { stockidToYfTicker, getSuffixCurrency, TW_BARE_CODE } from './exchangeMap';

/* 海外個股歸因的換匯層 —— 把各持股「當地幣別的還原報酬」換算成新台幣（基金 NAV 計價幣別）。
   資料源：Yahoo Finance 的外匯代號（`USDTWD=X` 等於 `TWD=X`；`<CCY>TWD=X`）。
   國內 lib/attribution.ts 完全沒有換匯，這支是海外版獨有。 */

// 匯率合理區間（1 單位外幣 = ? 新台幣）。抓到的序列若整段落在區間外 → 多半是抓錯代號 /
// 拿到便士報價 / 方向相反，印警告方便排查（不阻擋計算，畢竟區間只是粗略護欄）。
const SANE_BAND: Record<string, [number, number]> = {
  USD: [28, 35], JPY: [0.17, 0.26], KRW: [0.018, 0.028], HKD: [3.4, 4.6],
  CNY: [3.8, 5.0], EUR: [30, 39], GBP: [36, 45], AUD: [18, 24], SGD: [21, 27],
  CHF: [32, 42], CAD: [20, 26], SEK: [2.6, 3.6], TWD: [1, 1],
};

// 某些幣別 Yahoo 沒有直接的 `<CCY>TWD=X`，一律走「USD 交叉」：CCY→TWD = (USD→TWD) / (USD→CCY)。
// USDxxx=X 幾乎都抓得到，所以交叉法是可靠的後備。
const _cache = new Map<string, Map<string, number>>();

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 逐「日曆日」前向填補（假日/資料缺口沿用上一個有值日），對齊 lib/stockTrajectory.ts forwardFill。
function forwardFill(raw: Map<string, number>, start: Date, end: Date): Map<string, number> {
  const filled = new Map<string, number>();
  if (raw.size === 0) return filled;
  let last: number | null = null;
  const cur = new Date(start);
  while (cur.getTime() <= end.getTime()) {
    const key = `${cur.getFullYear()}/${String(cur.getMonth() + 1).padStart(2, '0')}/${String(cur.getDate()).padStart(2, '0')}`;
    if (raw.has(key)) last = raw.get(key)!;
    if (last !== null) filled.set(key, last);
    cur.setDate(cur.getDate() + 1);
  }
  return filled;
}

/** 由彭博式 stockid 推出計價幣別。裸 4 碼台股 → 'TWD'；裸英文代號（如 00989A 的 'NVDA'，
    CMoney 對部分投信不帶 ' US' 後綴）→ 'USD'；查不到 → null（該持股會被排除）。 */
export function currencyForStockid(stockid: string): string | null {
  const s = stockid.trim();
  const { suffix } = stockidToYfTicker(s);
  if (suffix) return getSuffixCurrency(suffix);
  if (TW_BARE_CODE.test(s.toUpperCase())) return 'TWD';
  if (/^[A-Za-z][A-Za-z.\-]{0,5}$/.test(s)) return 'USD';
  return null;
}

/** 回傳 date('YYYY/MM/DD') → 「1 單位 ccy = ? 新台幣」，已前向填補整個 [from,end] 日曆區間。
    ccy === 'TWD' → 全 1（不打 Yahoo）。抓不到 → 回空 Map，呼叫端據此把該幣別持股列為排除。 */
export async function fetchFxSeries(ccy: string, from: Date, to: Date): Promise<Map<string, number>> {
  if (ccy === 'TWD') {
    // 合成一條全 1 序列
    const m = new Map<string, number>();
    const cur = new Date(from);
    while (cur.getTime() <= to.getTime()) {
      m.set(`${cur.getFullYear()}/${String(cur.getMonth() + 1).padStart(2, '0')}/${String(cur.getDate()).padStart(2, '0')}`, 1);
      cur.setDate(cur.getDate() + 1);
    }
    return m;
  }

  const cacheKey = `${ccy}|${iso(from)}|${iso(to)}`;
  const hit = _cache.get(cacheKey);
  if (hit) return hit;

  let raw = new Map<string, number>();

  // 1) 直接抓 <CCY>TWD=X
  const direct = await fetchAdjCloseSeries(`${ccy}TWD=X`, from, to, '1d').catch(() => []);
  for (const b of direct) if (Number.isFinite(b.close) && b.close > 0) raw.set(b.date, b.close);

  // 2) 抓不到 → USD 交叉：CCY→TWD = (USD→TWD) / (USD→CCY)
  if (raw.size === 0) {
    const [usdTwd, usdCcy] = await Promise.all([
      fetchAdjCloseSeries('TWD=X', from, to, '1d').catch(() => []),
      fetchAdjCloseSeries(`${ccy}=X`, from, to, '1d').catch(() => []),
    ]);
    const twd = new Map(usdTwd.map(b => [b.date, b.close]));
    const loc = new Map(usdCcy.map(b => [b.date, b.close]));
    raw = new Map();
    for (const [d, t] of twd) {
      const l = loc.get(d);
      if (Number.isFinite(t) && Number.isFinite(l) && (l as number) > 0) raw.set(d, t / (l as number));
    }
  }

  const filled = forwardFill(raw, from, to);

  // 合理區間護欄（僅警告）
  const band = SANE_BAND[ccy];
  if (band && filled.size) {
    const vals = [...filled.values()];
    const mid = vals[Math.floor(vals.length / 2)];
    if (mid < band[0] || mid > band[1]) {
      console.warn(`[fx] ${ccy}→TWD 中位數 ${mid.toFixed(4)} 落在合理區間 [${band[0]}, ${band[1]}] 之外，請覆核代號/方向`);
    }
  }

  _cache.set(cacheKey, filled);
  return filled;
}
