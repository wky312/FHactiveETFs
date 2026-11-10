'use client';
import { useState, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { Holding } from '@/lib/types';
import { onlyStockRows } from '@/lib/holdingRows';
import { buildHoldingsSector } from '@/lib/holdingsSector';

const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const UP     = '#C00000';
const DOWN   = '#1A6B45';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

const famt = (n: number | null) => {
  if (n === null) return '—';
  const wan = n / 10000;
  if (Math.abs(wan) < 0.05) return '0';
  const s = Math.abs(wan).toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  return wan > 0 ? `+${s}` : `−${s}`;
};

const STATUS_ORDER = { new: 0, increased: 1, decreased: 2, unchanged: 3, removed: 4 } as const;
type Status = keyof typeof STATUS_ORDER;

const ROW_BG: Record<Status, string> = {
  new:       '#FFF5F5',
  increased: '#FFFAFA',
  decreased: '#F5FBF5',
  removed:   '#EEF8EE',
  unchanged: '#ffffff',
};

const BADGE: Record<Status, React.CSSProperties> = {
  new:       { background: '#FFE8E8', color: UP,   border: '1px solid #FFCDD2' },
  increased: { background: '#FFF0F0', color: UP,   border: '1px solid #FFE0E0' },
  decreased: { background: '#E8F5EC', color: DOWN, border: '1px solid #C8E6C9' },
  removed:   { background: '#D8EEDC', color: DOWN, border: '1px solid #A5D6A7' },
  unchanged: { background: '#F2F2F2', color: '#999', border: '1px solid #DDD' },
};

const BADGE_LABEL: Record<Status, string> = {
  new: '新倉', increased: '加碼', decreased: '減碼', removed: '清倉', unchanged: '—',
};

function diffColor(n: number | null) {
  if (n === null || n === 0) return SUB;
  return n > 0 ? UP : DOWN;
}

const f   = (n: number | null) => n === null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const fd  = (n: number | null) => {
  if (n === null) return '';
  const s = Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : '0';
};
const fp  = (n: number | null) => n === null ? '—' : `${n.toFixed(3)}%`;
const fdp = (n: number | null) => {
  if (n === null) return '';
  const s = Math.abs(n).toFixed(3);
  return n > 0 ? `+${s}%` : n < 0 ? `−${s}%` : '0%';
};

type SortKey = 'stockid' | 'stockname' | 'country' | 'prev_q' | 'curr_q' | 'diff_q' | 'diff_amount' | 'prev_p' | 'curr_p' | 'diff_p';

interface Row {
  stockid: string; stockname: string; country: string;
  curr_q: number | null; prev_q: number | null; diff_q: number | null;
  curr_p: number | null; prev_p: number | null; diff_p: number | null;
  diff_amount: number | null;
  status: Status;
}

function buildRows(curr: Holding[], prev: Holding[]): Row[] {
  // 現金餘額／應付買回款／應付申購預收款等非個股列不列入加減碼計算
  const cm = new Map(onlyStockRows(curr).map(h => [h.stockid || h.stockname, h]));
  const pm = new Map(onlyStockRows(prev).map(h => [h.stockid || h.stockname, h]));
  const keys = new Set([...cm.keys(), ...pm.keys()]);
  const rows: Row[] = [];
  for (const key of keys) {
    const c = cm.get(key), p = pm.get(key);
    const cq = c?.qshare ?? 0;
    const pq = p?.qshare ?? 0;
    let status: Status = 'unchanged';
    if      (!c || cq === 0)   status = 'removed';
    else if (!p || pq === 0)   status = 'new';
    else if (cq > pq)          status = 'increased';
    else if (cq < pq)          status = 'decreased';

    const cPrice = c && cq > 0 ? c.mvalue / cq : null;
    const pPrice = p && pq > 0 ? p.mvalue / pq : null;
    let diff_amount: number | null = null;
    if (c && cq > 0 && p && pq > 0 && cPrice !== null) diff_amount = cPrice * (cq - pq);
    else if (c && cq > 0 && cPrice !== null)            diff_amount = c.mvalue;
    else if (p && pq > 0 && pPrice !== null)            diff_amount = -p.mvalue;

    rows.push({
      stockid:   (c ?? p)!.stockid,
      stockname: (c ?? p)!.stockname,
      country:   (c ?? p)!.country,
      curr_q: cq > 0 ? cq : null,
      prev_q: pq > 0 ? pq : null,
      diff_q: cq > 0 && pq > 0 ? cq - pq : null,
      curr_p: c?.prate_addaccint  ?? null,
      prev_p: p?.prate_addaccint  ?? null,
      diff_p: c && p ? c.prate_addaccint - p.prate_addaccint : null,
      diff_amount,
      status,
    });
  }
  return rows.sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.curr_p ?? 0) - (a.curr_p ?? 0)
  );
}

