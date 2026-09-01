// Bloomberg / Refinitiv exchange suffix → yfinance suffix + country fallback

const EXCHANGE_MAP: Record<string, { yf: string; country: string }> = {
  ' US': { yf: '',     country: 'United States' },
  ' UW': { yf: '',     country: 'United States' },
  ' UN': { yf: '',     country: 'United States' },
  ' UA': { yf: '',     country: 'United States' },
  ' LN': { yf: '.L',  country: 'United Kingdom' },
  ' HK': { yf: '.HK', country: 'Hong Kong' },
  ' JP': { yf: '.T',  country: 'Japan' },
  ' JT': { yf: '.T',  country: 'Japan' },
  ' GY': { yf: '.DE', country: 'Germany' },
  ' GR': { yf: '.DE', country: 'Germany' },
  ' FP': { yf: '.PA', country: 'France' },
  ' AU': { yf: '.AX', country: 'Australia' },
  ' SM': { yf: '.MC', country: 'Spain' },
  ' IM': { yf: '.MI', country: 'Italy' },
  ' NA': { yf: '.AS', country: 'Netherlands' },
  ' SW': { yf: '.SW', country: 'Switzerland' },
  ' DC': { yf: '.CO', country: 'Denmark' },
  ' NO': { yf: '.OL', country: 'Norway' },
  ' SS': { yf: '.ST', country: 'Sweden' },
  ' SP': { yf: '.SI', country: 'Singapore' },
  ' KS': { yf: '.KS', country: 'South Korea' },
  ' KP': { yf: '.KS', country: 'South Korea' },
  ' TT': { yf: '.TW', country: 'Taiwan' },
  ' IN': { yf: '.NS', country: 'India' },
  ' IB': { yf: '.BO', country: 'India' },
  ' SJ': { yf: '.JO', country: 'South Africa' },
  ' BZ': { yf: '.SA', country: 'Brazil' },
  ' CN': { yf: '.TO', country: 'Canada' },
  ' CT': { yf: '.TO', country: 'Canada' },
  ' AT': { yf: '.VI', country: 'Austria' },
  ' BB': { yf: '.BR', country: 'Belgium' },
  ' GA': { yf: '.AT', country: 'Greece' },
  ' PL': { yf: '.LS', country: 'Portugal' },
  ' FH': { yf: '.HE', country: 'Finland' },
  ' NZ': { yf: '.NZ', country: 'New Zealand' },
  ' MK': { yf: '.KL', country: 'Malaysia' },
  ' PM': { yf: '.PS', country: 'Philippines' },
  ' IJ': { yf: '.JK', country: 'Indonesia' },
  ' TB': { yf: '.BK', country: 'Thailand' },
  ' SE': { yf: '.ST', country: 'Sweden' },
  ' PW': { yf: '.WA', country: 'Poland' },
  // Bloomberg ' CH' 同時涵蓋上海與深圳，yfinance 的後綴不同（.SS / .SZ）→
  // 這裡放預設值，實際後綴在 stockidToYfTicker 依代號開頭決定。
  ' CH': { yf: '.SS', country: '中國' },
};

/** 台股在復華 API 是裸 4 碼、不帶交易所後綴（00991A 全部、00409A 的台股部位都是）。
 *  外國股一律帶空格＋兩碼後綴（如 '7203 JP'），所以「沒有空格的純 4 碼」可安全判為台股。 */
export const TW_BARE_CODE = /^[1-9]\d{3}[A-Z]?$/;

export function stockidToYfTicker(stockid: string): { ticker: string; suffix: string } {
  const upper = stockid.toUpperCase();
  for (const suffix of Object.keys(EXCHANGE_MAP)) {
    if (upper.endsWith(suffix)) {
      const base = stockid.slice(0, -suffix.length).trim();
      // 滬市 6xxxxx → .SS；深市 0xxxxx / 3xxxxx → .SZ
      if (suffix === ' CH') {
        return { ticker: base + (/^[03]/.test(base) ? '.SZ' : '.SS'), suffix };
      }
      return { ticker: base + EXCHANGE_MAP[suffix].yf, suffix };
    }
  }
  return { ticker: stockid.trim(), suffix: '' };
}

export function getSuffixCountry(suffix: string): string {
  return EXCHANGE_MAP[suffix]?.country ?? 'Unknown';
}
