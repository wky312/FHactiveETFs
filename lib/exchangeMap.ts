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
};

export function stockidToYfTicker(stockid: string): { ticker: string; suffix: string } {
  const upper = stockid.toUpperCase();
  for (const suffix of Object.keys(EXCHANGE_MAP)) {
    if (upper.endsWith(suffix)) {
      const base = stockid.slice(0, -suffix.length).trim();
      return { ticker: base + EXCHANGE_MAP[suffix].yf, suffix };
    }
  }
  return { ticker: stockid.trim(), suffix: '' };
}

export function getSuffixCountry(suffix: string): string {
  return EXCHANGE_MAP[suffix]?.country ?? 'Unknown';
}
