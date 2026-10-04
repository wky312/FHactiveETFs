import { Holding } from './types';
import { fetchYuantaHoldings } from './yuantaHoldings';
import { getSessionCookies, httpsPost, parseTranDate } from './ezmoneyScale';

/* 海外主動式ETF「最新一天持股」——投信官網直抓，取代 CMoney 代理。
   ──────────────────────────────────────────────────────────────────
   2026-10-04：CMoney（pocket.tw GetDtnoData）開始對所有請求回 {"Error":{"Code":101,"Message":"Auth Failed"}}，
   補 Referer/Origin 也一樣 → 海外族群曝險 10 檔只剩復華 2 檔有資料。改走各家官網：
   - 統一 ezmoney  POST GetPCF（00988A=61YTW、00411A=64YTW）
   - 元大          沿用 lib/yuantaHoldings.ts（00990A）
   - 群益          POST capitalfund buyback（00997A=502）
   - 摩根          GET am.jpmorgan.com product-data（00989A，cusip 即 ISIN）
   - 中信          POST ctbcinvestments ETFHoldingWeight（00983A=E0034，可依 StartDate 查歷史）
   - 安聯          POST allianzgi GetFundAssets（00402A=E0003，只回最新一天，要 AntiForgery cookie）
   台新 00986A 官網對海外檔只解析得到 4 檔/12%，不完整的持股比沒有更糟 → 仍無來源（同 scripts/issuers/sources.py）。

   2026-10-04 續：個股軌跡（lib/stockTrajectory.ts）與海外歸因/收盤影響/前十大（lib/overseasAttribution.ts）
   原本是「git 存檔 + CMoney 即時補到今天」，CMoney 掛掉後線上會凍結在最後一次部署那天
   （存檔是部署時打包進去的）→ 改用 fetchIssuerSince() 補「存檔最後一天之後」。

   回傳的 stockid 一律保持投信原樣（彭博式 "LITE US"、台股裸 4 碼、摩根是純美股代號），
   由 consensusOverseas 統一走 stockidToYfTicker 轉 join key。日期格式 YYYY/MM/DD。 */

export type LatestHoldings = { date: string; holdings: Holding[] } | null;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const REVALIDATE = 1800;

function twNow(): Date { return new Date(Date.now() + 8 * 3600 * 1000); }
function isoOf(d: Date): string { return d.toISOString().split('T')[0]; }
function slash(iso: string): string { return iso.slice(0, 10).replace(/-/g, '/'); }
function todaySlash(): string { return slash(isoOf(twNow())); }

function num(v: unknown): number {
  return parseFloat(String(v ?? '').replace(/[,%\s]/g, '')) || 0;
}

/** 權重 0.00% 但仍有股數的零頭部位（如 ezmoney 的 1,000 股殘量）也要留：軌跡看的是股數，
    濾掉會被畫成「已出清」。數字一律去千分位逗號（中信 qty_ 帶逗號，Number() 會變 NaN）。 */
function row(stockid: unknown, stockname: unknown, weight: unknown, qty: unknown): Holding | null {
  const id = String(stockid ?? '').trim();
  const w = num(weight), q = num(qty);
  if (!id || (w <= 0 && q <= 0)) return null;
  return { stockid: id, stockname: String(stockname ?? '').trim(), qshare: q, mvalue: 0,
           prate_addaccint: w, country: '', ftype: '' };
}

/* ── 統一 ezmoney ───────────────────────────────────────────── */
export const EZMONEY_CODES: Record<string, string> = { '00988A': '61YTW', '00411A': '64YTW', '00981A': '49YTW', '00403A': '63YTW' };

/* ⚠ 不帶 session cookie 直接 POST 會被無限 302（undici 報 redirect count exceeded），
   所以沿用 lib/ezmoneyScale.ts 的 cookie 流程（先 GET / 與 PCF 頁拿 __nxquid、ASP.NET_SessionId）。 */
