import type { MarketEvent } from '../types';
import { zonedToIso } from '../time';
import { fetchText } from './http';

const URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
const MONTH: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/* Fed 官網行事曆（當年起往回約 5 年 + 明年）。日期欄如 "28-29*"（* = 附經濟預測 SEP／點陣圖），
   跨月會議月份寫成 "Apr/May"、日期 "30-1"。決議聲明固定美東 14:00 公布。 */
export async function fetchFomc(): Promise<MarketEvent[]> {
  const html = await fetchText(URL);
  const chunks = html.split(/(\d{4}) FOMC Meetings/);
  const out: MarketEvent[] = [];
  for (let i = 1; i < chunks.length; i += 2) {
    const year = Number(chunks[i]);
    const body = chunks[i + 1];
    const re = /fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)</g;
    for (const m of body.matchAll(re)) {
      const months = m[1].split('/').map(s => MONTH[s.trim().slice(0, 3).toLowerCase()]);
      const dm = m[2].trim().match(/^(\d{1,2})(?:-(\d{1,2}))?(\*)?$/);
      if (!dm || months.some(x => !x)) continue;       // 跳過 notation vote / unscheduled 等非例會
      const first = Number(dm[1]);
      const last = Number(dm[2] ?? dm[1]);
      const month = months.length > 1 && last < first ? months[1] : months[months.length - 1];
      const ymd = `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
      const sep = !!dm[3];
      const start = zonedToIso(ymd, '14:00', 'America/New_York');
      out.push({
        id: `fomc-${ymd}`, type: 'fomc', category: 'central_bank',
        title: sep ? 'FOMC 利率決議（含點陣圖）' : 'FOMC 利率決議',
        start, date: ymd, allDay: false, importance: 3, source: 'fed',
        historyKey: 'fomc', reactionAt: start,
        note: sep ? '本次會議公布經濟預測摘要（SEP）與利率點陣圖，並召開記者會。' : '會後召開記者會。',
      });
    }
  }
  if (!out.length) throw new Error('Fed 頁面解析不到任何會議（版型可能改了）');
  return out;
}
