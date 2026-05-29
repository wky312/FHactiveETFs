'use client';
import { useState, useEffect } from 'react';
import { Holding } from '@/lib/types';

const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const UP     = '#C00000';
const DOWN   = '#1A6B45';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

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

const BADGE_STYLE: React.CSSProperties = {
  display: 'inline-block', padding: '2px 8px', borderRadius: 4,
  fontSize: '.72rem', fontWeight: 600, whiteSpace: 'nowrap', fontFamily: SANS,
};

const TH: React.CSSProperties = {
  padding: '11px 10px', fontWeight: 600, fontSize: '.75rem', letterSpacing: '.4px',
  background: '#1C1C1E', color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1,
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
    if  (c && !p)                   status = 'new';
    else if (!c)                    status = 'removed';
    else if (c.qshare > p!.qshare) status = 'increased';
    else if (c.qshare < p!.qshare) status = 'decreased';

    const cPrice = c && c.qshare > 0 ? c.mvalue / c.qshare : null;
    const pPrice = p && p.qshare > 0 ? p.mvalue / p.qshare : null;
    let diff_amount: number | null = null;
    if (c && p && cPrice !== null)       diff_amount = cPrice * (c.qshare - p.qshare);
    else if (c && cPrice !== null)       diff_amount = c.mvalue;
    else if (p && pPrice !== null)       diff_amount = -p.mvalue;

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
      diff_amount,
      status,
    });
  }
  return rows.sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.curr_p ?? 0) - (a.curr_p ?? 0)
  );
}

interface PcfSnapshot { aum: number; pnav: number }
interface Props {
  baseDate: string;
  cmpDate: string;
  baseHoldings: Holding[];
  cmpHoldings: Holding[];
  fundId: string;
}

function fmtAum(v: number) {
  return `${v.toFixed(2)} 億`;
}
function fmtAumDiff(v: number) {
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)} 億`;
}

export default function DailySummaryTab({ baseDate, cmpDate, baseHoldings, cmpHoldings, fundId }: Props) {
  const [snapshot, setSnapshot] = useState<{ curr: PcfSnapshot | null; prev: PcfSnapshot | null } | null>(null);
  const [pcfLoading, setPcfLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setPcfLoading(true);
      setSnapshot(null);
      try {
        const res = await fetch(
          `/api/pcf-snapshot?date=${encodeURIComponent(baseDate)}&prevDate=${encodeURIComponent(cmpDate)}&fundId=${encodeURIComponent(fundId)}`
        );
        const json = await res.json();
        if (!cancelled) setSnapshot(json);
      } catch {
        if (!cancelled) setSnapshot({ curr: null, prev: null });
      } finally {
        if (!cancelled) setPcfLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [baseDate, cmpDate, fundId]);

  const allRows  = buildRows(baseHoldings, cmpHoldings);
  const rows     = allRows.filter(r => r.status !== 'unchanged');
  const bs = baseDate.slice(5), cs = cmpDate.slice(5);

  const curr = snapshot?.curr ?? null;
  const prev = snapshot?.prev ?? null;
  const aumChange = curr && prev ? curr.aum  - prev.aum  : null;
  const navChange = curr && prev ? curr.pnav - prev.pnav : null;

  const counts = {
    new:       rows.filter(r => r.status === 'new').length,
    increased: rows.filter(r => r.status === 'increased').length,
    decreased: rows.filter(r => r.status === 'decreased').length,
    removed:   rows.filter(r => r.status === 'removed').length,
  };
  const totalChanged = counts.new + counts.increased + counts.decreased + counts.removed;

  return (
    <>
      {/* ── Scale / NAV header ── */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden',
        marginBottom: 14, background: '#FAFAF9',
      }}>
        {[
          {
            label: `基金規模 (${bs})`,
            value: pcfLoading ? '載入中…' : curr ? fmtAum(curr.aum) : '—',
            color: TEXT,
          },
          {
            label: `規模變化 (vs ${cs})`,
            value: pcfLoading ? '—' : aumChange !== null ? fmtAumDiff(aumChange) : '—',
            color: aumChange === null ? SUB : aumChange > 0 ? UP : aumChange < 0 ? DOWN : SUB,
          },
          {
            label: `單位淨值 (${bs})`,
            value: pcfLoading ? '載入中…' : curr ? curr.pnav.toFixed(4) : '—',
            color: TEXT,
          },
          {
            label: `淨值變化 (vs ${cs})`,
            value: pcfLoading ? '—' : navChange !== null
              ? (navChange > 0 ? `+${navChange.toFixed(4)}` : navChange < 0 ? `−${Math.abs(navChange).toFixed(4)}` : '0')
              : '—',
            color: navChange === null ? SUB : navChange > 0 ? UP : navChange < 0 ? DOWN : SUB,
          },
        ].map((c, i) => (
          <div key={c.label} style={{
            padding: '14px 18px',
            borderRight: i < 3 ? `1px solid ${BORDER}` : 'none',
          }}>
            <div style={{ fontSize: '.72rem', color: SUB, fontWeight: 500, marginBottom: 5, fontFamily: SANS }}>{c.label}</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: c.color, fontFamily: MONO, lineHeight: 1.1 }}>{c.value}</div>
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
          { label: '總變化筆數', value: totalChanged,    color: TEXT },
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
        <span style={{ marginLeft: 'auto', fontSize: '.8rem', color: SUB }}>顯示 {rows.length} 筆變動</span>
      </div>

      {/* ── Table ── */}
      {rows.length === 0 ? (
        <p style={{ color: '#AAA', textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>當日無持股異動</p>
      ) : (
        <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '60vh', borderRadius: 8, border: '1px solid #E8E3DF' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
            <thead>
              <tr>
                <th style={{ ...TH, textAlign: 'center', width: 78 }}>代碼</th>
                <th style={{ ...TH, textAlign: 'left',   minWidth: 150 }}>名稱</th>
                <th style={{ ...TH, textAlign: 'center', width: 80 }}>國家</th>
                <th style={{ ...TH, textAlign: 'right',  width: 110 }}>持股 ({cs})</th>
                <th style={{ ...TH, textAlign: 'right',  width: 110 }}>持股 ({bs})</th>
                <th style={{ ...TH, textAlign: 'right',  width: 88 }}>持股變化</th>
                <th style={{ ...TH, textAlign: 'right',  width: 105 }}>異動金額(萬)</th>
                <th style={{ ...TH, textAlign: 'right',  width: 90 }}>佔比% ({cs})</th>
                <th style={{ ...TH, textAlign: 'right',  width: 90 }}>佔比% ({bs})</th>
                <th style={{ ...TH, textAlign: 'right',  width: 88 }}>佔比變化</th>
                <th style={{ ...TH, textAlign: 'center', width: 68 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.stockid}-${i}`} style={{ background: ROW_BG[r.status], borderBottom: `1px solid ${BORDER}` }}>
                  <td style={{ padding: '8px 10px', textAlign: 'center', fontFamily: MONO, fontSize: '.78rem', color: SUB }}>
                    {r.stockid || '—'}
                  </td>
                  <td style={{ padding: '8px 10px', fontSize: '.85rem', color: TEXT, maxWidth: 200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
      )}
    </>
  );
}
