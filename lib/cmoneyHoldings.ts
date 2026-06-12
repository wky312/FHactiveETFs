import { Holding } from './types';

/* 透過 CMoney（口袋證券 pocket.tw 代理）抓非復華 ETF 的每日個股持股。
   統一等投信官網只給「最新一天」持股，但 CMoney 保留逐日歷史（一次呼叫即回整段），
   可用來組個股軌跡並回補歷史。資料形狀對齊 lib/fhtrust.ts 的 Holding。 */

const CMONEY_API = 'https://www.pocket.tw/api/cm/MobileService/ashx/GetDtnoData.ashx';
const DTNO_HOLDINGS = '59449513'; // M722：['日期','標的代號','標的名稱','權重(%)','持有數','單位']

// fundId → CMoney AssignID（多為股票代號本身）
export const CMONEY_FUNDS: Record<string, string> = {
  '00981A': '00981A', // 主動統一台股增長（成立 2025/05，CMoney 自 2025/05/26 起有逐日持股）
};

function parseNum(v: unknown): number {
  return parseFloat(String(v).replace(/,/g, '')) || 0;
}

function ymdToSlash(d: string): string {
  // '20260612' → '2026/06/12'
  return `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`;
}

/* 回傳 date(YYYY/MM/DD) → Holding[]。dtRange = 要回幾個交易日（400 ≈ 涵蓋全歷史）。 */
export async function fetchCmoneyHoldings(assignId: string, dtRange = 400): Promise<Map<string, Holding[]>> {
  const param = `AssignID=${assignId};MTPeriod=0;DTMode=0;DTRange=${dtRange};DTOrder=1;MajorTable=M722;`;
  const url = `${CMONEY_API}?action=getdtnodata&DtNo=${DTNO_HOLDINGS}&ParamStr=${encodeURIComponent(param)}&FilterNo=0`;

  const byDate = new Map<string, Holding[]>();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, next: { revalidate: 1800 } });
    if (!res.ok) return byDate;
    const json = await res.json();
    const rows: unknown[][] = Array.isArray(json?.Data) ? json.Data : [];
    for (const r of rows) {
      const date   = ymdToSlash(String(r[0]));
      const stockid = String(r[1] ?? '').trim();
      if (!stockid) continue;
      const holding: Holding = {
        stockid,
        stockname: String(r[2] ?? '').trim(),
        qshare: parseNum(r[4]),               // 持有數（股）
        mvalue: 0,                            // CMoney 不提供市值；軌跡端以股數×收盤估算
        prate_addaccint: parseNum(r[3]),      // 權重(%)
        country: '',
        ftype: '',
      };
      const arr = byDate.get(date);
      if (arr) arr.push(holding); else byDate.set(date, [holding]);
    }
  } catch {
    // 網路/格式異常 → 回傳已累積的（可能為空），由呼叫端決定 fallback
  }
  return byDate;
}
