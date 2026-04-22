import { Holding, HoldingsResponse } from './types';
import { stockidToYfTicker, getSuffixCountry } from './exchangeMap';
import { getCountry } from './country';

const API_URL = 'https://www.fhtrust.com.tw/api/assets';
const FUND_ID = 'ETF24';

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
  return getCountry(ticker) ?? getSuffixCountry(suffix);
}

export async function fetchHoldings(date: string): Promise<HoldingsResponse> {
  const url = `${API_URL}?fundID=${FUND_ID}&qDate=${encodeURIComponent(date)}`;
  const res = await fetch(url, {
    next: { revalidate: 3600 },
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`fhtrust API ${res.status}`);

  const data = await res.json();
  const fund = data?.result?.[0];
  if (!fund) throw new Error('資料不存在，請確認是否為交易日');

  const detail: unknown[] = fund.detail ?? [];

  const holdings: Holding[] = (detail as Record<string, unknown>[]).map((item) => ({
    stockid: String(item.stockid ?? ''),
    stockname: String(item.stockname ?? ''),
    qshare: parseNumber(item.qshare),
    mvalue: parseNumber(item.mvalue),
    prate_addaccint: parseNumber(item.prate_addaccint),
    country: resolveCountry(item),
    ftype: String(item.ftype ?? ''),
  }));

  return { date: fund.dDate ?? date, holdings };
}
