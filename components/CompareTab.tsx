'use client';
import { Holding } from '@/lib/types';
import PlotlyWrapper from './PlotlyWrapper';

const GREY   = '#4D4D4F';
const GREY_D = '#2D2D2F';

const STATUS_ORDER = { new: 0, increased: 1, decreased: 2, unchanged: 3, removed: 4 } as const;
type Status = keyof typeof STATUS_ORDER;

const STATUS_COLOR: Record<Status, string> = {
  new:       '#D4EDDA',
  removed:   '#F8D7DA',
  increased: '#FFF3CD',
  decreased: '#CCE5FF',
  unchanged: '#FFFFFF',
};

interface Row {
  stockid: string; stockname: string; country: string;
  curr_q: number | null; prev_q: number | null; diff_q: number | null;
  curr_p: number | null; prev_p: number | null; diff_p: number | null;
  status: Status;
}

function buildRows(curr: Holding[], prev: Holding[]): Row[] {
  const cm = new Map(curr.map(h => [h.stockid || h.stockname, h]));
  const pm = new Map(prev.map(h => [h.stockid || h.stockname, h]));
  const keys = new Set([...cm.keys(), ...pm.keys()]);

  const rows: Row[] = [];
  for (const key of keys) {
    const c = cm.get(key), p = pm.get(key);
    let status: Status = 'unchanged';
    if (c && !p)             status = 'new';
    else if (!c)             status = 'removed';
    else if (c.qshare > p!.qshare) status = 'increased';
    else if (c.qshare < p!.qshare) status = 'decreased';
    rows.push({
      stockid:   (c ?? p)!.stockid,
      stockname: (c ?? p)!.stockname,
      country:   (c ?? p)!.country,
      curr_q: c?.qshare           ?? null,
      prev_q: p?.qshare           ?? null,
      diff_q: c && p ? c.qshare - p.qshare : null,
      curr_p: c?.prate_addaccint  ?? null,
      prev_p: p?.prate_addaccint  ?? null,
      diff_p: c && p ? c.prate_addaccint - p.prate_addaccint : null,
      status,
    });
  }
  return rows.sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.curr_p ?? 0) - (a.curr_p ?? 0)
  );
}

const f  = (n: number | null)                => n === null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const fd = (n: number | null)                => n === null ? '' : (n >= 0 ? '+' : '') + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const fp = (n: number | null)                => n === null ? '—' : `${n.toFixed(3)}%`;
const fdp = (n: number | null)               => n === null ? '' : `${n >= 0 ? '+' : ''}${n.toFixed(3)}%`;

interface Props {
  baseDate: string; cmpDate: string;
  baseHoldings: Holding[]; cmpHoldings: Holding[];
}

const LEGEND = [
  { color: '#D4EDDA', border: '#C3E6CB', label: '新增持股' },
  { color: '#F8D7DA', border: '#F5C6CB', label: '移除持股' },
  { color: '#FFF3CD', border: '#FFE082', label: '持股增加' },
  { color: '#CCE5FF', border: '#B8DAFF', label: '持股減少' },
  { color: '#FFFFFF', border: '#CCC',    label: '無變化' },
];

export default function CompareTab({ baseDate, cmpDate, baseHoldings, cmpHoldings }: Props) {
  const rows   = buildRows(baseHoldings, cmpHoldings);
  const colors = rows.map(r => STATUS_COLOR[r.status]);
  const bs     = baseDate.slice(5), cs = cmpDate.slice(5);

  const traces = [{
    type: 'table',
    columnwidth: [80, 175, 105, 118, 118, 85, 80, 80, 88],
    header: {
      values: [
        '<b>代碼</b>', '<b>名稱</b>', '<b>國家</b>',
        `<b>持股(${baseDate})</b>`, `<b>持股(${cmpDate})</b>`, '<b>持股變化</b>',
        `<b>佔比%(${bs})</b>`, `<b>佔比%(${cs})</b>`, '<b>佔比變化</b>',
      ],
      fill: { color: GREY }, font: { color: 'white', size: 12 },
      align: 'center', height: 38, line: { color: GREY_D },
    },
    cells: {
      values: [
        rows.map(r => r.stockid),   rows.map(r => r.stockname), rows.map(r => r.country),
        rows.map(r => f(r.curr_q)), rows.map(r => f(r.prev_q)), rows.map(r => fd(r.diff_q)),
        rows.map(r => fp(r.curr_p)), rows.map(r => fp(r.prev_p)), rows.map(r => fdp(r.diff_p)),
      ],
      fill: { color: Array(9).fill(colors) },
      font: { size: 12 },
      align: ['center', 'left', 'center', 'right', 'right', 'right', 'right', 'right', 'right'],
      height: 30, line: { color: '#E0E0E0' },
    },
  }];

  return (
    <>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, marginBottom: 12, color: '#555' }}>
        {LEGEND.map(({ color, border, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 13, height: 13, borderRadius: 3, background: color, border: `1px solid ${border}`, flexShrink: 0 }} />
            {label}
          </div>
        ))}
      </div>
      <PlotlyWrapper
        traces={traces}
        layout={{ margin: { l: 5, r: 5, t: 5, b: 5 }, height: Math.max(420, rows.length * 32 + 65) }}
      />
    </>
  );
}