function exportExcel(rows: Row[], baseDate: string, cmpDate: string, ticker: string, bs: string, cs: string) {
  const headers = ['代碼', '名稱', '國家', `持股(${cs})`, `持股(${bs})`, '持股變化', '異動金額(萬)', `佔比%(${cs})`, `佔比%(${bs})`, '佔比變化', '操作'];
  const data = rows.map(r => [
    r.stockid,
    r.stockname,
    r.country,
    r.prev_q ?? '',
    r.curr_q ?? '',
    r.diff_q !== null ? r.diff_q : '',
    r.diff_amount !== null ? parseFloat((r.diff_amount / 10000).toFixed(1)) : '',
    r.prev_p !== null ? parseFloat(r.prev_p.toFixed(3)) : '',
    r.curr_p !== null ? parseFloat(r.curr_p.toFixed(3)) : '',
    r.diff_p !== null ? parseFloat(r.diff_p.toFixed(3)) : '',
    BADGE_LABEL[r.status],
  ]);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  ws['!cols'] = [
    { wch: 10 }, { wch: 20 }, { wch: 8 }, { wch: 12 }, { wch: 12 },
    { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 8 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '持股比較');
  XLSX.writeFile(wb, `${ticker}_持股比較_${baseDate}vs${cmpDate}.xlsx`);
}

interface Props { baseDate: string; cmpDate: string; baseHoldings: Holding[]; cmpHoldings: Holding[]; etfTicker: string }

const TH: React.CSSProperties = {
  padding: '11px 10px', fontWeight: 600, fontSize: '.75rem', letterSpacing: '.4px',
  background: '#1C1C1E', color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1,
  cursor: 'pointer', userSelect: 'none',
};

const BADGE_STYLE: React.CSSProperties = {
  display: 'inline-block', padding: '2px 8px', borderRadius: 4,
  fontSize: '.72rem', fontWeight: 600, whiteSpace: 'nowrap', fontFamily: SANS,
};


// 兩個日期之間的產業（族群）佔比差異：沿用當天持股清單「族群鋪陳」的分類口徑，
// 兩天各自歸類後逐族群相減；點列可展開看該族群內個股的佔比變化。
function SectorCompare({ baseHoldings, cmpHoldings, etfTicker, bs, cs }: {
  baseHoldings: Holding[]; cmpHoldings: Holding[]; etfTicker: string; bs: string; cs: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const data = useMemo(() => {
    const cur = buildHoldingsSector(baseHoldings, etfTicker);
    const prev = buildHoldingsSector(cmpHoldings, etfTicker);
    const names = new Set<string>();
    const curM = new Map<string, { weight: number; stocks: Map<string, { name: string; w: number }> }>();
    const prevM = new Map<string, { weight: number; stocks: Map<string, { name: string; w: number }> }>();
    const fill = (r: typeof cur, m: typeof curM) => {
      for (const sl of [...r.slices, ...(r.unclassified.weight > 0 ? [r.unclassified] : [])]) {
        names.add(sl.name);
        m.set(sl.name, { weight: sl.weight, stocks: new Map(sl.stocks.map(x => [x.stockid || x.stockname, { name: x.stockname, w: x.weight }])) });
      }
    };
    fill(cur, curM); fill(prev, prevM);
    const rows = [...names].map(name => {
      const c = curM.get(name), p = prevM.get(name);
      const ids = new Set([...(c?.stocks.keys() ?? []), ...(p?.stocks.keys() ?? [])]);
      const stocks = [...ids].map(id => {
        const cw = c?.stocks.get(id)?.w ?? 0, pw = p?.stocks.get(id)?.w ?? 0;
        return { id, name: (c?.stocks.get(id) ?? p?.stocks.get(id))!.name, cw, pw, diff: cw - pw };
      }).filter(x => Math.abs(x.diff) > 0.0005).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
      const cw = c?.weight ?? 0, pw = p?.weight ?? 0;
      return { name, cw, pw, diff: cw - pw, stocks };
    }).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || b.cw - a.cw);
    return { rows, curOther: cur.other, prevOther: prev.other, market: cur.market };
  }, [baseHoldings, cmpHoldings, etfTicker]);

  const max = Math.max(...data.rows.map(r => Math.max(r.cw, r.pw)), 1);
  const dmax = Math.max(...data.rows.map(r => Math.abs(r.diff)), 0.01);
  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontFamily: SANS, fontSize: '1rem', color: TEXT }}>產業佔比比較</h3>
        <span style={{ fontSize: '.76rem', color: SUB, fontFamily: SANS }}>
          {cs} → {bs}；依「族群曝險」分頁的{data.market === 'tw' ? '國內' : '海外'}族群分類（每檔只歸入第一個含它的族群），依變動幅度排序，點列可展開個股
        </span>
      </div>
      <div style={{ border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'auto' }}>
        <div style={{ minWidth: 640 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 220px) 1fr 80px 80px 84px', gap: 12, padding: '9px 14px', background: '#1C1C1E', color: '#fff', fontSize: '.75rem', fontWeight: 600, fontFamily: SANS }}>
            <span>族群</span><span>佔比（上 {cs}／下 {bs}）</span>
            <span style={{ textAlign: 'right' }}>{cs}</span><span style={{ textAlign: 'right' }}>{bs}</span><span style={{ textAlign: 'right' }}>增減</span>
          </div>
          {data.rows.map((r, i) => {
            const isOpen = open === r.name;
            return (
              <div key={r.name} style={{ borderBottom: i < data.rows.length - 1 ? `1px solid ${BORDER}` : 'none', background: i % 2 === 0 ? '#fff' : '#FAFAF9' }}>
                <div onClick={() => setOpen(isOpen ? null : r.name)}
                  style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 220px) 1fr 80px 80px 84px', gap: 12, alignItems: 'center', padding: '8px 14px', cursor: 'pointer', fontFamily: SANS }}>
                  <span style={{ fontSize: '.85rem', color: TEXT }}>{isOpen ? '▾' : '▸'} {r.name}</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div style={{ height: 6, background: BORDER, borderRadius: 999, overflow: 'hidden' }}>
                      <div style={{ width: `${(r.pw / max) * 100}%`, height: '100%', background: '#C9C2BA' }} />
                    </div>
                    <div style={{ height: 6, background: BORDER, borderRadius: 999, overflow: 'hidden' }}>
                      <div style={{ width: `${(r.cw / max) * 100}%`, height: '100%', background: '#8A6A3C' }} />
                    </div>
                  </div>
                  <span style={{ textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>{r.pw.toFixed(2)}%</span>
                  <span style={{ textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>{r.cw.toFixed(2)}%</span>
                  <span style={{ textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', fontWeight: 700, color: diffColor(Math.abs(r.diff) < 0.005 ? 0 : r.diff) }}>
                    {Math.abs(r.diff) < 0.005 ? '0.00%' : `${r.diff > 0 ? '+' : '−'}${Math.abs(r.diff).toFixed(2)}%`}
                  </span>
                </div>
                {isOpen && (
                  <div style={{ padding: '2px 14px 10px 34px', display: 'flex', flexWrap: 'wrap', gap: '4px 18px', fontSize: '.78rem', color: SUB }}>
                    {r.stocks.length === 0 && <span>此族群個股佔比無變化</span>}
                    {r.stocks.map(s => (
                      <span key={s.id}>{s.name} <span style={{ fontFamily: MONO, color: diffColor(s.diff) }}>{s.pw.toFixed(2)}% → {s.cw.toFixed(2)}%（{s.diff > 0 ? '+' : '−'}{Math.abs(s.diff).toFixed(2)}）</span></span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ marginTop: 8, fontSize: '.74rem', color: SUB, fontFamily: SANS }}>
        現金／期貨／其他資產 <span style={{ fontFamily: MONO }}>{data.prevOther.toFixed(2)}% → {data.curOther.toFixed(2)}%</span> 未列入上表。增減＝{bs} 佔比 − {cs} 佔比（紅增綠減）；長條上灰為 {cs}、下棕為 {bs}。
      </div>
    </div>
  );
}

export default function CompareTab({ baseDate, cmpDate, baseHoldings, cmpHoldings, etfTicker }: Props) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortAsc, setSortAsc] = useState(false);

  const baseRows = buildRows(baseHoldings, cmpHoldings);
  const bs = baseDate.slice(5), cs = cmpDate.slice(5);

  const rows = useMemo(() => {
    if (!sortKey) return baseRows;
    return [...baseRows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === null && bv === null) return 0;
      if (av === null) return sortAsc ? -1 : 1;
      if (bv === null) return sortAsc ? 1 : -1;
      if (typeof av === 'string' && typeof bv === 'string')
        return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
  }, [baseRows, sortKey, sortAsc]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc(p => !p);
    else { setSortKey(key); setSortAsc(false); }
  };

  const thLabel = (key: SortKey, label: string) =>
    sortKey === key ? `${label} ${sortAsc ? '↑' : '↓'}` : label;

  const counts = {
    new:       baseRows.filter(r => r.status === 'new').length,
    increased: baseRows.filter(r => r.status === 'increased').length,
    decreased: baseRows.filter(r => r.status === 'decreased').length,
    removed:   baseRows.filter(r => r.status === 'removed').length,
  };
  const totalChanged = counts.new + counts.increased + counts.decreased + counts.removed;

  const STAT_CARDS = [
    { label: '新增持倉', value: counts.new,       color: UP   },
    { label: '加碼',     value: counts.increased,  color: UP   },
    { label: '減碼',     value: counts.decreased,  color: DOWN },
    { label: '總變化筆數', value: totalChanged,     color: TEXT },
  ];

  return (
    <>
      {/* Stat cards */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden',
        marginBottom: 14, background: '#FAFAF9',
      }}>
        {STAT_CARDS.map((c, i) => (
          <div key={c.label} style={{
            padding: '14px 18px',
            borderRight: i < 3 ? `1px solid ${BORDER}` : 'none',
          }}>
            <div style={{ fontSize: '.72rem', color: SUB, fontWeight: 500, marginBottom: 5, fontFamily: SANS }}>{c.label}</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 700, color: c.color, fontFamily: MONO, lineHeight: 1.1 }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Legend + row count + export */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        {(['new', 'increased', 'decreased', 'removed', 'unchanged'] as Status[]).map(s => (
          <span key={s} style={{ ...BADGE_STYLE, ...BADGE[s] }}>{BADGE_LABEL[s]}</span>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: '.8rem', color: SUB }}>顯示 {rows.length}/{rows.length} 筆　點擊欄位標題可排序</span>
        <button
          onClick={() => exportExcel(rows, baseDate, cmpDate, etfTicker, bs, cs)}
          style={{
            padding: '5px 14px', background: '#fff', border: `1px solid ${BORDER}`,
            borderRadius: 6, cursor: 'pointer', fontSize: '.78rem', color: SUB,
            fontFamily: SANS, fontWeight: 500,
          }}
        >
          ↓ 匯出 Excel
        </button>
      </div>

      {/* Table */}
      <div className="mt" style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '65vh', borderRadius: 8, border: '1px solid #E8E3DF' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
          <thead>
            <tr>
              <th className="m-unstick" onClick={() => toggleSort('stockid')}     style={{ ...TH, textAlign: 'center', width: 78, position: 'sticky', left: 0, zIndex: 2 }}>{thLabel('stockid', '代碼')}</th>
              <th className="m-stick0" onClick={() => toggleSort('stockname')}   style={{ ...TH, textAlign: 'left',   minWidth: 150, position: 'sticky', left: 78, zIndex: 2 }}>{thLabel('stockname', '名稱')}</th>
              <th onClick={() => toggleSort('country')}     style={{ ...TH, textAlign: 'center', width: 80 }}>{thLabel('country', '國家')}</th>
              <th onClick={() => toggleSort('prev_q')}      style={{ ...TH, textAlign: 'right',  width: 110 }}>{thLabel('prev_q', `持股 (${cs})`)}</th>
              <th onClick={() => toggleSort('curr_q')}      style={{ ...TH, textAlign: 'right',  width: 110 }}>{thLabel('curr_q', `持股 (${bs})`)}</th>
              <th onClick={() => toggleSort('diff_q')}      style={{ ...TH, textAlign: 'right',  width: 88 }}>{thLabel('diff_q', '持股變化')}</th>
              <th onClick={() => toggleSort('diff_amount')} style={{ ...TH, textAlign: 'right',  width: 105 }}>{thLabel('diff_amount', '異動金額(萬)')}</th>
              <th onClick={() => toggleSort('prev_p')}      style={{ ...TH, textAlign: 'right',  width: 90 }}>{thLabel('prev_p', `佔比% (${cs})`)}</th>
              <th onClick={() => toggleSort('curr_p')}      style={{ ...TH, textAlign: 'right',  width: 90 }}>{thLabel('curr_p', `佔比% (${bs})`)}</th>
              <th onClick={() => toggleSort('diff_p')}      style={{ ...TH, textAlign: 'right',  width: 88 }}>{thLabel('diff_p', '佔比變化')}</th>
              <th style={{ ...TH, textAlign: 'center', width: 68, cursor: 'default' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.stockid}-${i}`} style={{ background: ROW_BG[r.status], borderBottom: `1px solid ${BORDER}` }}>
                <td className="m-unstick" style={{ padding: '8px 10px', textAlign: 'center', fontFamily: MONO, fontSize: '.78rem', color: SUB, position: 'sticky', left: 0, zIndex: 1, background: ROW_BG[r.status] }}>
                  {r.stockid || '—'}
                </td>
                <td className="m-stick0" style={{ padding: '8px 10px', fontSize: '.85rem', color: TEXT, maxWidth: 200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', position: 'sticky', left: 78, zIndex: 1, background: ROW_BG[r.status] }}>
                  {r.stockname}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'center', fontSize: '.78rem', color: SUB }}>
                  {r.country}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: r.status === 'removed' ? '#BBB' : TEXT }}>
                  {f(r.prev_q)}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: r.status === 'new' ? '#BBB' : TEXT }}>
                  {f(r.curr_q)}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', fontWeight: 600, color: diffColor(r.diff_q) }}>
                  {fd(r.diff_q)}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', fontWeight: 600, color: diffColor(r.diff_amount) }}>
                  {famt(r.diff_amount)}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: r.status === 'removed' ? '#BBB' : TEXT }}>
                  {fp(r.prev_p)}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: r.status === 'new' ? '#BBB' : TEXT }}>
                  {fp(r.curr_p)}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', fontWeight: 600, color: diffColor(r.diff_p) }}>
                  {fdp(r.diff_p)}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                  <span style={{ ...BADGE_STYLE, ...BADGE[r.status] }}>
                    {BADGE_LABEL[r.status]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SectorCompare baseHoldings={baseHoldings} cmpHoldings={cmpHoldings} etfTicker={etfTicker} bs={bs} cs={cs} />
    </>
  );
}
