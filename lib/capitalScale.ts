import https from 'https';
import http from 'http';

export interface CapitalDay {
  date: string;   // YYYY-MM-DD (transaction date = date2)
  netSub: number; // 億元 (disUnit × pUnit / 1e8)
  aum: number;    // 億元 (nav / 1e8)
  pUnit: number;  // NAV per unit
}

// Fund IDs for active ETFs
export const CAPITAL_FUNDS: Record<string, string> = {
  '00982A': '399',
  '00992A': '500',
};

const HOST = 'www.capitalfund.com.tw';
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function parseNum(v: unknown): number {
  if (typeof v === 'number') return v;
  return parseFloat(String(v).replace(/,/g, '')) || 0;
}

function addCalendarDays(dateStr: string, n: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

// Next business day after dateStr (skips weekends; holidays handled by API returning null)
function nextBusinessDay(dateStr: string): string {
  const d = new Date(dateStr);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
  return d.toISOString().split('T')[0];
}

function weekdaysBetween(start: string, end: string): string[] {
  const result: string[] = [];
  let cur = start;
  while (cur <= end) {
    const dow = new Date(cur).getDay();
    if (dow !== 0 && dow !== 6) result.push(cur);
    cur = addCalendarDays(cur, 1);
  }
  return result;
}

function extractCookies(headers: http.IncomingMessage['headers']): string[] {
  const sc = headers['set-cookie'];
  if (!sc) return [];
  return Array.isArray(sc) ? sc : [sc];
}

function mergeCookies(existing: string, newCookies: string[]): string {
  const map = new Map<string, string>();
  for (const part of existing.split(';').map(s => s.trim()).filter(Boolean)) {
    const idx = part.indexOf('=');
    if (idx > 0) map.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  }
  for (const cookie of newCookies) {
    const nameVal = cookie.split(';')[0].trim();
    const idx = nameVal.indexOf('=');
    if (idx > 0) map.set(nameVal.slice(0, idx).trim(), nameVal.slice(idx + 1).trim());
  }
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function httpsGet(path: string, cookies: string): Promise<{ setCookies: string[] }> {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: HOST, path,
      headers: { 'User-Agent': UA, ...(cookies ? { Cookie: cookies } : {}) },
    }, (res) => {
      const sc = extractCookies(res.headers);
      res.resume();
      resolve({ setCookies: sc });
    }).on('error', reject);
  });
}

function httpsPost(path: string, body: Buffer, cookies: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST, path, method: 'POST',
      headers: {
        'User-Agent':     UA,
        'Content-Type':   'application/json',
        'Content-Length': body.length,
        'Accept':         'application/json, */*',
        'Referer':        `https://${HOST}/etf/transaction/buyback`,
        'Cookie':         cookies,
      },
    }, (res) => {
      let out = '';
      res.on('data', (c: Buffer) => out += c.toString());
      res.on('end', () => resolve(out));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getSessionCookies(): Promise<string> {
  const r = await httpsGet('/', '');
  return mergeCookies('', r.setCookies);
}

async function fetchOneDay(
  fundId: string, transactionDate: string, cookies: string
): Promise<CapitalDay | null> {
  try {
    // Announcement date = next business day after transaction date
    const announceDate = nextBusinessDay(transactionDate);
    const payload = Buffer.from(
      JSON.stringify({ fundId, date: announceDate }),
      'utf8'
    );
    const raw = await httpsPost('/CFWeb/api/etf/buyback', payload, cookies);
    if (!raw.trim().startsWith('{')) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = JSON.parse(raw);
    const pcf = json?.data?.pcf;
    if (!pcf?.date2) return null;
    // Verify the returned transaction date matches what we requested
    if (pcf.date2 !== transactionDate) return null;

    const disUnit = parseNum(pcf.disUnit);
    const pUnit   = parseNum(pcf.pUnit);
    const nav     = parseNum(pcf.nav);

    if (pUnit === 0) return null;

    return {
      date:   pcf.date2,
      netSub: (disUnit * pUnit) / 1e8,
      aum:    nav / 1e8,
      pUnit,
    };
  } catch {
    return null;
  }
}

export async function fetchCapitalRange(
  fundId: string,
  startDate: string,  // YYYY-MM-DD
  endDate: string,
): Promise<CapitalDay[]> {
  const dates = weekdaysBetween(startDate, endDate);
  if (!dates.length) return [];

  const cookies = await getSessionCookies();

  const BATCH = 5;
  const all: CapitalDay[] = [];
  for (let i = 0; i < dates.length; i += BATCH) {
    const batch = dates.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(d => fetchOneDay(fundId, d, cookies)));
    for (const r of results) if (r) all.push(r);
  }

  return all.sort((a, b) => a.date.localeCompare(b.date));
}