/** specificDate=false 一律回最新一份（忽略 date）；=true 才回該公告日的清單 → 逐日回補要用 true。 */
async function ezmoneyOne(fundCode: string, d: Date, cookies: string, specificDate = false): Promise<LatestHoldings> {
  try {
    const roc = `${d.getUTCFullYear() - 1911}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
    const raw = await httpsPost('/ETF/Transaction/GetPCF',
      Buffer.from(JSON.stringify({ fundCode, date: roc, specificDate }), 'utf8'),
      cookies, `/ETF/Transaction/PCF?fundCode=${fundCode}`);
    if (!raw.trim().startsWith('{')) { console.warn(`[ezmoney ${fundCode} ${roc}] non-JSON:`, raw.slice(0, 120)); return null; }
    const j = JSON.parse(raw);
    const st = (j?.asset ?? []).find((a: { AssetCode?: string }) => String(a?.AssetCode).toUpperCase() === 'ST');
    const details: Record<string, unknown>[] = st?.Details ?? [];
    const date = parseTranDate(details[0]?.TranDate);
    if (!date || date < '2000') return null;   // 未來公告日回 0001-01-01 空殼
    const holdings = details.map(h => row(h.DetailCode, h.DetailName, h.NavRate, h.Share)).filter((h): h is Holding => !!h);
    return holdings.length ? { date, holdings } : null;
  } catch {
    return null;
  }
}

/** 公告日從 4 天後往回掃到 9 天前（平日），取自報交易日最新且不晚於今天者（同 tw-market-data 鐵律：日期只信 API 自報）。 */
export async function fetchLatestEzmoney(ticker: string): Promise<LatestHoldings> {
  const code = EZMONEY_CODES[ticker];
  if (!code) return null;
  const days: Date[] = [];
  for (let off = 4; off >= -9; off--) {
    const d = twNow(); d.setUTCDate(d.getUTCDate() + off);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(d);
  }
  // 依序由新到舊查（TranDate ≤ 公告日，所以第一個 ≤ 今天的有效結果就是最新的一天）。
  // ⚠ 不可一次平行打：本機 OK，但從 Vercel(iad1) 平行 14 發會整批拿不到。
  const today = todaySlash();
  const cookies = await getSessionCookies(code).catch(() => '');
  for (const d of days) {
    const r = await ezmoneyOne(code, d, cookies);
    if (r && r.date <= today) return r;
  }
  console.warn(`[ezmoney ${ticker}] no holdings in ${days.length} announce dates (cookies=${cookies ? 'yes' : 'none'})`);
  return null;
}

/* ── 元大 ────────────────────────────────────────────────────── */
export async function fetchLatestYuanta(ticker: string): Promise<LatestHoldings> {
  const since = twNow(); since.setUTCDate(since.getUTCDate() - 12);
  const byDate = await fetchYuantaHoldings(ticker, isoOf(since));
  const today = todaySlash();
  const latest = [...byDate.keys()].filter(d => d <= today).sort().at(-1);
  return latest ? { date: latest, holdings: byDate.get(latest)! } : null;
}

/* ── 群益 ────────────────────────────────────────────────────── */
export const CAPITAL_FUNDS: Record<string, string> = { '00997A': '502' };

/** 只回最新一份清單。⚠ date1 是清單生效日（下一交易日），持股日要用 pcf.date2。 */
export async function fetchLatestCapital(ticker: string): Promise<LatestHoldings> {
  const fundId = CAPITAL_FUNDS[ticker];
  if (!fundId) return null;
  try {
    const res = await fetch('https://www.capitalfund.com.tw/CFWeb/api/etf/buyback', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fundId }),
      next: { revalidate: REVALIDATE },
    });
    if (!res.ok) return null;
    const data = (await res.json())?.data;
    const d2 = String(data?.pcf?.date2 ?? '');
    if (!/^\d{4}-\d\d-\d\d/.test(d2)) return null;
    const holdings = ((data?.stocks ?? []) as Record<string, unknown>[])
      .map(h => row(h.stocNo, h.stocName, h.weight, h.share)).filter((h): h is Holding => !!h);
    return holdings.length ? { date: slash(d2), holdings } : null;
  } catch {
    return null;
  }
}

/* ── 摩根 ────────────────────────────────────────────────────── */
export const JPM_CUSIPS: Record<string, string> = { '00989A': 'TW00000989A5' };

export async function fetchLatestJpm(ticker: string): Promise<LatestHoldings> {
  const cusip = JPM_CUSIPS[ticker];
  if (!cusip) return null;
  try {
    const url = `https://am.jpmorgan.com/FundsMarketingHandler/product-data?cusip=${cusip}&country=tw&role=twetf&language=zh&userLoggedIn=false&version=9.11_1`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, next: { revalidate: REVALIDATE } });
    if (!res.ok) return null;
    const rows: Record<string, unknown>[] = (await res.json())?.fundData?.holdings?.pcfEquityHoldings?.data ?? [];
    const nav = String(rows[0]?.navDate ?? '');
    if (!/^\d{4}-\d\d-\d\d/.test(nav)) return null;
    const holdings = rows.map(h => row(h.securityTicker, h.securityDescription, h.marketValuePercent, h.shares))
      .filter((h): h is Holding => !!h);
    return holdings.length ? { date: slash(nav), holdings } : null;
  } catch {
    return null;
  }
}

