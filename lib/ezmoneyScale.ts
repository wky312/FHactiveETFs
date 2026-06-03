import https from 'https';

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

function extractCookies(headers: https.IncomingMessage['headers']): string[] {
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

async function fetchOneDay(
  fundCode: string, gregorianDate: string, cookies: string
): Promise<EzmoneyDay | null> {
  try {
    const payload = Buffer.from(
      JSON.stringify({ fundCode, date: toRoc(gregorianDate), specificDate: true }),
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
      date:   gregorianDate,
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
  startDate: string,
  endDate: string,
): Promise<EzmoneyDay[]> {
  const dates = weekdaysBetween(startDate, endDate);
  if (!dates.length) return [];

  const cookies = await getSessionCookies(fundCode);

  const BATCH = 5;
  const all: EzmoneyDay[] = [];
  for (let i = 0; i < dates.length; i += BATCH) {
    const batch = dates.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(d => fetchOneDay(fundCode, d, cookies)));
    for (const r of results) if (r) all.push(r);
  }

  return all.sort((a, b) => a.date.localeCompare(b.date));
}
