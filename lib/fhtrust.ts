import { Holding, HoldingsResponse } from './types';
import { stockidToYfTicker, getSuffixCountry, TW_BARE_CODE } from './exchangeMap';
import { getCountry } from './country';

const API_URL = 'https://www.fhtrust.com.tw/api/assets';

function parseNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (!value) return 0;
  return parseFloat(String(value).replace(/,/g, '').replace(/%/g, '')) || 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveCountry(item: any): string {
  const ftype: string = item.ftype || '';
  if (ftype === '期貨') return '期貨';
  if (ftype === '其他資產' || ftype === '現金') return '現金/其他';

  const stockid: string = item.stockid || '';
  const { ticker, suffix } = stockidToYfTicker(stockid);
  const cached = getCountry(ticker);
  if (cached) return cached;
  if (suffix) return getSuffixCountry(suffix);
  /* 沒有後綴又不在 cache 裡 → 復華對台股就是給裸 4 碼。這條以前只有 ETF23 靠下面那段
     整批補台灣，所以 00409A 的台股部位（11 檔、約 16.5%）全部掉進 Unknown。 */
  if (TW_BARE_CODE.test(stockid.trim().toUpperCase())) return '台灣';
  return 'Unknown';
}

export async function fetchHoldings(
  date: string,
  fundId = 'ETF24',
  opts?: { force?: boolean },
): Promise<HoldingsResponse> {
  const url = `${API_URL}?fundID=${fundId}&qDate=${encodeURIComponent(date)}`;
  const res = await fetch(url, {
    ...(opts?.force ? { cache: 'no-store' as const } : { next: { revalidate: 3600 } }),
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`fhtrust API ${res.status}`);

  const data = await res.json();
  const fund = data?.result?.[0];
  if (!fund) throw new Error('資料不存在，請確認是否為交易日');

  const detail: unknown[] = fund.detail ?? [];

  /* 尚未公布的日期上游不會回錯誤，而是回一個 dDate=null、detail=[] 的空殼。照單全收的話
     當日摘要會拿「空的今天」去 diff「完整的昨天」，把每一檔都畫成清倉——所以視同無資料。
     （新成立、尚未掛牌的基金如 00409A/ETF26 也是這個形狀。） */
  if (!fund.dDate || detail.length === 0) {
    throw new Error(`${date} 持股尚未公布（復華通常於收盤後陸續更新），請稍後再試或改選前一交易日`);
  }

  const holdings: Holding[] = (detail as Record<string, unknown>[]).map((item) => ({
    stockid: String(item.stockid ?? ''),
    stockname: String(item.stockname ?? ''),
    qshare: parseNumber(item.qshare),
    mvalue: parseNumber(item.mvalue),
    prate_addaccint: parseNumber(item.prate_addaccint),
    country: resolveCountry(item),
    ftype: String(item.ftype ?? ''),
  }));

  // 00991A 為純台股 ETF，無法辨識 suffix 時一律帶入台灣
  if (fundId === 'ETF23') {
    holdings.forEach(h => { if (h.country === 'Unknown' || h.country === '') h.country = '台灣'; });
  }

  return { date: fund.dDate ?? date, holdings };
}