/* ── 中信 ────────────────────────────────────────────────────── */
export const CTBC_FIDS: Record<string, string> = { '00983A': 'E0034' };
const CTBC_API = 'https://www.ctbcinvestments.com.tw/API';

async function ctbcToken(): Promise<string | null> {
  try {
    const res = await fetch(`${CTBC_API}/home/AuthToken?token=www.ctbcinvestments.com`, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json; charset=utf-8', Referer: 'https://www.ctbcinvestments.com.tw/Etf/Combination' },
      body: JSON.stringify({ token: 'www.ctbcinvestments.com' }),
      cache: 'no-store',
    });
    return (await res.json())?.Data?.token ?? null;
  } catch {
    return null;
  }
}

/** ⚠ StartDate 必帶（少帶回「SqlDateTime 溢位」）。資料日以回應的 FundAssets[0].資料日期 為準。 */
async function ctbcOne(fid: string, token: string, dateIso: string): Promise<LatestHoldings> {
  try {
    const res = await fetch(`${CTBC_API}/etf/ETFHoldingWeight?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json; charset=utf-8', Referer: 'https://www.ctbcinvestments.com.tw/Etf/Combination' },
      body: JSON.stringify({ FID: fid, StartDate: dateIso }),
      next: { revalidate: REVALIDATE },
    });
    if (!res.ok) return null;
    const D = (await res.json())?.Data ?? {};
    const raw = String(D?.FundAssets?.[0]?.['資料日期'] ?? '');
    const m = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (!m) return null;
    const date = `${m[1]}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}`;
    const holdings: Holding[] = [];
    for (const g of D?.FundAssetsDetail ?? []) {
      if (String(g?.Code ?? '').toUpperCase() !== 'STOCK') continue;
      for (const r of g?.Data ?? []) {
        const h = row(String(r?.code_ ?? '').toUpperCase(), r?.name_, r?.weights_, r?.qty_);
        if (h && h.qshare > 0) holdings.push(h);
      }
    }
    return holdings.length ? { date, holdings } : null;
  } catch {
    return null;
  }
}

/* ── 安聯 ────────────────────────────────────────────────────── */
export const ALLIANZ_FUNDIDS: Record<string, string> = { '00402A': 'E0003' };

/** 先 GET AntiForgery 拿 cookie，再帶 X-XSRF-TOKEN POST。⚠ body 是 FundID（FundNo 回查無資料）。
    Table 有兩張、不可寫死索引：挑欄名含「代號」與「股數」的那張。 */
export async function fetchLatestAllianz(ticker: string): Promise<LatestHoldings> {
  const fundId = ALLIANZ_FUNDIDS[ticker];
  if (!fundId) return null;
  const b = 'https://etf.allianzgi.com.tw/webapi/api';
  try {
    const r0 = await fetch(`${b}/AntiForgery/GetAntiForgeryToken`, { headers: { 'User-Agent': UA }, cache: 'no-store' });
    const set = r0.headers.getSetCookie();
    const cookie = set.map(c => c.split(';')[0]).join('; ');
    const xsrf = set.map(c => c.split(';')[0]).find(c => c.startsWith('X-XSRF-TOKEN='))?.slice('X-XSRF-TOKEN='.length) ?? '';
    const res = await fetch(`${b}/Fund/GetFundAssets`, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Cookie: cookie, 'X-XSRF-TOKEN': decodeURIComponent(xsrf),
                 Referer: 'https://etf.allianzgi.com.tw/' },
      body: JSON.stringify({ FundID: fundId }),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const E = (await res.json())?.Entries?.Data ?? {};
    const m = String(E?.FundAsset?.NavDate ?? '').match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (!m) return null;
    const date = `${m[1]}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}`;
    const idx = (cols: string[], keys: string[]) => cols.findIndex(c => keys.some(k => c.includes(k)));
    for (const t of E?.Table ?? []) {
      const cols: string[] = (t?.Columns ?? []).map((c: { Name?: string }) => String(c?.Name ?? ''));
      const ci = { code: idx(cols, ['代號', '代碼']), name: idx(cols, ['名稱']), sh: idx(cols, ['股數']), wt: idx(cols, ['權重', '比重']) };
      if (ci.code < 0 || ci.sh < 0) continue;
      const need = Math.max(ci.code, ci.name, ci.sh, ci.wt);
      const holdings: Holding[] = [];
      for (const r of t?.Rows ?? []) {
        if (!Array.isArray(r) || r.length <= need) continue;
        const h = row(String(r[ci.code]).toUpperCase(), ci.name >= 0 ? r[ci.name] : '',
                      ci.wt >= 0 ? String(r[ci.wt]).replace(/[,%]/g, '') : 0, String(r[ci.sh]).replace(/,/g, ''));
        if (h && h.qshare > 0) holdings.push(h);
      }
      if (holdings.length) return { date, holdings };
    }
    return null;
  } catch {
    return null;
  }
}

/* ── 通用：補「存檔最後一天之後」到今天 ───────────────────────── */
const MAX_SCAN_DAYS = 30;   // 部署落後太久時只補最近 30 個平日，避免單次請求掃太久

function weekdaysAfter(sinceSlash: string, extraAhead: number): string[] {
  const out: string[] = [];
  const d = new Date(sinceSlash.replace(/\//g, '-') + 'T00:00:00Z');
  const end = twNow(); end.setUTCDate(end.getUTCDate() + extraAhead);
  const endIso = isoOf(end);
  for (d.setUTCDate(d.getUTCDate() + 1); isoOf(d) <= endIso; d.setUTCDate(d.getUTCDate() + 1)) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(isoOf(d));
  }
  return out.slice(-MAX_SCAN_DAYS);
}

/** 是否有官網即時來源（給呼叫端決定要不要補）。 */
export function hasIssuerSource(ticker: string): boolean {
  return !!(EZMONEY_CODES[ticker] || CTBC_FIDS[ticker] || ALLIANZ_FUNDIDS[ticker] || CAPITAL_FUNDS[ticker]
    || JPM_CUSIPS[ticker] || ticker === '00990A');
}

/** 回傳 sinceSlash（不含）之後到今天的逐日持股（YYYY/MM/DD → Holding[]）。
    可依日期查的來源（ezmoney/中信/元大）逐日補；只給最新一天的（群益/摩根/安聯）只補最新那天。
    一律依序打（ezmoney 從 Vercel 平行打會整批失敗）。 */
export async function fetchIssuerSince(ticker: string, sinceSlash: string): Promise<Map<string, Holding[]>> {
  const out = new Map<string, Holding[]>();
  const today = todaySlash();
  const put = (r: LatestHoldings) => { if (r && r.date > sinceSlash && r.date <= today) out.set(r.date, r.holdings); };
  try {
    if (EZMONEY_CODES[ticker]) {
      const code = EZMONEY_CODES[ticker];
      const cookies = await getSessionCookies(code).catch(() => '');
      for (const iso of weekdaysAfter(sinceSlash, 4)) put(await ezmoneyOne(code, new Date(iso + 'T00:00:00Z'), cookies, true));
    } else if (CTBC_FIDS[ticker]) {
      const token = await ctbcToken();
      if (token) for (const iso of weekdaysAfter(sinceSlash, 0)) put(await ctbcOne(CTBC_FIDS[ticker], token, iso));
    } else if (ticker === '00990A') {
      const m = await fetchYuantaHoldings(ticker, sinceSlash.replace(/\//g, '-'));
      for (const [d, h] of m) put({ date: d, holdings: h });
    } else if (CAPITAL_FUNDS[ticker]) {
      put(await fetchLatestCapital(ticker));
    } else if (JPM_CUSIPS[ticker]) {
      put(await fetchLatestJpm(ticker));
    } else if (ALLIANZ_FUNDIDS[ticker]) {
      put(await fetchLatestAllianz(ticker));
    }
  } catch {
    // 單一來源失敗不擋整頁：回傳已補到的部分，呼叫端照樣用存檔
  }
  return out;
}

/** 中信最新一天（族群曝險用）。 */
export async function fetchLatestCtbc(ticker: string): Promise<LatestHoldings> {
  const fid = CTBC_FIDS[ticker];
  if (!fid) return null;
  const token = await ctbcToken();
  if (!token) return null;
  return ctbcOne(fid, token, isoOf(twNow()));
}
