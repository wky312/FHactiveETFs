// 凱基投信 (KGI SITE) ETF 申購買回清單 (PCF) scraper — for 00407A 主動凱基台灣.
//
//   POST https://www.kgifund.com.tw/Fund/RedemptionVC
//        form  fundID=J024&queryDate=YYYY-MM-DD  → 一段 HTML 片段（非 JSON）
//
// ⚠️ `queryDate` 是**公告日**：7/28 公告的清單裝的是 7/27 的資料。資料日只出現在
// 「(YYYY/MM/DD)每受益權單位淨資產價值(元)」的括號前綴，所以查公告日候選、再用該前綴
// 把每一筆歸位到真正的資料日。00407A → fundID "J024"。

export interface KgiDay {
  date: string;   // YYYY/MM/DD (資料日)
  netSub: number; // 億元 (與前日已發行單位差異數 × 每受益權單位淨資產價值 / 1e8)
  aum: number;    // 億元 (基金淨資產價值 / 1e8)
  pnav: number;   // 每受益權單位淨資產價值
}

const URL = 'https://www.kgifund.com.tw/Fund/RedemptionVC';
const UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function parseNum(v: string | null | undefined): number {
  if (!v) return 0;
  const neg = /\(.*\)/.test(v) || v.includes('−') || /-\s*[\d]/.test(v);
  const n = parseFloat(v.replace(/[,\s]/g, '').replace(/[^0-9.]/g, '')) || 0;
  return neg ? -Math.abs(n) : n;
}

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

// 凱基把所有中文都輸出成數值 HTML entity（&#x8207; …），不解碼就永遠比對不到標籤。
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g,           (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

// 把 HTML 片段拆成「純文字格子」序列：標籤在前、值緊接在後。
function cellsOf(html: string): string[] {
  const text = decodeEntities(
    html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '|')
  );
  return text.split('|').map(s => s.trim()).filter(Boolean);
}

function valueAfter(cells: string[], pred: (c: string) => boolean): string | null {
  const i = cells.findIndex(pred);
  return i >= 0 && i + 1 < cells.length ? cells[i + 1] : null;
}

async function fetchOneAnnounce(fundId: string, announceDash: string): Promise<KgiDay | null> {
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: {
        'User-Agent':       UA,
        'Content-Type':     'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer':          `https://www.kgifund.com.tw/Fund/RedemptionList?fundNo=${encodeURIComponent(fundId)}`,
      },
      body: new URLSearchParams({ fundID: fundId, queryDate: announceDash }).toString(),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const cells = cellsOf(await res.text());

    const navLabel = cells.find(c => /^\(\d{4}\/\d{2}\/\d{2}\)/.test(c) && c.includes('每受益權單位淨資產價值'));
    if (!navLabel) return null;
    const navDate = navLabel.slice(1, 11); // YYYY/MM/DD

    const pnav = parseNum(valueAfter(cells, c => c === navLabel));
    const nav  = parseNum(valueAfter(cells, c => c.startsWith('基金淨資產價值')));
    const diff = parseNum(valueAfter(cells, c => c.startsWith('與前日已發行單位差異數')));
    if (nav === 0 || pnav === 0) return null;

    return { date: navDate, netSub: (diff * pnav) / 1e8, aum: nav / 1e8, pnav };
  } catch {
    return null;
  }
}

export async function fetchKgiRange(
  fundId: string,
  startDate: string, // YYYY-MM-DD (transaction date range)
  endDate: string,
): Promise<KgiDay[]> {
  const announces = weekdaysBetween(addDays(startDate, 1), addDays(endDate, 5));
  if (!announces.length) return [];

  const startSlash = startDate.replace(/-/g, '/');
  const endSlash   = endDate.replace(/-/g, '/');
  const BATCH = 5;
  const byDate = new Map<string, KgiDay>();
  for (let i = 0; i < announces.length; i += BATCH) {
    const batch = announces.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(d => fetchOneAnnounce(fundId, d)));
    for (const r of results) {
      if (r && r.date >= startSlash && r.date <= endSlash) byDate.set(r.date, r);
    }
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}
