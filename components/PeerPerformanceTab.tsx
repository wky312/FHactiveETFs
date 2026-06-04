'use client';
import { useState, useMemo } from 'react';
import type { PeerPerfResult } from '@/app/api/peer-performance/route';

const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const RED    = '#C00000';
const GREEN  = '#1A6B45';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

type SortKey = keyof PeerPerfResult;

const PERF_COLS: { key: SortKey; label: string }[] = [
  { key: 'pct1d',  label: '當日%' },
  { key: 'pctWTD', label: '週初至今%' },
  { key: 'pctMTD', label: '月初至今%' },
  { key: 'pctYTD', label: '年初至今%' },
  { key: 'pct5d',  label: '近5日%' },
  { key: 'pct1m',  label: '近1月%' },
  { key: 'pct3m',  label: '近3月%' },
  { key: 'pct6m',  label: '近6月%' },
  { key: 'pct1y',  label: '近一年%' },
];

const TH: React.CSSProperties = {
  padding: '10px 10px', fontWeight: 600, fontSize: '.73rem', letterSpacing: '.3px',
  background: '#1C1C1E', color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1, cursor: 'pointer', userSelect: 'none',
};

function perfColor(v: number | null): string {
  if (v === null) return SUB;
  if (v >=  3) return '#b91c1c';
  if (v >=  1) return '#dc2626';
  if (v <= -3) return '#166534';
  if (v <= -1) return '#16a34a';
  return TEXT;
}
function perfBg(v: number | null): string {
  if (v === null) return 'transparent';
  if (v >=  3) return '#fee2e2';
  if (v >=  1) return '#fef2f2';
  if (v <= -3) return '#dcfce7';
  if (v <= -1) return '#f0fdf4';
  return 'transparent';
}
function fmtPct(v: number | null): string {
  if (v === null) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}
function fmtPrice(v: number | null): string {
  if (v === null) return '—';
  return v.toFixed(2);
}

export default function PeerPerformanceTab() {
  const [data,    setData]    = useState<PeerPerfResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [asOf,    setAsOf]    = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('pct1d');
  const [sortAsc, setSortAsc] = useState(false);

  const load = async () => {
    setLoading(true); setError(''); setData(null);
    try {
      const r = await fetch('/api/peer-performance');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json: PeerPerfResult[] = await r.json();
      setData(json);
      const ts = json.find(x => x.updatedAt)?.updatedAt;
      if (ts) {
        const d = new Date(new Date(ts).getTime() + 8 * 3600 * 1000);
        setAsOf(`${d.getUTCFullYear()}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      setLoading(false);
    }
  };

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc(p => !p);
    else { setSortKey(key); setSortAsc(false); }
  };
  const thLabel = (key: SortKey, label: string) =>
    sortKey === key ? `${label} ${sortAsc ? '↑' : '↓'}` : label;

  const sorted = useMemo(() => {
    if (!data) return [];
    return [...data].sort((a, b) => {
      const av = a[sortKey] as number | null;
      const bv = b[sortKey] as number | null;
      if (av === null && bv === null) return 0;
      if (av === null) return sortAsc ? -1 : 1;
      if (bv === null) return sortAsc ? 1 : -1;
      return sortAsc ? av - bv : bv - av;
    });
  }, [data, sortKey, sortAsc]);

  // Summary row (equal-weight average)
  const avg = useMemo(() => {
    if (!sorted.length) return null;
    const result: Partial<Record<SortKey, number | null>> = {};
    for (const col of PERF_COLS) {
      const vals = sorted.map(r => r[col.key] as number | null).filter(v => v !== null) as number[];
      result[col.key] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    }
    return result;
  }, [sorted]);

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>
      {/* Controls */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <button onClick={load} disabled={loading}
          style={{ padding: '8px 22px', background: loading ? '#999' : RED, color: '#fff', border: 'none', borderRadius: 6, cursor: loading ? 'not-allowed' : 'pointer', fontSize: '.88rem', fontWeight: 600 }}>
          {loading ? '載入中…' : data ? '重新整理' : '載入'}
        </button>
        {loading && <span style={{ fontSize: '.82rem', color: SUB }}>查詢 Yahoo Finance 中，約需 20–40 秒…</span>}
        {asOf && !loading && <span style={{ fontSize: '.78rem', color: SUB }}>報價截至 {asOf} TST</span>}
        <span style={{ marginLeft: 'auto', fontSize: '.75rem', color: SUB }}>績效已還原權息　點擊欄位標題排序</span>
      </div>

      {error && (
        <div style={{ padding: '10px 14px', background: '#fff0f0', border: '1px solid #fca5a5', borderRadius: 6, color: RED, fontSize: '.85rem', marginBottom: 14 }}>
          {error}
        </div>
      )}

      {!data && !loading && (
        <p style={{ color: '#AAA', textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>點擊「載入」查詢同業績效</p>
      )}

      {data && (
        <div style={{ overflowX: 'auto', borderRadius: 8, border: `1px solid ${BORDER}` }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 960 }}>
            <thead>
              <tr>
                <th onClick={() => toggleSort('ticker')}   style={{ ...TH, textAlign: 'left',  width: 72  }}>{thLabel('ticker',  '代號')}</th>
                <th onClick={() => toggleSort('name')}     style={{ ...TH, textAlign: 'left',  minWidth: 120 }}>{thLabel('name', '名稱')}</th>
                <th onClick={() => toggleSort('price')}    style={{ ...TH, textAlign: 'right', width: 70  }}>{thLabel('price',  '收盤價')}</th>
                {PERF_COLS.map(c => (
                  <th key={c.key} onClick={() => toggleSort(c.key)}
                    style={{ ...TH, textAlign: 'right', width: 78, background: sortKey === c.key ? '#333' : '#1C1C1E' }}>
                    {thLabel(c.key, c.label)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={r.ticker} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAF9', borderBottom: `1px solid ${BORDER}` }}>
                  <td style={{ padding: '8px 10px', fontFamily: MONO, fontSize: '.8rem', color: SUB, fontWeight: 600 }}>{r.ticker}</td>
                  <td style={{ padding: '8px 10px', fontSize: '.83rem', color: TEXT, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160 }}>{r.name}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', color: TEXT }}>{fmtPrice(r.price)}</td>
                  {PERF_COLS.map(c => {
                    const v = r[c.key] as number | null;
                    return (
                      <td key={c.key} style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', fontWeight: 600, color: perfColor(v), background: perfBg(v) }}>
                        {fmtPct(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {/* Average row */}
              {avg && (
                <tr style={{ background: '#F0EDE8', borderTop: `2px solid ${BORDER}` }}>
                  <td colSpan={2} style={{ padding: '8px 10px', fontSize: '.78rem', color: SUB, fontWeight: 600 }}>等權平均</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontSize: '.78rem', color: SUB }}>—</td>
                  {PERF_COLS.map(c => {
                    const v = avg[c.key] as number | null;
                    return (
                      <td key={c.key} style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.78rem', fontWeight: 600, color: perfColor(v), background: perfBg(v) }}>
                        {fmtPct(v)}
                      </td>
                    );
                  })}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {data && (
        <div style={{ marginTop: 10, fontSize: '.72rem', color: SUB, lineHeight: 1.8 }}>
          資料來源：Yahoo Finance　週初至今 = 上週五收盤至今　月初至今 = 上月底收盤至今　年初至今 = 去年底收盤至今　近N日為交易日
        </div>
      )}
    </div>
  );
}
