/* 規則模板回覆：不靠 LLM、一定產得出來。也當作 Gemini 的骨架。
   五段：① 同理 ② 績效與市場 ③ 經理人近期操作 ④ 投資理念與長期觀點 ⑤ 結語（警語由 compliance 統一補）。 */
import type { FactPack, Periods, ChangeSet } from './facts';

export type Scenario = 'short_drop' | 'lag' | 'entry_loss' | 'manager';
export const SCENARIOS: { id: Scenario; label: string }[] = [
  { id: 'short_drop', label: '短期下跌／虧損' },
  { id: 'lag',        label: '落後大盤或同業' },
  { id: 'entry_loss', label: '買在高點套牢' },
  { id: 'manager',    label: '經理人在做什麼' },
];

export const fmtPct = (v: number | null | undefined, signed = true): string =>
  v == null ? '—' : `${signed && v > 0 ? '+' : ''}${v.toFixed(2)}%`;

const names = (xs: { name: string }[], n = 3) => xs.slice(0, n).map(x => x.name).join('、');

/** 挑一個「有數字」的代表期間：近一個月 → 本月 → 本週 → 最近一日 */
function pickPeriod(p: Periods): { key: keyof Periods; label: string } | null {
  const order: [keyof Periods, string][] = [['m1', '近一個月'], ['mtd', '本月以來'], ['wtd', '本週以來'], ['d1', '最近一日']];
  for (const [k, label] of order) if (p[k] != null) return { key: k, label };
  return null;
}

function changeSentence(c: ChangeSet | null, span: string): string | null {
  if (!c) return null;
  const parts: string[] = [];
  if (c.increased.length) parts.push(`加碼 ${names(c.increased)}`);
  if (c.added.length) parts.push(`新增 ${names(c.added)}`);
  if (c.decreased.length) parts.push(`調降 ${names(c.decreased)}`);
  if (c.exited.length) parts.push(`出清 ${names(c.exited)}`);
  if (!parts.length) return `${span}（${c.fromDate.replace(/\//g, '-')} 至 ${c.toDate.replace(/\//g, '-')}）整體持股結構大致維持，未做大幅調整`;
  return `${span}（${c.fromDate.replace(/\//g, '-')} 至 ${c.toDate.replace(/\//g, '-')}）${parts.join('；')}`;
}

