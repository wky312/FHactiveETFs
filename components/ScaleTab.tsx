'use client';
import { useState, useCallback, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { ScaleDay } from '@/lib/fhtrustScale';
import PlotlyWrapper from './PlotlyWrapper';

const RED    = '#C00000';
const GREEN  = '#16a34a';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

function localStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function toApiDate(s: string) { return s.replace(/-/g, '/'); }

function fmtAum(v: number): string {
  if (v >= 10000) return `${(v / 10000).toFixed(2)} 兆`;
  return `${v.toFixed(2)} 億`;
}
function fmtNetSub(v: number): string {
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)} 億`;
}

interface MonthRow {
  month: string;
  netSub: number;
  lastAum: number;
  days: number;
}

function aggregateMonthly(data: ScaleDay[]): MonthRow[] {
  const map = new Map<string, MonthRow>();
  for (const d of data) {
    const month = d.date.substring(0, 7); // YYYY/MM
    if (!map.has(month)) map.set(month, { month, netSub: 0, lastAum: 0, days: 0 });
    const row = map.get(month)!;
    row.netSub  += d.netSub;
    row.lastAum  = d.aum; // last trading day of month (data is sorted asc)
    row.days    += 1;
  }
  return Array.from(map.values()).sort((a, b) => a.month.localeCompare(b.month));
}

type DailySortKey = 'date' | 'netSub' | 'aum' | 'pnav';
type MonthlySortKey = 'month' | 'netSub' | 'lastAum' | 'days';

const TH: React.CSSProperties = {
  padding: '8px 14px', fontWeight: 600, fontSize: '.75rem',
  background: TEXT, color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1,
  cursor: 'pointer', userSelect: 'none',
};

function exportDailyExcel(rows: ScaleDay[], ticker: string, start: string, end: string) {
  const headers = ['日期', '淨申購/贖回(億)', '基金規模(億)', '單位淨值'];
  const data = rows.map(r => [r.date, parseFloat(r.netSub.toFixed(2)), parseFloat(r.aum.toFixed(2)), parseFloat(r.pnav.toFixed(4))]);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  ws['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '每日規模');
  XLSX.writeFile(wb, `${ticker}_規模變化_每日_${start}_${end}.xlsx`);
}

function exportMonthlyExcel(rows: MonthRow[], ticker: string, start: string, end: string) {
  const headers = ['月份', '月淨申購/贖回(億)', '月底基金規模(億)', '交易天數'];
  const data = rows.map(r => [r.month, parseFloat(r.netSub.toFixed(2)), parseFloat(r.lastAum.toFixed(2)), r.days]);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  ws['!cols'] = [{ wch: 10 }, { wch: 18 }, { wch: 16 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '每月規模');
  XLSX.writeFile(wb, `${ticker}_規模變化_每月_${start}_${end}.xlsx`);
}

export default function ScaleTab({ fundId, etfTicker }: { fundId: string; etfTicker: string }) {
  const today = new Date();
  const defaultEnd = new Date(today);
  defaultEnd.setDate(defaultEnd.getDate() - 1);
  const defaultStart = new Date(defaultEnd);
  defaultStart.setDate(defaultStart.getDate() - 29);

  const [startDate,    setStartDate]    = useState(localStr(defaultStart));
  const [endDate,      setEndDate]      = useState(localStr(defaultEnd));
  const [data,         setData]         = useState<ScaleDay[] | null>(null);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [view,         setView]         = useState<'daily' | 'monthly'>('daily');
  const [dSortKey,     setDSortKey]     = useState<DailySortKey>('date');
  const [dSortAsc,     setDSortAsc]     = useState(false);
  const [mSortKey,     setMSortKey]     = useState<MonthlySortKey>('month');
  const [mSortAsc,     setMSortAsc]     = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/etf-scale?startDate=${encodeURIComponent(toApiDate(startDate))}&endDate=${encodeURIComponent(toApiDate(endDate))}&fundId=${encodeURIComponent(fundId)}`;
      const res  = await fetch(url);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json as ScaleDay[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, fundId]);

  // Quick range presets
  const setRange = (days: number) => {
    const end   = new Date();
    end.setDate(end.getDate() - 1);
    const start = new Date(end);
    start.setDate(start.getDate() - (days - 1));
    setStartDate(localStr(start));
    setEndDate(localStr(end));
  };

  const monthly = data ? aggregateMonthly(data) : [];

  const toggleDSort = (key: DailySortKey) => {
    if (key === dSortKey) setDSortAsc(p => !p);
    else { setDSortKey(key); setDSortAsc(false); }
  };
  const toggleMSort = (key: MonthlySortKey) => {
    if (key === mSortKey) setMSortAsc(p => !p);
    else { setMSortKey(key); setMSortAsc(false); }
  };
  const dLabel = (key: DailySortKey, label: string) =>
    dSortKey === key ? `${label} ${dSortAsc ? '↑' : '↓'}` : label;
  const mLabel = (key: MonthlySortKey, label: string) =>
    mSortKey === key ? `${label} ${mSortAsc ? '↑' : '↓'}` : label;

  const sortedDaily = useMemo(() => {
    if (!data) return [];
    return [...data].sort((a, b) => {
      if (dSortKey === 'date') return dSortAsc ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
      const av = a[dSortKey], bv = b[dSortKey];
      return dSortAsc ? av - bv : bv - av;
    });
  }, [data, dSortKey, dSortAsc]);

  const sortedMonthly = useMemo(() => {
    return [...monthly].sort((a, b) => {
      if (mSortKey === 'month') return mSortAsc ? a.month.localeCompare(b.month) : b.month.localeCompare(a.month);
      const av = a[mSortKey], bv = b[mSortKey];
      return mSortAsc ? av - bv : bv - av;
    });
  }, [monthly, mSortKey, mSortAsc]);

  const latestAum   = data && data.length > 0 ? data[data.length - 1].aum : null;
  const totalNetSub = data ? data.reduce((s, d) => s + d.netSub, 0) : null;
  const tradingDays = data ? data.length : null;
  const avgNetSub   = totalNetSub !== null && tradingDays ? totalNetSub / tradingDays : null;

  // Chart data
  const chartDates  = view === 'daily' ? (data?.map(d => d.date) ?? []) : monthly.map(m => m.month);
  const chartNetSub = view === 'daily' ? (data?.map(d => d.netSub) ?? []) : monthly.map(m => m.netSub);
  const chartAum    = view === 'daily' ? (data?.map(d => d.aum) ?? []) : monthly.map(m => m.lastAum);

  const barColors = chartNetSub.map(v => v >= 0 ? '#C00000' : '#16a34a');

  const traces = [
    {
      type: 'bar',
      name: '淨申購/贖回',
      x: chartDates,
      y: chartNetSub,
      marker: { color: barColors },
      yaxis: 'y',
      hovertemplate: '<b>%{x}</b><br>淨申購: %{y:.2f} 億元<extra></extra>',
    },
    {
      type: 'scatter',
      mode: 'lines+markers',
      name: '基金規模',
      x: chartDates,
      y: chartAum,
      yaxis: 'y2',
      line: { color: '#1C1C1E', width: 2 },
      marker: { size: 4, color: '#1C1C1E' },
      hovertemplate: '<b>%{x}</b><br>規模: %{y:.2f} 億元<extra></extra>',
    },
  ];

  const layout = {
    paper_bgcolor: '#fff',
    plot_bgcolor: '#fff',
    margin: { l: 70, r: 75, t: 10, b: 80 },
    height: 320,
    legend: { orientation: 'h', x: 0, y: -0.28, font: { family: SANS, size: 11 } },
    xaxis: {
      type: 'category',
      tickangle: -45,
      tickfont: { family: MONO, size: 10 },
      gridcolor: BORDER,
      automargin: true,
      nticks: 12,
    },
    yaxis: {
      title: { text: '淨申購/贖回 (億)', font: { family: SANS, size: 11 } },
      tickfont: { family: MONO, size: 10 },
      gridcolor: BORDER,
      zeroline: true, zerolinecolor: '#aaa', zerolinewidth: 1,
    },
    yaxis2: {
      title: { text: '基金規模 (億)', font: { family: SANS, size: 11 } },
      tickfont: { family: MONO, size: 10 },
      overlaying: 'y',
      side: 'right',
      showgrid: false,
    },
    bargap: 0.25,
    hoverlabel: {
      bgcolor: '#fff',
      bordercolor: '#D0CBC6',
      font: { family: SANS, size: 12, color: TEXT },
      align: 'left',
    },
  };

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 12, flexWrap: 'wrap' }}>
        <div>
          <label style={{ display: 'block', fontSize: '.78rem', color: SUB, marginBottom: 4, fontWeight: 500 }}>開始日期</label>
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
            style={{ padding: '7px 12px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.87rem', color: TEXT, background: '#fff', fontFamily: MONO }} />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '.78rem', color: SUB, marginBottom: 4, fontWeight: 500 }}>結束日期</label>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
            style={{ padding: '7px 12px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.87rem', color: TEXT, background: '#fff', fontFamily: MONO }} />
        </div>
        <button onClick={load} disabled={loading}
          style={{ padding: '8px 22px', background: loading ? '#999' : RED, color: '#fff', border: 'none', borderRadius: 6,
            cursor: loading ? 'not-allowed' : 'pointer', fontSize: '.88rem', fontWeight: 600, fontFamily: SANS }}>
          {loading ? '載入中…' : '載入'}
        </button>
        {loading && (
          <span style={{ fontSize: '.8rem', color: SUB, alignSelf: 'center' }}>
            查詢資料中，需要約 10–30 秒…
          </span>
        )}
      </div>

      {/* Quick range buttons */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
        {[
          { label: '近30天',  days: 30  },
          { label: '近90天',  days: 90  },
          { label: '近180天', days: 180 },
          { label: '近365天', days: 365 },
        ].map(p => (
          <button key={p.days} onClick={() => setRange(p.days)}
            style={{ padding: '4px 12px', border: `1px solid ${BORDER}`, borderRadius: 20, background: '#fff',
              color: SUB, cursor: 'pointer', fontSize: '.78rem', fontFamily: SANS }}>
            {p.label}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ padding: '14px 16px', background: '#fff0f0', border: '1px solid #fca5a5', borderRadius: 8, color: RED, fontSize: '.85rem', marginBottom: 16 }}>
          載入失敗：{error}
        </div>
      )}

      {!data && !loading && (
        <p style={{ color: '#AAA', textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>
          請選擇日期區間並點擊「載入」
        </p>
      )}

      {data && data.length === 0 && (
        <div style={{ padding: '24px', textAlign: 'center', color: SUB, fontSize: '.85rem' }}>
          查無資料，請確認日期區間是否包含交易日
        </div>
      )}

      {data && data.length > 0 && (
        <>
          {/* Summary cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden', marginBottom: 20, background: '#FAFAF9' }}>
            {[
              { label: '最新基金規模',   value: latestAum   !== null ? fmtAum(latestAum)       : '—', color: TEXT  },
              { label: '期間淨申購合計', value: totalNetSub !== null ? fmtNetSub(totalNetSub)   : '—', color: totalNetSub !== null ? (totalNetSub >= 0 ? RED : GREEN) : TEXT },
              { label: '交易天數',       value: `${tradingDays} 天`,                                    color: TEXT  },
              { label: '每日平均淨申購', value: avgNetSub   !== null ? fmtNetSub(avgNetSub)     : '—', color: avgNetSub !== null ? (avgNetSub >= 0 ? RED : GREEN) : TEXT },
            ].map((c, i, arr) => (
              <div key={c.label} style={{ padding: '14px 16px', borderRight: i < arr.length - 1 ? `1px solid ${BORDER}` : 'none' }}>
                <div style={{ fontSize: '.72rem', color: SUB, fontWeight: 500, marginBottom: 4 }}>{c.label}</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 700, color: c.color, fontFamily: MONO, lineHeight: 1.2 }}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* View toggle + export */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center' }}>
            {(['daily', 'monthly'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                style={{
                  padding: '5px 16px', border: `1px solid ${view === v ? RED : BORDER}`, borderRadius: 20,
                  background: view === v ? RED : '#fff', color: view === v ? '#fff' : SUB,
                  cursor: 'pointer', fontSize: '.8rem', fontFamily: SANS, fontWeight: view === v ? 600 : 400,
                }}>
                {v === 'daily' ? '每日' : '每月'}
              </button>
            ))}
            <button
              onClick={() => view === 'daily'
                ? exportDailyExcel(sortedDaily, etfTicker, startDate, endDate)
                : exportMonthlyExcel(sortedMonthly, etfTicker, startDate, endDate)
              }
              style={{ marginLeft: 'auto', padding: '5px 14px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, cursor: 'pointer', fontSize: '.78rem', color: SUB, fontFamily: SANS, fontWeight: 500 }}
            >
              ↓ 匯出 Excel
            </button>
          </div>

          {/* Chart */}
          <PlotlyWrapper traces={traces} layout={layout} style={{ marginBottom: 20 }} />

          {/* Table */}
          <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '50vh', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
            {view === 'daily' ? (
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 480 }}>
                <thead>
                  <tr>
                    <th onClick={() => toggleDSort('date')}   style={{ ...TH, textAlign: 'left', position: 'sticky', left: 0, zIndex: 2 }}>{dLabel('date', '日期')}</th>
                    <th onClick={() => toggleDSort('netSub')} style={{ ...TH, textAlign: 'right' }}>{dLabel('netSub', '淨申購/贖回 (億)')}</th>
                    <th onClick={() => toggleDSort('aum')}    style={{ ...TH, textAlign: 'right' }}>{dLabel('aum', '基金規模 (億)')}</th>
                    <th onClick={() => toggleDSort('pnav')}   style={{ ...TH, textAlign: 'right' }}>{dLabel('pnav', '單位淨值')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedDaily.map((r, i) => {
                    const rowBg = i % 2 === 0 ? '#fff' : '#FAFAF9';
                    return (
                    <tr key={r.date} style={{ background: rowBg, borderBottom: `1px solid ${BORDER}` }}>
                      <td style={{ padding: '7px 14px', fontFamily: MONO, fontSize: '.8rem', color: TEXT, position: 'sticky', left: 0, zIndex: 1, background: rowBg }}>{r.date}</td>
                      <td style={{ padding: '7px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: r.netSub >= 0 ? RED : GREEN, fontWeight: 600 }}>
                        {fmtNetSub(r.netSub)}
                      </td>
                      <td style={{ padding: '7px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>
                        {fmtAum(r.aum)}
                      </td>
                      <td style={{ padding: '7px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>
                        {r.pnav.toFixed(4)}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 400 }}>
                <thead>
                  <tr>
                    <th onClick={() => toggleMSort('month')}   style={{ ...TH, textAlign: 'left', position: 'sticky', left: 0, zIndex: 2 }}>{mLabel('month', '月份')}</th>
                    <th onClick={() => toggleMSort('netSub')}  style={{ ...TH, textAlign: 'right' }}>{mLabel('netSub', '月淨申購/贖回 (億)')}</th>
                    <th onClick={() => toggleMSort('lastAum')} style={{ ...TH, textAlign: 'right' }}>{mLabel('lastAum', '月底基金規模 (億)')}</th>
                    <th onClick={() => toggleMSort('days')}    style={{ ...TH, textAlign: 'right' }}>{mLabel('days', '交易天數')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedMonthly.map((r, i) => {
                    const rowBg = i % 2 === 0 ? '#fff' : '#FAFAF9';
                    return (
                    <tr key={r.month} style={{ background: rowBg, borderBottom: `1px solid ${BORDER}` }}>
                      <td style={{ padding: '7px 14px', fontFamily: MONO, fontSize: '.8rem', color: TEXT, position: 'sticky', left: 0, zIndex: 1, background: rowBg }}>{r.month}</td>
                      <td style={{ padding: '7px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: r.netSub >= 0 ? RED : GREEN, fontWeight: 600 }}>
                        {fmtNetSub(r.netSub)}
                      </td>
                      <td style={{ padding: '7px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>
                        {fmtAum(r.lastAum)}
                      </td>
                      <td style={{ padding: '7px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>
                        {r.days}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Note */}
          <div style={{ marginTop: 12, fontSize: '.72rem', color: SUB, lineHeight: 1.8 }}>
            <b>淨申購/贖回</b>＝ actBuyVal × qDiff ÷ 500,000 ÷ 1億　（正值為淨申購，負值為淨贖回）<br />
            <b>資料來源：</b>復華投信 ETF PCF　（每個交易日收盤後更新，日期為實際申購/贖回日 actBuyValDate，實際金額以公告為準）
          </div>
        </>
      )}
    </div>
  );
}
