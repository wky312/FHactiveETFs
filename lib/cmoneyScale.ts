// CMoney (pocket.tw 代理) 申贖推算 — 給沒有官方逐日申贖來源的 ETF，目前用於 00998A 主動復華全球金融
// （其投信 fhtrust PCF 不提供申贖欄位）。CMoney 提供逐日「資產規模(億)」與「淨值」兩條歷史序列：
//   受益權單位數 units = 資產規模(元) / 淨值；淨申贖(億) = Δunits × 淨值 / 1e8
// Δunits×NAV 只反映真實申購/買回（已排除市值波動），但因規模僅到 0.01 億，淨申贖約有 ±0.01 億的取整噪音。

const CMONEY_API = 'https://www.pocket.tw/api/cm/MobileService/ashx/GetDtnoData.ashx';
const DTNO_AUM = '60465380';                 // Data[]: [日期,名稱,代號,收盤,漲跌,漲幅,成交量,資產規模(億),…]
const DTNO_NAV = '61498322';                 // MajorTable=M708, Data[]: [日期,收盤價,淨值,折溢價(%)]
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface CmoneyScaleDay {
  date: string;   // YYYY/MM/DD (trade date)
  netSub: number; // 億元 (Δunits × NAV / 1e8); negative = net redemption
  aum: number;    // 億元
  pnav: number;   // NAV per unit
}

function parseNum(v: unknown): number {
  return parseFloat(String(v ?? '').replace(/,/g, '')) || 0;
}
function ymdToSlash(d: string): string {
  return `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`;
}

async function fetchSeries(dtNo: string, assignId: string, major: string): Promise<unknown[][]> {
  const major2 = major ? `;MajorTable=${major}` : '';
  const param = `AssignID=${assignId};DTRange=500;MTPeriod=0;DTMode=0;DTOrder=1${major2}`;
  const url = `${CMONEY_API}?action=getdtnodata&DtNo=${dtNo}&ParamStr=${encodeURIComponent(param)}&FilterNo=0`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, next: { revalidate: 1800 } });
  if (!res.ok) return [];
  const json = await res.json();
  return Array.isArray(json?.Data) ? json.Data : [];
}

export async function fetchCmoneyScaleRange(
  assignId: string,
  startDate: string, // YYYY-MM-DD
  endDate: string,
): Promise<CmoneyScaleDay[]> {
  const [aumRows, navRows] = await Promise.all([
    fetchSeries(DTNO_AUM, assignId, ''),
    fetchSeries(DTNO_NAV, assignId, 'M708'),
  ]);

  const aumByDate = new Map<string, number>(); // 億元
  for (const r of aumRows) aumByDate.set(String(r[0]), parseNum(r[7]));
  const navByDate = new Map<string, number>();
  for (const r of navRows) navByDate.set(String(r[0]), parseNum(r[2]));

  // Dates that have both AUM and NAV, ascending — needed to diff units day over day.
  const dates = Array.from(aumByDate.keys())
    .filter(d => navByDate.has(d) && (navByDate.get(d) ?? 0) > 0)
    .sort();

  const startYmd = startDate.replace(/-/g, '');
  const endYmd   = endDate.replace(/-/g, '');

  const out: CmoneyScaleDay[] = [];
  let prevUnits: number | null = null;
  for (const d of dates) {
    const aum = aumByDate.get(d)!;       // 億元
    const nav = navByDate.get(d)!;
    const units = (aum * 1e8) / nav;     // 受益權單位數
    if (prevUnits !== null && d >= startYmd && d <= endYmd) {
      out.push({
        date:   ymdToSlash(d),
        netSub: ((units - prevUnits) * nav) / 1e8,
        aum,
        pnav:   nav,
      });
    }
    prevUnits = units;
  }
  return out;
}