export function templateReply(f: FactPack, scenarios: Scenario[]): string {
  const has = (s: Scenario) => scenarios.includes(s);
  const main = f.benches[0];
  const per = pickPeriod(f.fund);
  const out: string[] = [];

  // ① 同理
  out.push(
    `您好，非常感謝您長期支持${f.name}，也謝謝您願意把心中的疑慮告訴我們。` +
    (has('entry_loss')
      ? '看到自己的投資出現帳面虧損，心裡一定很不好受，這份焦慮我們完全能理解。'
      : '近期淨值的波動讓您感到擔心，這是非常自然的感受，我們很重視您的意見。') +
    '以下整理目前的績效、市場狀況與經理團隊的操作，向您說明。'
  );

  // ② 績效與市場
  const perf: string[] = [];
  if (per) {
    const fv = f.fund[per.key];
    const bv = main?.periods[per.key];
    perf.push(`截至 ${f.asOf ?? '最新交易日'}，本基金${per.label}報酬為 ${fmtPct(fv)}` +
      (main && bv != null ? `，同期${main.name}為 ${fmtPct(bv)}` : '') +
      (f.peerAvg[per.key] != null ? `，${f.peerGroupLabel}同業平均為 ${fmtPct(f.peerAvg[per.key])}` : '') + '。');
  }
  if (f.fund.ytd != null) perf.push(`今年以來本基金報酬為 ${fmtPct(f.fund.ytd)}。`);
  else if (f.sinceListing != null) perf.push(`自 ${f.listingDate} 掛牌以來（以掛牌首日收盤為基準），報酬為 ${fmtPct(f.sinceListing)}。`);
  const fd = f.drawdown.fund, bd = f.drawdown.bench;
  if ((has('short_drop') || has('entry_loss')) && fd && bd && fd.ddPct < -1) {
    const deeper = fd.ddPct - bd.ddPct < -3;           // 基金跌幅明顯大於大盤（差 3 個百分點以上）
    if (bd.ddPct < -3 && !deeper) {
      perf.push(`近期市場整體回檔，本基金距近期高點 ${fmtPct(fd.ddPct)}，同期${bd.name}距高點 ${fmtPct(bd.ddPct)}，兩者幅度相近，波動主要來自整體市場修正。`);
    } else if (bd.ddPct < -3) {
      perf.push(`近期市場明顯修正，${bd.name}距近期高點 ${fmtPct(bd.ddPct)}；本基金距近期高點 ${fmtPct(fd.ddPct)}，跌幅較大盤更深。這與本基金持股集中於成長性較高、波動也較大的產業有關，在市場轉弱時修正幅度會被放大。`);
    } else {
      perf.push(`本基金距近期高點 ${fmtPct(fd.ddPct)}，同期${bd.name}距高點 ${fmtPct(bd.ddPct)}，本基金的回檔幅度較大盤明顯，這主要與持股集中於特定產業有關。`);
    }
  }
  if (has('lag') && per && main) {
    const fv = f.fund[per.key], bv = main.periods[per.key];
    if (fv != null && bv != null && fv < bv) {
      perf.push(bv < 0
        ? `我們坦白說明，這段期間本基金的跌幅確實大於${main.name}。在市場修正階段，大型權值股相對抗跌，而本基金布局較多高成長、高波動的個股，跌幅因此較深；同樣的配置在多頭行情中則有機會帶來超額表現。`
        : `我們坦白說明，這段期間本基金確實落後${main.name}。主動式 ETF 的持股與指數不同，在大型權值股集中上漲的階段，表現容易與大盤拉開差距；反之在選股能發揮的行情中，也有機會領先。`);
    }
    // 名次只在前半段時主動提；後段名次留在事實摘要卡給客服參考，不寫進回覆
    const rk = f.ranks.find(r => r.period === per.key) ?? f.ranks[0];
    if (rk && rk.rank <= Math.ceil(rk.total / 2)) perf.push(`以${rk.label}來看，本基金在 ${rk.total} 檔同類主動式 ETF 中排名第 ${rk.rank}。`);
  }
  if (f.kind === 'overseas' && f.benches.some(b => b.ticker === 'XLF')) {
    perf.push('另外提醒，本基金聚焦全球金融產業，與以科技股為主的同類海外主動式 ETF 屬性不同，比較時以金融類股表現作為參考會更貼近。');
  }
  if (f.contributors) {
    const c = f.contributors;
    if (c.bottom.length) perf.push(`${c.period}影響淨值較大的持股包括 ${names(c.bottom)}（依權重估算為負貢獻）` +
      (c.top.length ? `，而 ${names(c.top)} 則帶來正面貢獻` : '') + '。');
  }
  for (const n of f.notes) if (n.startsWith('本基金掛牌僅')) perf.push(n);
  if (has('entry_loss') && f.entry) {
    const e = f.entry;
    perf.push(`以您提到的 ${e.date} 進場估算（以 ${e.entryPriceDate} 收盤為基準），至今報酬約 ${fmtPct(e.fundReturn)}` +
      (e.benchReturn != null ? `，同期${e.benchName}為 ${fmtPct(e.benchReturn)}` : '') +
      `；期間淨值最高曾較進場價 ${fmtPct(e.highSinceEntry)}，目前距該高點 ${fmtPct(e.fromHighPct)}。實際損益仍以您的成交價格與交易成本為準。`);
  }
  if (perf.length) out.push(perf.join(''));

  // ③ 經理人近期操作
  const ops: string[] = [];
  const s = changeSentence(f.holdings.short, '近一週');
  const l = changeSentence(f.holdings.long, '近一個月');
  if (s) ops.push(s + '。');
  if (l && (has('manager') || !s)) ops.push(l + '。');
  if (f.holdings.top10.length) {
    ops.push(`目前（${f.holdings.latestDate}）前三大持股為 ${f.holdings.top10.slice(0, 3).map(t => `${t.name}（${t.weight.toFixed(2)}%）`).join('、')}。`);
  }
  if (ops.length) {
    out.push(`在操作上，經理團隊持續依據產業前景與企業基本面調整配置：${ops.join('')}` +
      '這些調整反映經理團隊在市場變化中，汰弱留強、把資金配置到相對更具基本面支撐的標的。');
  }

  // ④ 理念與長期觀點
  out.push(
    `本基金為${f.style}，經理團隊的目標是透過研究選股，在中長期掌握企業成長帶來的價值，而非追逐短期漲跌。` +
    '市場短期波動難以避免，我們會持續審慎管理風險，並定期檢視持股，也建議您依自身的資金規劃與風險承受度，評估適合的投資方式，例如分批或定期定額，以降低單一時點進場的影響。'
  );

  // ⑤ 結語
  out.push('再次感謝您的信任與寶貴意見。若您希望進一步了解基金的持股與操作，歡迎隨時與我們聯繫，我們很樂意為您說明。');

  return out.join('\n\n');
}
