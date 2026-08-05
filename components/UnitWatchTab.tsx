'use client';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import { UNIT_WATCH_PRODUCTS, UnitWatchProduct, UnitWatchRow } from '@/lib/unitWatch';
import PlotlyWrapper from './PlotlyWrapper';

const RED    = '#C00000';
const GREEN  = '#16a34a';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

function fmtUnits(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function fmtPct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

type SortKey = 'date' | 'units' | 'cumAvgUnits' | 'ratio';

const TH: React.CSSProperties = {
  padding: '8px 14px', fontWeight: 600, fontSize: '.75rem',
  background: TEXT, color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1,
  cursor: 'pointer', userSelect: 'none',
};

function exportExcel(rows: UnitWatchRow[], product: UnitWatchProduct) {
  const headers = ['日期', '單位數', '成立以來平均單位數', '佔發行單位數比例', '是否達門檻'];
  const data = rows.map(r => [
    r.date,
    r.units,
    parseFloat(r.cumAvgUnits.toFixed(0)),
    parseFloat((r.ratio * 100).toFixed(2)),
    r.pass ? '是' : '否',
  ]);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  ws['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 20 }, { wch: 16 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '單位數注意商品');
  XLSX.writeFile(wb, `${product.ticker}_單位數注意商品.xlsx`);
}

export default function UnitWatchTab() {
  const [ticker,  setTicker]  = useState(UNIT_WATCH_PRODUCTS[0].ticker);
  const [product, setProduct] = useState<UnitWatchProduct | null>(null);
  const [rows,    setRows]    = useState<UnitWatchRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortAsc, setSortAsc] = useState(false);

  const load = useCallback(async (t: string) => {
    setLoading(true); setError(''); setRows(null); setProduct(null);
    try {
      const res  = await fetch(`/api/unit-watch?ticker=${encodeURIComponent(t)}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setProduct(json.product as UnitWatchProduct);
      setRows(json.rows as UnitWatchRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    load(ticker);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTickerChange = useCallback((t: string) => {
    setTicker(t);
    load(t);
  }, [load]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc(p => !p);
    else { setSortKey(key); setSortAsc(false); }
  };
  const label = (key: SortKey, text: string) =>
    sortKey === key ? `${text} ${sortAsc ? '↑' : '↓'}` : text;

  const sorted = useMemo(() => {
    if (!rows) return [];
    return [...rows].sort((a, b) => {
      if (sortKey === 'date') return sortAsc ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
      return sortAsc ? a[sortKey] - b[sortKey] : b[sortKey] - a[sortKey];
    });
  }, [rows, sortKey, sortAsc]);

  const latest = rows && rows.length > 0 ? rows[rows.length - 1] : null;

  const chartDates = rows?.map(r => r.date) ?? [];
  const chartRatio = rows?.map(r => r.ratio * 100) ?? [];
  const traces = product ? [
    {
      type: 'scatter', mode: 'lines', name: '佔發行單位數比例',
      x: chartDates, y: chartRatio,
      line: { color: RED, width: 2 },
      hovertemplate: '<b>%{x}</b><br>%{y:.2f}%<extra></extra>',
    },
    {
      type: 'scatter', mode: 'lines', name: `門檻 ${(product.thresholdRatio * 100).toFixed(0)}%`,
      x: chartDates, y: chartDates.map(() => product.thresholdRatio * 100),
      line: { color: SUB, width: 1.5, dash: 'dash' },
      hoverinfo: 'skip',
    },
  ] : [];

  const layout = {
    paper_bgcolor: '#fff',
    plot_bgcolor: '#fff',
    margin: { l: 60, r: 20, t: 10, b: 80 },
    height: 300,
    legend: { orientation: 'h', x: 0, y: -0.28, font: { family: SANS, size: 11 } },
    xaxis: { type: 'category', tickangle: -45, tickfont: { family: MONO, size: 10 }, gridcolor: BORDER, automargin: true, nticks: 12 },
    yaxis: {
      title: { text: '佔發行單位數比例 (%)', font: { family: SANS, size: 11 } },
      tickfont: { family: MONO, size: 10 }, gridcolor: BORDER,
    },
    hoverlabel: { bgcolor: '#fff', bordercolor: '#D0CBC6', font: { family: SANS, size: 12, color: TEXT }, align: 'left' },
  };

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 18, flexWrap: 'wrap' }}>
        <div>
          <label style={{ display: 'block', fontSize: '.78rem', color: SUB, marginBottom: 4, fontWeight: 500 }}>監測商品</label>
          <select
            value={ticker} onChange={e => handleTickerChange(e.target.value)}
            style={{ padding: '7px 12px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.87rem', color: TEXT, background: '#fff', fontFamily: SANS, cursor: 'pointer' }}
          >
            {UNIT_WATCH_PRODUCTS.map(p => <option key={p.ticker} value={p.ticker}>{p.ticker}</option>)}
          </select>
        </div>
        <button
          onClick={() => load(ticker)} disabled={loading}
          style={{ padding: '8px 22px', background: loading ? '#999' : RED, color: '#fff', border: 'none', borderRadius: 6,
            cursor: loading ? 'not-allowed' : 'pointer', fontSize: '.88rem', fontWeight: 600, fontFamily: SANS }}
        >
          {loading ? '載入中…' : '重新整理'}
        </button>
      </div>

      {error && (
        <div style={{ padding: '14px 16px', background: '#fff0f0', border: '1px solid #fca5a5', borderRadius: 8, color: RED, fontSize: '.85rem', marginBottom: 16 }}>
          載入失敗：{error}
        </div>
      )}

      {!rows && !loading && !error && (
        <p style={{ color: '#AAA', textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>請選擇監測商品</p>
      )}

      {rows && rows.length === 0 && (
        <div style={{ padding: '24px', textAlign: 'center', color: SUB, fontSize: '.85rem' }}>
          查無資料，請確認 Supabase 是否已有 {ticker} 的每日單位數紀錄
        </div>
      )}

      {product && rows && rows.length > 0 && latest && (
        <>
          {/* Summary cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden', marginBottom: 20, background: '#FAFAF9' }}>
            {[
              { label: `發行時單位數 (${product.listingDate})`, value: fmtUnits(product.listingUnits), color: TEXT },
              { label: `最新單位數 (${latest.date})`,            value: fmtUnits(latest.units),          color: TEXT },
              { label: '成立以來平均單位數',                      value: fmtUnits(latest.cumAvgUnits),    color: TEXT },
              { label: '佔發行單位數比例',                        value: fmtPct(latest.ratio),            color: latest.pass ? RED : GREEN },
              { label: `門檻 (≥ ${(product.thresholdRatio * 100).toFixed(0)}%)`, value: latest.pass ? '達標' : '未達標', color: latest.pass ? RED : GREEN },
            ].map((c, i, arr) => (
              <div key={c.label} style={{ padding: '14px 16px', borderRight: i < arr.length - 1 ? `1px solid ${BORDER}` : 'none' }}>
                <div style={{ fontSize: '.72rem', color: SUB, fontWeight: 500, marginBottom: 4 }}>{c.label}</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 700, color: c.color, fontFamily: MONO, lineHeight: 1.2 }}>{c.value}</div>
              </div>
            ))}
          </div>

          {!latest.pass && (
            <div style={{ padding: '12px 16px', background: '#F0FDF4', border: '1px solid #86efac', borderRadius: 8, color: GREEN, fontSize: '.85rem', marginBottom: 16, fontWeight: 600 }}>
              ⚠ 成立以來平均單位數已低於發行時單位數之一半，請留意主管機關規定門檻。
            </div>
          )}

          {/* Chart */}
          <PlotlyWrapper traces={traces} layout={layout} style={{ marginBottom: 20 }} />

          {/* Export */}
          <div style={{ display: 'flex', marginBottom: 10 }}>
            <button
              onClick={() => exportExcel(sorted, product)}
              style={{ marginLeft: 'auto', padding: '5px 14px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, cursor: 'pointer', fontSize: '.78rem', color: SUB, fontFamily: SANS, fontWeight: 500 }}
            >
              ↓ 匯出 Excel
            </button>
          </div>

          {/* Table */}
          <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '50vh', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
              <thead>
                <tr>
                  <th onClick={() => toggleSort('date')}        style={{ ...TH, textAlign: 'left', position: 'sticky', left: 0, zIndex: 2 }}>{label('date', '日期')}</th>
                  <th onClick={() => toggleSort('units')}       style={{ ...TH, textAlign: 'right' }}>{label('units', '單位數')}</th>
                  <th onClick={() => toggleSort('cumAvgUnits')} style={{ ...TH, textAlign: 'right' }}>{label('cumAvgUnits', '成立以來平均單位數')}</th>
                  <th onClick={() => toggleSort('ratio')}       style={{ ...TH, textAlign: 'right' }}>{label('ratio', '佔發行單位數比例')}</th>
                  <th style={{ ...TH, textAlign: 'center', cursor: 'default' }}>是否達門檻</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => {
                  const rowBg = i % 2 === 0 ? '#fff' : '#FAFAF9';
                  return (
                  <tr key={r.date} style={{ background: rowBg, borderBottom: `1px solid ${BORDER}` }}>
                    <td style={{ padding: '7px 14px', fontFamily: MONO, fontSize: '.8rem', color: TEXT, position: 'sticky', left: 0, zIndex: 1, background: rowBg }}>{r.date}</td>
                    <td style={{ padding: '7px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>{fmtUnits(r.units)}</td>
                    <td style={{ padding: '7px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>{fmtUnits(r.cumAvgUnits)}</td>
                    <td style={{ padding: '7px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: r.pass ? RED : GREEN, fontWeight: 600 }}>{fmtPct(r.ratio)}</td>
                    <td style={{ padding: '7px 14px', textAlign: 'center' }}>
                      <span style={{
                        display: 'inline-block', padding: '2px 10px', borderRadius: 4, fontSize: '.72rem', fontWeight: 600,
                        background: r.pass ? '#FFF5F5' : '#F0FDF4', color: r.pass ? RED : GREEN,
                        border: `1px solid ${r.pass ? '#FFCDD2' : '#86efac'}`,
                      }}>
                        {r.pass ? '達標' : '未達標'}
                      </span>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Note */}
          <div style={{ marginTop: 12, fontSize: '.72rem', color: SUB, lineHeight: 1.8 }}>
            <b>成立以來平均單位數</b>＝自掛牌日（{product.listingDate}）起，至該日為止每個交易日單位數之算術平均。<br />
            <b>門檻</b>＝主管機關要求成立以來平均單位數不得低於發行時單位數之一半（{fmtUnits(product.listingUnits)} × {product.thresholdRatio} = {fmtUnits(product.listingUnits * product.thresholdRatio)} 單位）。<br />
            <b>資料來源：</b>復華投信 ETF PCF（每個交易日更新）。
          </div>
        </>
      )}
    </div>
  );
}
