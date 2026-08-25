// 摩根投信 (J.P. Morgan Asset Management Taiwan) ETF 官方申購買回清單 (PCF) — 00989A 主動摩根美國科技。
// 官網 API：GET https://am.jpmorgan.com/FundsMarketingHandler/product-data?cusip={CUSIP}&country=tw&role=twetf&language=zh
// 這支 API 沒有依日期查詢的參數，只會回「目前最新一筆」正式公告的資料——資料日期藏在
// fundData.breakdowns.m12Details.data 陣列裡「YYYY/MM/DD 每受益權單位淨資產價值(元)」這個
// 欄位的 name 前綴（跟台新的網頁同一種標籤前綴慣例，只是這裡是 JSON 不是 HTML）。
// 沒有「查未來公告日」的問題（沒有日期參數可查），只可能拿到已經真正發生的資料日，或還沒公告。
//
// 因為沒有依日期查詢的能力，抓不到完整區間，只能拿到「最新一筆正式值」；區間內其餘天數
// 用 CMoney 規模/淨值反推頂著（跟 daily_summary.py 的 fetch_jpmorgan_estimate 同一套邏輯），
// 最新一筆若剛好落在查詢區間內，就用官方值覆蓋掉 CMoney 估計值。

import { fetchCmoneyScaleRange } from './cmoneyScale';

export interface JpmorganDay {
  date: string;   // YYYY/MM/DD
  netSub: number; // 億元
  aum: number;    // 億元
  pnav: number;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// cusip → CMoney AssignID（目前只有 00989A 一檔；未來若再有摩根的主動式ETF在此補上）。
const CUSIP_TO_TICKER: Record<string, string> = {
  'TW00000989A5': '00989A',
};

function parseNum(v: unknown): number {
  const s = String(v ?? '');
  const neg = /\(.*\)/.test(s) || s.includes('−') || /^-/.test(s.trim());
  const n = parseFloat(s.replace(/[,\s()]/g, '').replace(/[^0-9.\-]/g, '')) || 0;
  return neg ? -Math.abs(n) : n;
}

interface PcfRow { name?: string; displayValue?: string }

async function fetchOfficial(cusip: string): Promise<JpmorganDay | null> {
  try {
    const url = `https://am.jpmorgan.com/FundsMarketingHandler/product-data?cusip=${encodeURIComponent(cusip)}&country=tw&role=twetf&language=zh&userLoggedIn=false`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    const rows: PcfRow[] = json?.fundData?.breakdowns?.m12Details?.data ?? [];
    if (!rows.length) return null;

    const byName = new Map(rows.map(r => [r.name ?? '', r.displayValue]));
    let navDate: string | null = null;
    let pnav = 0;
    for (const r of rows) {
      const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s*每受益權單位淨資產價值/.exec(r.name ?? '');
      if (m) {
        navDate = `${m[1]}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}`;
        pnav = parseNum(r.displayValue);
      }
    }
    if (!navDate || pnav === 0) return null;

    const diff = parseNum(byName.get('與前日已發行單位差異數'));
    const nav  = parseNum(byName.get('基金淨資產價值(元)'));
    if (nav === 0) return null;

    return { date: navDate, netSub: (diff * pnav) / 1e8, aum: nav / 1e8, pnav };
  } catch {
    return null;
  }
}

export async function fetchJpmorganRange(
  cusip: string,
  startDate: string, // YYYY-MM-DD
  endDate: string,
): Promise<JpmorganDay[]> {
  const ticker = CUSIP_TO_TICKER[cusip] ?? cusip;
  const [cmoneyRows, official] = await Promise.all([
    fetchCmoneyScaleRange(ticker, startDate, endDate),
    fetchOfficial(cusip),
  ]);

  const byDate = new Map<string, JpmorganDay>(cmoneyRows.map(r => [r.date, r]));
  if (official) {
    const officialDash = official.date.replace(/\//g, '-');
    if (officialDash >= startDate && officialDash <= endDate) byDate.set(official.date, official);
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}
