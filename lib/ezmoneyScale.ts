import https from 'https';
import http from 'http';

export interface EzmoneyDay {
  date: string;   // YYYY/MM/DD (Gregorian)
  netSub: number; // 億元 (DIFF_UNIT × P_UNIT / 1e8); negative = redemption
  aum: number;    // 億元 (NAV total / 1e8)
  pUnit: number;  // NAV per unit (TWD)
}

const HOST = 'www.ezmoney.com.tw';
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function parseNum(v: unknown): number {
  if (typeof v === 'number') return v;
  return parseFloat(String(v).replace(/,/g, '')) || 0;
}

function toRoc(gregorian: string): string {
  const [y, m, d] = gregorian.split('/');
  return `${parseInt(y) - 1911}/${m}/${d}`;
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr.replace(/\//g, '-'));
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
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

function extractCookies(headers: http.IncomingMessage['headers']): string[] {
  const sc = headers['set-cookie'];
  if (!sc) return [];
  return Array.isArray(sc) ? sc : [sc];
}

function mergeCookies(existing: string, newCookies: string[]): string {
  const map = new Map<string, string>();
  for (const part of existing.split(';').map(s => s.trim()).filter(Boolean)) {
    const [k, ...rest] = part.split('=');
    map.set(k.trim(), rest.join('=').trim());
  }
  for (const cookie of newCookies) {
    const nameVal = cookie.split(';')[0].trim();
    const [k, ...rest] = nameVal.split('=');
    map.set(k.trim(), rest.join('=').trim());
  }
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function httpsGet(path: string, cookies: string): Promise<{ setCookies: string[] }> {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: HOST, path,
      headers: { 'User-Agent': UA, ...(cookies ? { Cookie: cookies } : {}) },
    }, (res) => {
      const sc = extractCookies(res.headers);
      res.resume();
      resolve({ setCookies: sc });
    });
    req.on('error', reject);
  });
}

function httpsPost(path: string, body: Buffer, cookies: string, referer: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST, path, method: 'POST',
      headers: {
        'User-Agent':       UA,
        'Content-Type':     'application/json; charset=utf-8',
        'Content-Length':   body.length,
        'Accept':           'application/json, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer':          `https://${HOST}${referer}`,
        'Cookie':           cookies,
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

async function getSessionCookies(fundCode: string): Promise<string> {
  // Step 1: root domain → __nxquid
  const r0 = await httpsGet('/', '');
  let cookies = mergeCookies('', r0.setCookies);

  // Step 2: PCF page → ASP.NET_SessionId
  const r1 = await httpsGet(`/ETF/Transaction/PCF?fundCode=${fundCode}`, cookies);
  cookies = mergeCookies(cookies, r1.setCookies);

  return cookies;
}

// Parse TranDate from ASP.NET JSON date string or ISO string → "YYYY/MM/DD" (Taiwan, UTC+8)
function parseTranDate(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw);
  // ISO format: "2026-06-01T00:00:00"
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}/${iso[2]}/${iso[3]}`;
  // .NET ticks: "/Date(1780243200000)/"
  const ticks = s.match(/Date\((\d+)\)/);
  if (ticks) {
    const ms = parseInt(ticks[1]);
    const d  = new Date(ms + 8 * 3600 * 1000); // shift to Taiwan time
    return `${d.getUTCFullYear()}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  return null;
}

async function fetchOneDay(
  fundCode: string, announceDate: string, cookies: string
): Promise<EzmoneyDay | null> {
  try {
    const payload = Buffer.from(
      JSON.stringify({ fundCode, date: toRoc(announceDate), specificDate: true }),
      'utf8'
    );
    const raw = await httpsPost(
      '/ETF/Transaction/GetPCF', payload, cookies,
      `/ETF/Transaction/PCF?fundCode=${fundCode}`
    );
    if (!raw.trim().startsWith('{')) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = JSON.parse(raw);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pcf: any[] = json?.pcf ?? [];
    if (!pcf.length) return null;

    // Use TranDate from first entry as the actual transaction date label
    const tranDate = parseTranDate(pcf[0]?.TranDate) ?? announceDate;

    const get = (code: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = pcf.find((p: any) => p.PCFCode?.toUpperCase() === code.toUpperCase());
      return row ? parseNum(row.Amount) : 0;
    };

    const diffUnit = get('DIFF_UNIT');
    const pUnit    = get('P_UNIT');
    const nav      = get('NAV');

    if (pUnit === 0) return null;

    return {
      date:   tranDate,          // ← actual transaction date (T), not announcement date (T+1)
      netSub: (diffUnit * pUnit) / 1e8,
      aum:    nav / 1e8,
      pUnit,
    };
  } catch {
    return null;
  }
}

export async function fetchEzmoneyRange(
  fundCode: string,
  startDate: string,  // YYYY/MM/DD — transaction date range
  endDate: string,
): Promise<EzmoneyDay[]> {
  // Query announcement dates: startDate+1 to endDate+4
  // (PCF is announced T+1; extend by a few days for weekends/holidays)
  const announceStart = addDays(startDate, 1);
  const announceEnd   = addDays(endDate, 4);
  const announceDates = weekdaysBetween(announceStart, announceEnd);
  if (!announceDates.length) return [];

  const cookies = await getSessionCookies(fundCode);

  const BATCH = 5;
  const all: EzmoneyDay[] = [];
  for (let i = 0; i < announceDates.length; i += BATCH) {
    const batch = announceDates.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(d => fetchOneDay(fundCode, d, cookies)));
    for (const r of results) if (r) all.push(r);
  }

  // Filter to transaction dates within [startDate, endDate], deduplicate
  const seen = new Set<string>();
  return all
    .filter(r => {
      if (r.date < startDate || r.date > endDate) return false;
      if (seen.has(r.date)) return false;
      seen.add(r.date);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
