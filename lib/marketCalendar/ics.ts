import type { Category, MarketEvent } from './types';
import { CATEGORY_META, METRIC_LABEL_ZH } from './config';
import { addDays } from './time';

export const SITE_URL = 'https://fhactiveetf.vercel.app/?tab=calendar';

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/* RFC 5545：每行不超過 75 bytes（UTF-8），續行以一個空白開頭；不可切斷多位元組字元 */
function fold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = out.length ? 74 : 75;
    if (bytes + b > limit) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const utc = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const ymd = (d: string) => d.replace(/-/g, '');

function description(e: MarketEvent): string {
  const lines = [`類別：${CATEGORY_META[e.category].label}　重要性：${'★'.repeat(e.importance)}`];
  if (e.tentative) lines.push('※ 日期尚未官方確認');
  if (e.note) lines.push(e.note);
  for (const m of e.metrics ?? []) {
    const parts = [METRIC_LABEL_ZH[m.label] ?? m.label];
    if (m.forecast) parts.push(`預期 ${m.forecast}`);
    if (m.previous) parts.push(`前值 ${m.previous}`);
    if (m.actual) parts.push(`實際 ${m.actual}`);
    if (parts.length > 1) lines.push(parts.join('｜'));
  }
  lines.push(SITE_URL);
  return lines.join('\n');
}

export interface IcsOptions { categories?: Category[]; minImportance?: number; alarmMinutes?: number; generatedAt: string }

export function buildIcs(events: MarketEvent[], opts: IcsOptions): string {
  const stamp = utc(opts.generatedAt);
  const L: string[] = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//fhactiveetf//market-calendar//ZH-TW', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:市場重要行事曆', 'X-WR-TIMEZONE:Asia/Taipei',
    'X-WR-CALDESC:央行、美國經濟數據、財報法說、選舉與政治等影響股市的重要事件',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H',
  ];
  for (const e of events) {
    if (opts.categories?.length && !opts.categories.includes(e.category)) continue;
    if (opts.minImportance && e.importance < opts.minImportance) continue;
    const summary = `${e.importance === 3 ? '★ ' : ''}${e.title}${e.tentative ? '（預估）' : ''}`;
    L.push('BEGIN:VEVENT', `UID:${e.id}@fhactiveetf`, `DTSTAMP:${stamp}`);
    if (e.allDay) {
      L.push(`DTSTART;VALUE=DATE:${ymd(e.date)}`, `DTEND;VALUE=DATE:${ymd(addDays(e.endDate ?? e.date, 1))}`, 'TRANSP:TRANSPARENT');
    } else {
      const end = new Date(Date.parse(e.start) + 3600_000).toISOString();
      L.push(`DTSTART:${utc(e.start)}`, `DTEND:${utc(end)}`);
    }
    L.push(
      `SUMMARY:${esc(summary)}`,
      `DESCRIPTION:${esc(description(e))}`,
      `CATEGORIES:${esc(CATEGORY_META[e.category].label)}`,
      `URL:${SITE_URL}`,
      `STATUS:${e.tentative ? 'TENTATIVE' : 'CONFIRMED'}`,
    );
    if (opts.alarmMinutes && !e.allDay) {
      L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(e.title)}`, `TRIGGER:-PT${opts.alarmMinutes}M`, 'END:VALARM');
    }
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}
