// 野村投信 (Nomura Asset Management Taiwan) ETF 申購買回清單 (PCF) scraper
// — for 00980A 主動野村臺灣優選 / 00985A 主動野村台灣50 / 00999A 主動野村臺灣高息.
//
//   POST /API/ETFAPI/api/Fund/GetFundTradeInfo
//        body {"Type":1,"Keyword":"","FundNo":"00980A","Date":"YYYY/MM/DD"} → { Entries:{…} }
//
// ⚠️ `Date` is the DISCLOSURE date (公告日), not the transaction date: the PCF published on
// 7/28 carries 7/27's figures. `Entries.CNavDtStr` is the authoritative data date, so we query
// disclosure-day candidates and key every row by CNavDtStr instead of by what we asked for.
// (Same vendor platform as 安聯 — identical CAnce* field names.)

export interface NomuraDay {
  date: string;   // YYYY/MM/DD (資料日 = CNavDtStr)
  netSub: number; // 億元 (CAnceIssuesDiff × CAnceNav / 1e8); negative = net redemption
  aum: number;    // 億元 (CAnceTotalAv / 1e8)
  pnav: number;   // CAnceNav per unit
}

const URL = 'https://www.nomurafunds.com.tw/API/ETFAPI/api/Fund/GetFundTradeInfo';
const UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

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

async function fetchOneAnnounce(fundNo: string, announceDash: string): Promise<NomuraDay | null> {
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: {
        'User-Agent':   UA,
        'Content-Type': 'application/json',
        'Referer':      'https://www.nomurafunds.com.tw/ETFWEB/pcf',
      },
      body: JSON.stringify({ Type: 1, Keyword: '', FundNo: fundNo, Date: announceDash.replace(/-/g, '/') }),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = await res.json();
    const e = json?.Entries;
    if (!e || e.CAnceNav == null) return null;

    const navDate = String(e.CNavDtStr ?? String(e.CNavDt ?? '').slice(0, 10).replace(/-/g, '/'));
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(navDate)) return null;

    const nav     = Number(e.CAnceNav) || 0;
    const totalav = Number(e.CAnceTotalAv) || 0;
    if (nav === 0 || totalav === 0) return null;

    return {
      date:   navDate,
      netSub: ((Number(e.CAnceIssuesDiff) || 0) * nav) / 1e8,
      aum:    totalav / 1e8,
      pnav:   nav,
    };
  } catch {
    return null;
  }
}

export async function fetchNomuraRange(
  fundNo: string,
  startDate: string, // YYYY-MM-DD (transaction date range)
  endDate: string,
): Promise<NomuraDay[]> {
  // 公告日候選 = 交易日區間往後推 5 個日曆日，涵蓋連假；再用 CNavDtStr 篩回區間內。
  const announces = weekdaysBetween(addDays(startDate, 1), addDays(endDate, 5));
  if (!announces.length) return [];

  const startSlash = startDate.replace(/-/g, '/');
  const endSlash   = endDate.replace(/-/g, '/');
  const BATCH = 5;
  const byDate = new Map<string, NomuraDay>();
  for (let i = 0; i < announces.length; i += BATCH) {
    const batch = announces.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(d => fetchOneAnnounce(fundNo, d)));
    for (const r of results) {
      if (r && r.date >= startSlash && r.date <= endSlash) byDate.set(r.date, r);
    }
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}
