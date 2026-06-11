'use client';
import { useState, useEffect, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { Holding } from '@/lib/types';

const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const UP     = '#C00000';
const DOWN   = '#1A6B45';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

const STATUS_ORDER = { new: 0, increased: 1, decreased: 2, removed: 3, unchanged: 4 } as const;
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
const BADGE_STYLE: React.CSSProperties = {
  display: 'inline-block', padding: '2px 8px', borderRadius: 4,
  fontSize: '.72rem', fontWeight: 600, whiteSpace: 'nowrap', fontFamily: SANS,
};
const TH_BASE: React.CSSProperties = {
  padding: '11px 10px', fontWeight: 600, fontSize: '.75rem', letterSpacing: '.4px',
  background: '#1C1C1E', color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1, cursor: 'pointer', userSelect: 'none',
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
const famt = (n: number | null) => {
  if (n === null) return '—';
  const wan = n / 10000;
  if (Math.abs(wan) < 0.05) return '0';
  const s = Math.abs(wan).toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  return wan > 0 ? `+${s}` : `−${s}`;
};

type SortKey = 'stockid' | 'stockname' | 'prev_q' | 'curr_q' | 'diff_q' | 'diff_amount' | 'prev_p' | 'curr_p' | 'diff_p';

interface Row {
  stockid: string; stockname: string; country: string;
  curr_q: number | null; prev_q: number | null; diff_q: number | null;
  curr_p: number | null; prev_p: number | null; diff_p: number | null;
  diff_amount: number | null;
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
    // treat qshare=0 in current as fully removed
    const cq = c?.qshare ?? 0;
    const pq = p?.qshare ?? 0;
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
      diff_q: c && cq > 0 && p && pq > 0 ? cq - pq : null,
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

interface PcfSnapshot { aum: number }
interface EtfPrice { price: number | null; prevClose: number | null; priceAsOf: string | null }
interface Props {
  baseDate: string; cmpDate: string;
  baseHoldings: Holding[]; cmpHoldings: Holding[];
  fundId: string; yfTicker: string; etfTicker: string;
}

function exportExcel(rows: Row[], baseDate: string, cmpDate: string, ticker: string, bs: string, cs: string) {
  const headers = ['代碼', '名稱', '國家', `持股(${cs})`, `持股(${bs})`, '持股變化', '異動金額(萬)', `佔比%(${cs})`, `佔比%(${bs})`, '佔比變化', '操作'];
  const data = rows.map(r => [
    r.stockid, r.stockname, r.country,
    r.prev_q ?? '', r.curr_q ?? '',
    r.diff_q !== null ? r.diff_q : '',
    r.diff_amount !== null ? parseFloat((r.diff_amount / 10000).toFixed(1)) : '',
    r.prev_p !== null ? parseFloat(r.prev_p.toFixed(3)) : '',
    r.curr_p !== null ? parseFloat(r.curr_p.toFixed(3)) : '',
    r.diff_p !== null ? parseFloat(r.diff_p.toFixed(3)) : '',
    BADGE_LABEL[r.status],
  ]);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  ws['!cols'] = [{ wch: 10 }, { wch: 20 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 8 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '當日摘要');
  XLSX.writeFile(wb, `${ticker}_當日摘要_${baseDate}.xlsx`);
}

function fmtAum(v: number)      { return `${v.toFixed(2)} 億`; }
function fmtAumDiff(v: number)  { return `${v > 0 ? '+' : ''}${v.toFixed(2)} 億`; }
function fmtPrice(v: number)    { return v.toFixed(2); }

export default function DailySummaryTab({ baseDate, cmpDate, baseHoldings, cmpHoldings, fundId, yfTicker, etfTicker }: Props) {
  const [snapshot, setSnapshot] = useState<{
    curr: PcfSnapshot | null; prev: PcfSnapshot | null; etfPrice: EtfPrice;
  } | null>(null);
  const [pcfLoading, setPcfLoading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortAsc, setSortAsc] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setPcfLoading(true);
      setSnapshot(null);
      try {
        const res = await fetch(
          `/api/pcf-snapshot?date=${encodeURIComponent(baseDate)}&prevDate=${encodeURIComponent(cmpDate)}&fundId=${encodeURIComponent(fundId)}&yfTicker=${encodeURIComponent(yfTicker)}`
        );
        const json = await res.json();
        if (!cancelled) setSnapshot(json);
      } catch {
        if (!cancelled) setSnapshot({ curr: null, prev: null, etfPrice: { price: null, prevClose: null, priceAsOf: null } });
      } finally {
        if (!cancelled) setPcfLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [baseDate, cmpDate, fundId, yfTicker]);

  const allRows = buildRows(baseHoldings, cmpHoldings);
  const changed = allRows.filter(r => r.status !== 'unchanged');

  const sorted = useMemo(() => {
    if (!sortKey) return changed;
    return [...changed].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === null && bv === null) return 0;
      if (av === null) return sortAsc ? -1 : 1;
      if (bv === null) return sortAsc ? 1 : -1;
      if (typeof av === 'string' && typeof bv === 'string')
        return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
  }, [changed, sortKey, sortAsc]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc(p => !p);
    else { setSortKey(key); setSortAsc(false); }
  };
  const thLabel = (key: SortKey, label: string) =>
    sortKey === key ? `${label} ${sortAsc ? '↑' : '↓'}` : label;

  const bs = baseDate.slice(5), cs = cmpDate.slice(5);

  const curr = snapshot?.curr ?? null;
  const prev = snapshot?.prev ?? null;
  const etfPrice = snapshot?.etfPrice ?? { price: null, prevClose: null, priceAsOf: null };

  const aumChange = curr && prev ? curr.aum - prev.aum : null;
  const priceChange = etfPrice.price !== null && etfPrice.prevClose !== null
    ? etfPrice.price - etfPrice.prevClose : null;
  const priceChangePct = priceChange !== null && etfPrice.prevClose
    ? priceChange / etfPrice.prevClose * 100 : null;

  const priceAsOfLabel = (() => {
    if (!etfPrice.priceAsOf) return '';
    const d = new Date(new Date(etfPrice.priceAsOf).getTime() + 8 * 3600 * 1000);
    return `${d.getUTCFullYear()}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
  })();

  const counts = {
    new:       changed.filter(r => r.status === 'new').length,
    increased: changed.filter(r => r.status === 'increased').length,
    decreased: changed.filter(r => r.status === 'decreased').length,
    removed:   changed.filter(r => r.status === 'removed').length,
  };
  const total = changed.length;

  return (
    <>
      {/* ── Scale / ETF Price header ── */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden',
        marginBottom: 14, background: '#FAFAF9',
      }}>
        {[
          {
            label: `基金規模 (${bs})`,
            value: pcfLoading ? '載入中…' : curr ? fmtAum(curr.aum) : '—',
            sub: null, color: TEXT,
          },
          {
            label: `規模變化 (vs ${cs})`,
            value: pcfLoading ? '—' : aumChange !== null ? fmtAumDiff(aumChange) : '—',
            sub: null,
            color: aumChange === null ? SUB : aumChange > 0 ? UP : aumChange < 0 ? DOWN : SUB,
          },
          {
            label: `ETF 股價${priceAsOfLabel ? ` (${priceAsOfLabel})` : ` (${bs})`}`,
            value: pcfLoading ? '載入中…' : etfPrice.price !== null ? fmtPrice(etfPrice.price) : '—',
            sub: null, color: TEXT,
          },
          {
            label: '股價變化',
            value: pcfLoading ? '—'
              : priceChange !== null ? (priceChange > 0 ? `+${fmtPrice(priceChange)}` : priceChange < 0 ? `−${fmtPrice(Math.abs(priceChange))}` : '0')
              : '—',
            sub: priceChangePct !== null
              ? `(${priceChangePct > 0 ? '+' : priceChangePct < 0 ? '−' : ''}${Math.abs(priceChangePct).toFixed(2)}%)`
              : null,
            color: priceChange === null ? SUB : priceChange > 0 ? UP : priceChange < 0 ? DOWN : SUB,
          },
        ].map((c, i) => (
          <div key={c.label} style={{
            padding: '14px 18px',
            borderRight: i < 3 ? `1px solid ${BORDER}` : 'none',
          }}>
            <div style={{ fontSize: '.72rem', color: SUB, fontWeight: 500, marginBottom: 5, fontFamily: SANS }}>{c.label}</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: c.color, fontFamily: MONO, lineHeight: 1.1 }}>{c.value}</div>
            {c.sub && <div style={{ fontSize: '.85rem', fontWeight: 600, color: c.color, fontFamily: MONO, marginTop: 2 }}>{c.sub}</div>}
          </div>
        ))}
      </div>

      {/* ── Change stats ── */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden',
        marginBottom: 14, background: '#FAFAF9',
      }}>
        {[
          { label: '新增持倉', value: counts.new,       color: UP   },
          { label: '加碼',     value: counts.increased,  color: UP   },
          { label: '減碼',     value: counts.decreased,  color: DOWN },
          { label: '清倉',     value: counts.removed,    color: DOWN },
        ].map((c, i) => (
          <div key={c.label} style={{
            padding: '14px 18px',
            borderRight: i < 3 ? `1px solid ${BORDER}` : 'none',
          }}>
            <div style={{ fontSize: '.72rem', color: SUB, fontWeight: 500, marginBottom: 5, fontFamily: SANS }}>{c.label}</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 700, color: c.color, fontFamily: MONO, lineHeight: 1.1 }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* ── Legend ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        {(['new', 'increased', 'decreased', 'removed'] as Status[]).map(s => (
          <span key={s} style={{ ...BADGE_STYLE, ...BADGE[s] }}>{BADGE_LABEL[s]}</span>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: '.8rem', color: SUB }}>共 {total} 筆變動　點擊欄位標題可排序</span>
        {sorted.length > 0 && (
          <button
            onClick={() => exportExcel(sorted, baseDate, cmpDate, etfTicker, bs, cs)}
            style={{ padding: '5px 14px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, cursor: 'pointer', fontSize: '.78rem', color: SUB, fontFamily: SANS, fontWeight: 500 }}
          >
            ↓ 匯出 Excel
          </button>
        )}
      </div>

      {/* ── Table ── */}
      {sorted.length === 0 ? (
        <p style={{ color: '#AAA', textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>當日無持股異動</p>
      ) : (
        <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '60vh', borderRadius: 8, border: '1px solid #E8E3DF' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
            <thead>
              <tr>
                <th onClick={() => toggleSort('stockid')}   style={{ ...TH_BASE, textAlign: 'center', width: 78 }}>{thLabel('stockid',   '代碼')}</th>
                <th onClick={() => toggleSort('stockname')} style={{ ...TH_BASE, textAlign: 'left',   minWidth: 150 }}>{thLabel('stockname', '名稱')}</th>
                <th style={{ ...TH_BASE, textAlign: 'center', width: 60, cursor: 'default' }}>國家</th>
                <th onClick={() => toggleSort('prev_q')}    style={{ ...TH_BASE, textAlign: 'right',  width: 110 }}>{thLabel('prev_q',    `持股 (${cs})`)}</th>
                <th onClick={() => toggleSort('curr_q')}    style={{ ...TH_BASE, textAlign: 'right',  width: 110 }}>{thLabel('curr_q',    `持股 (${bs})`)}</th>
                <th onClick={() => toggleSort('diff_q')}    style={{ ...TH_BASE, textAlign: 'right',  width: 88  }}>{thLabel('diff_q',    '持股變化')}</th>
                <th onClick={() => toggleSort('diff_amount')} style={{ ...TH_BASE, textAlign: 'right', width: 105 }}>{thLabel('diff_amount', '異動金額(萬)')}</th>
                <th onClick={() => toggleSort('prev_p')}    style={{ ...TH_BASE, textAlign: 'right',  width: 90  }}>{thLabel('prev_p',    `佔比% (${cs})`)}</th>
                <th onClick={() => toggleSort('curr_p')}    style={{ ...TH_BASE, textAlign: 'right',  width: 90  }}>{thLabel('curr_p',    `佔比% (${bs})`)}</th>
                <th onClick={() => toggleSort('diff_p')}    style={{ ...TH_BASE, textAlign: 'right',  width: 88  }}>{thLabel('diff_p',    '佔比變化')}</th>
                <th style={{ ...TH_BASE, textAlign: 'center', width: 68, cursor: 'default' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={`${r.stockid}-${i}`} style={{ background: ROW_BG[r.status], borderBottom: `1px solid ${BORDER}` }}>
                  <td style={{ padding: '8px 10px', textAlign: 'center', fontFamily: MONO, fontSize: '.78rem', color: SUB }}>{r.stockid || '—'}</td>
                  <td style={{ padding: '8px 10px', fontSize: '.85rem', color: TEXT, maxWidth: 200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.stockname}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'center', fontSize: '.78rem', color: SUB }}>{r.country}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: r.status === 'removed' ? '#BBB' : TEXT }}>{f(r.prev_q)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: r.status === 'new'     ? '#BBB' : TEXT }}>{f(r.curr_q)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', fontWeight: 600, color: diffColor(r.diff_q) }}>{fd(r.diff_q)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', fontWeight: 600, color: diffColor(r.diff_amount) }}>{famt(r.diff_amount)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: r.status === 'removed' ? '#BBB' : TEXT }}>{fp(r.prev_p)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: r.status === 'new'     ? '#BBB' : TEXT }}>{fp(r.curr_p)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', fontWeight: 600, color: diffColor(r.diff_p) }}>{fdp(r.diff_p)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                    <span style={{ ...BADGE_STYLE, ...BADGE[r.status] }}>{BADGE_LABEL[r.status]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
