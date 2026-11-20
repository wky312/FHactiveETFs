/* 法遵檢查：禁語掃描＋數字核對＋固定警語。純函式（無 I/O），scripts/test_complaint_compliance.mjs 會直接測。 */

export const DISCLAIMER =
  '【警語】本基金經金融監督管理委員會核准或同意生效，惟不表示絕無風險。基金經理公司以往之經理績效不保證基金之最低投資收益；' +
  '基金經理公司除盡善良管理人之注意義務外，不負責本基金之盈虧，亦不保證最低之收益，投資人申購前應詳閱基金公開說明書。' +
  '本回覆所列數據僅供參考，不構成任何投資建議。';

/** [禁語, 說明]。命中只警示、不自動改寫，讓客服人工判斷語境（例如「不保證」是合法用語）。 */
export const BANNED: [RegExp, string][] = [
  [/(?<!不)保證(?!基金之最低|最低之收益)/, '「保證」屬承諾性用語'],
  [/穩賺|穩定獲利|穩健獲利/, '暗示穩定獲利'],
  [/保本|不會虧/, '暗示保本'],
  [/一定會|必然|必定|肯定會/, '對未來走勢做肯定性描述'],
  [/低點已到|已經見底|觸底反彈|即將反彈|會漲回/, '預測市場走勢'],
  [/無風險|零風險|沒有風險/, '否認投資風險'],
  [/翻倍|倍數獲利|賺回來/, '誇大報酬'],
  [/建議(您)?(加碼|買進|買入|攤平|加倉)/, '具體買賣建議'],
];

export function scanBanned(text: string): string[] {
  const body = text.replace(DISCLAIMER, '');
  const hits: string[] = [];
  for (const [re, why] of BANNED) {
    const m = body.match(re);
    if (m) hits.push(`禁語「${m[0]}」：${why}`);
  }
  return hits;
}

/** 收集事實包裡所有數值（遞迴）。 */
export function collectNumbers(obj: unknown, out: number[] = []): number[] {
  if (typeof obj === 'number' && Number.isFinite(obj)) out.push(obj);
  else if (Array.isArray(obj)) obj.forEach(v => collectNumbers(v, out));
  else if (obj && typeof obj === 'object') Object.values(obj).forEach(v => collectNumbers(v, out));
  return out;
}

/** 「差值」只允許來自績效類欄位（本基金／基準／同業平均／進場／回檔），
    否則事實包上百個數字兩兩相減，幾乎任何數字都對得上，核對就失去意義。 */
function diffPool(facts: unknown): number[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f = facts as any;
  if (!f || typeof f !== 'object') return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts = [f.fund, f.peerAvg, f.sinceListing, f.entry, f.drawdown, ...(Array.isArray(f.benches) ? f.benches.map((b: any) => b?.periods) : [])];
  return collectNumbers(parts);
}

/** 抽出回覆中所有「x%」「x 個百分點」，事實包裡找不到（容忍 ±0.05，或為績效欄位兩兩之差）就列為疑似自編。 */
export function checkNumbers(text: string, facts: unknown, tol = 0.05): string[] {
  const known = collectNumbers(facts).map(Math.abs);
  const pool = diffPool(facts);
  const body = text.replace(DISCLAIMER, '');
  const re = /([+\-−]?\d+(?:\.\d+)?)\s*(%|％|個百分點)/g;
  const bad = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const v = Math.abs(parseFloat(m[1].replace('−', '-')));
    if (known.some(k => Math.abs(k - v) <= tol)) continue;
    if (pool.some(a => pool.some(b => Math.abs(Math.abs(a - b) - v) <= tol))) continue;
    bad.add(m[0]);
  }
  return [...bad].map(s => `數字「${s}」在事實資料中找不到，疑似自行推估，請人工確認`);
}

export function withDisclaimer(text: string): string {
  const t = text.trim();
  return t.includes('不保證基金之最低投資收益') ? t : `${t}\n\n${DISCLAIMER}`;
}

export function complianceCheck(reply: string, facts: unknown): { reply: string; warnings: string[] } {
  const final = withDisclaimer(reply);
  return { reply: final, warnings: [...scanBanned(final), ...checkNumbers(final, facts)] };
}
