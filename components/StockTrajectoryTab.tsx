'use client';
import { useState, useCallback } from 'react';
import PlotlyWrapper from './PlotlyWrapper';

const RED    = '#C00000';
const GREEN  = '#16a34a';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

interface TrajectoryPoint {
  date: string;
  lots: number;
  qshare: number;
  mvalue: number;
  prate: number;
  deltaLots: number;
}
interface TrajectoryResult {
  stockid: string;
  stockname: string;
  fundId: string;
  series: TrajectoryPoint[];
  firstHeldDate: string | null;
  latest: TrajectoryPoint | null;
  maxLots: number;
  notHeld: boolean;
  scannedDays: number;
}

const TH: React.CSSProperties = {
  padding: '8px 14px', fontWeight: 600, fontSize: '.75rem',
  background: TEXT, color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1,
};

function fmtLots(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
}
function fmtMvalue(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function fmtDelta(n: number): string {
  if (Math.abs(n) < 0.0001) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toLocaleString('en-US', { maximumFractionDigits: 1 })}`;
}

interface Props {
  selectedEtf: { fundId: string; ticker: string; name: string };
}

export default function StockTrajectoryTab({ selectedEtf }: Props) {
  const [query,   setQuery]   = useState('');
  const [data,    setData]    = useState<TrajectoryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  const search = useCallback(async () => {
    if (!query.trim()) { setError('請輸入股票代碼或名稱'); return; }
    setLoading(true); setError(''); setData(null);
    try {
      const url = `/api/stock-trajectory?fundId=${encodeURIComponent(selectedEtf.fundId)}&q=${encodeURIComponent(query.trim())}`;
      const res  = await fetch(url);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json as TrajectoryResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : '查詢失敗');
    } finally {
      setLoading(false);
    }
  }, [query, selectedEtf.fundId]);

  // 圖表資料（升冪）
  const dates   = data?.series.map(p => p.date) ?? [];
  const lots    = data?.series.map(p => p.lots) ?? [];
  const prates  = data?.series.map(p => p.prate) ?? [];

  const traces = [
    {
      type: 'bar',
      name: '持股張數',
      x: dates,
      y: lots,
      marker: { color: '#C00000' },
      yaxis: 'y',
      hovertemplate: '<b>%{x}</b><br>持股: %{y:,.0f} 張<extra></extra>',
    },
    {
      type: 'scatter',
      mode: 'lines+markers',
      name: '佔比 %',
      x: dates,
      y: prates,
      yaxis: 'y2',
      line: { color: '#1C1C1E', width: 2 },
      marker: { size: 4, color: '#1C1C1E' },
      hovertemplate: '<b>%{x}</b><br>佔比: %{y:.3f}%<extra></extra>',
    },
  ];

  const layout = {
    paper_bgcolor: '#fff',
    plot_bgcolor: '#fff',
    margin: { l: 70, r: 70, t: 10, b: 80 },
    height: 340,
    legend: { orientation: 'h', x: 0, y: -0.28, font: { family: SANS, size: 11 } },
    xaxis: {
      type: 'category', tickangle: -45,
      tickfont: { family: MONO, size: 10 },
      gridcolor: BORDER, automargin: true, nticks: 14,
    },
    yaxis: {
      title: { text: '持股張數', font: { family: SANS, size: 11 } },
      tickfont: { family: MONO, size: 10 },
      gridcolor: BORDER, rangemode: 'tozero',
    },
    yaxis2: {
      title: { text: '佔比 (%)', font: { family: SANS, size: 11 } },
      tickfont: { family: MONO, size: 10 },
      overlaying: 'y', side: 'right', showgrid: false, rangemode: 'tozero',
    },
    bargap: 0.25,
    hoverlabel: { bgcolor: '#fff', bordercolor: '#D0CBC6', font: { family: SANS, size: 12, color: TEXT }, align: 'left' },
  };

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>

      {/* 查詢列 */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 8, flexWrap: 'wrap' }}>
        <div>
          <label style={{ display: 'block', fontSize: '.78rem', color: SUB, marginBottom: 4, fontWeight: 500 }}>
            股票代碼或名稱
          </label>
          <input
            type="text" value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') search(); }}
            placeholder="例：國巨 或 2327"
            style={{ padding: '7px 12px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.87rem', color: TEXT, background: '#fff', fontFamily: SANS, width: 200 }}
          />
        </div>
        <button onClick={search} disabled={loading}
          style={{ padding: '8px 22px', background: loading ? '#999' : RED, color: '#fff', border: 'none', borderRadius: 6,
            cursor: loading ? 'not-allowed' : 'pointer', fontSize: '.88rem', fontWeight: 600, fontFamily: SANS }}>
          {loading ? '查詢中…' : '查詢'}
        </button>
        {loading && (
          <span style={{ fontSize: '.8rem', color: SUB, alignSelf: 'center' }}>
            逐日查詢 {selectedEtf.ticker} 持股，可能需 15–30 秒…
          </span>
        )}
      </div>
      <p style={{ fontSize: '.74rem', color: SUB, margin: '0 0 16px' }}>
        查詢 <strong style={{ color: TEXT }}>{selectedEtf.ticker}</strong> 自成立以來，對該個股每日的持有張數、佔比與加碼/減碼軌跡。
      </p>

      {error && (
        <div style={{ padding: '14px 16px', background: '#fff0f0', border: '1px solid #fca5a5', borderRadius: 8, color: RED, fontSize: '.85rem', marginBottom: 16 }}>
          {error}
        </div>
      )}

      {!data && !loading && !error && (
        <p style={{ color: '#AAA', textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>
          輸入股票代碼或中文名稱，點擊「查詢」
        </p>
      )}

      {data && data.notHeld && (
        <div style={{ padding: '24px', textAlign: 'center', color: SUB, fontSize: '.88rem' }}>
          {selectedEtf.ticker} 期間內未持有「{query.trim()}」，或查無此股票。
        </div>
      )}

      {data && !data.notHeld && data.latest && (
        <>
          {/* 標題列 */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: '.9rem', color: SUB, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>
              <strong style={{ color: TEXT, fontFamily: MONO, fontSize: '1.05rem' }}>{data.stockid}</strong>
              {' '}<strong style={{ color: TEXT }}>{data.stockname}</strong>
            </span>
            <span style={{ color: BORDER }}>|</span>
            <span>掃描 <strong style={{ color: TEXT }}>{data.scannedDays}</strong> 個交易日</span>
          </div>

          {/* 統計卡 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden', marginBottom: 20, background: '#FAFAF9' }}>
            {[
              { label: '首次買入日', value: data.firstHeldDate ?? '—', sub: '精確到交易日', color: RED, mono: true },
              { label: '目前持股',   value: `${fmtLots(data.latest.lots)} 張`, sub: data.latest.date, color: data.latest.lots > 0 ? TEXT : SUB },
              { label: '目前佔比',   value: `${data.latest.prate.toFixed(3)}%`, sub: '佔基金淨值', color: TEXT },
              { label: '期間最高持股', value: `${fmtLots(data.maxLots)} 張`, sub: '建倉高峰', color: TEXT },
            ].map((c, i, arr) => (
              <div key={c.label} style={{ padding: '14px 16px', borderRight: i < arr.length - 1 ? `1px solid ${BORDER}` : 'none' }}>
                <div style={{ fontSize: '.72rem', color: SUB, fontWeight: 500, marginBottom: 4 }}>{c.label}</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 700, color: c.color, fontFamily: c.mono ? MONO : MONO, lineHeight: 1.2 }}>{c.value}</div>
                <div style={{ fontSize: '.72rem', color: SUB, marginTop: 4 }}>{c.sub}</div>
              </div>
            ))}
          </div>

          {/* 圖表 */}
          <PlotlyWrapper traces={traces} layout={layout} style={{ marginBottom: 20 }} />

          {/* 每日表格 */}
          <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '50vh', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
              <thead>
                <tr>
                  <th style={{ ...TH, textAlign: 'left' }}>日期</th>
                  <th style={{ ...TH, textAlign: 'right' }}>持股 (張)</th>
                  <th style={{ ...TH, textAlign: 'right' }}>當日增減 (張)</th>
                  <th style={{ ...TH, textAlign: 'right' }}>市值 (NTD)</th>
                  <th style={{ ...TH, textAlign: 'right' }}>佔比 %</th>
                </tr>
              </thead>
              <tbody>
                {[...data.series].reverse().map((p, i) => (
                  <tr key={p.date} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAF9', borderBottom: `1px solid ${BORDER}` }}>
                    <td style={{ padding: '7px 14px', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>{p.date}</td>
                    <td style={{ padding: '7px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: p.lots > 0 ? TEXT : SUB }}>{fmtLots(p.lots)}</td>
                    <td style={{ padding: '7px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', fontWeight: 600,
                      color: p.deltaLots > 0.0001 ? RED : p.deltaLots < -0.0001 ? GREEN : SUB }}>
                      {fmtDelta(p.deltaLots)}
                    </td>
                    <td style={{ padding: '7px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>{fmtMvalue(p.mvalue)}</td>
                    <td style={{ padding: '7px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>{p.prate.toFixed(3)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 12, fontSize: '.72rem', color: SUB, lineHeight: 1.8 }}>
            <b>持股 (張)</b>＝復華公告股數 ÷ 1000　<b>當日增減</b>＝較前一交易日張數變化（紅色加碼、綠色減碼）<br />
            <b>資料來源：</b>復華投信 ETF 每日持股（即時逐日查詢，僅含有交易資料的日期）
          </div>
        </>
      )}
    </div>
  );
}
