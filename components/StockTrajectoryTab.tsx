'use client';
import { useState, useCallback } from 'react';
import * as XLSX from 'xlsx';
import PlotlyWrapper from './PlotlyWrapper';

const CHART_ID = 'trajectory-chart';

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
  mid: number | null;
  close: number | null;
  dayBuyCost: number | null;
  avgCost: number | null;
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
  avgCost: number | null;
  currentPrice: number | null;
}

const TH: React.CSSProperties = {
  padding: '8px 14px', fontWeight: 600, fontSize: '.75rem',
  background: TEXT, color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1,
};

const DL_BTN: React.CSSProperties = {
  padding: '6px 14px', background: '#fff', border: `1px solid ${BORDER}`,
  borderRadius: 6, cursor: 'pointer', fontSize: '.8rem', color: SUB,
  fontFamily: SANS, fontWeight: 500, whiteSpace: 'nowrap',
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
function fmtPrice(n: number | null): string {
  return n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function round(n: number | null, d: number): number | string {
  return n == null ? '' : Number(n.toFixed(d));
}

// 匯出每日表格成 Excel（比照 PerformanceTab）
function exportExcel(data: TrajectoryResult, ticker: string) {
  const headers = ['日期', '持股(張)', '當日增減(張)', '中間價', '預估均價', '市值(NTD)', '佔比%'];
  const rows = data.series.map(p => [
    p.date,
    round(p.lots, 1),
    Math.abs(p.deltaLots) < 1e-4 ? '' : round(p.deltaLots, 1),
    round(p.mid, 2),
    round(p.avgCost, 2),
    p.mvalue,
    round(p.prate, 3),
  ]);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 9 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '持股軌跡');
  XLSX.writeFile(wb, `${ticker}_${data.stockid}_${data.stockname}_持股軌跡.xlsx`);
}

// 下載上下對照圖為 PNG
function downloadChart(data: TrajectoryResult, ticker: string) {
  const gd = document.getElementById(CHART_ID);
  if (!gd || !window.Plotly) return;
  const w = Math.max(900, Math.round(gd.getBoundingClientRect().width));
  window.Plotly.downloadImage(gd, {
    format: 'png', width: w, height: 560, scale: 2,
    filename: `${ticker}_${data.stockid}_${data.stockname}_軌跡圖`,
  });
}

interface Props {
  selectedEtf: { fundId: string; ticker: string; name: string };
}

export default function StockTrajectoryTab({ selectedEtf }: Props) {
  const [query,   setQuery]   = useState('');
  const [data,    setData]    = useState<TrajectoryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  // 此分頁可獨立選基金：沿用全域所選復華 ETF，或改查統一 00981A（資料源 = CMoney/pocket）。
  const [fundOverride, setFundOverride] = useState<'' | '00981A'>('');
  const fund = fundOverride === '00981A'
    ? { fundId: '00981A', ticker: '00981A', name: '主動統一台股增長' }
    : selectedEtf;
  const isCmoney = fund.fundId === '00981A';

  const search = useCallback(async () => {
    if (!query.trim()) { setError('請輸入股票代碼或名稱'); return; }
    setLoading(true); setError(''); setData(null);
    try {
      const url = `/api/stock-trajectory?fundId=${encodeURIComponent(fund.fundId)}&q=${encodeURIComponent(query.trim())}`;
      const res  = await fetch(url);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json as TrajectoryResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : '查詢失敗');
    } finally {
      setLoading(false);
    }
  }, [query, fund.fundId]);

  // 圖表資料（升冪）
  const dates   = data?.series.map(p => p.date) ?? [];
  const lots    = data?.series.map(p => p.lots) ?? [];
  const prates  = data?.series.map(p => p.prate) ?? [];
  const closes  = data?.series.map(p => p.close) ?? [];
  const avgs    = data?.series.map(p => p.avgCost) ?? [];

  // 單一圖、上下兩個子圖共用同一條 X 軸；上=張數+佔比，下=股價+均價
  const traces = [
    {
      type: 'bar', name: '持股張數', x: dates, y: lots,
      marker: { color: '#C00000' }, yaxis: 'y',
      hovertemplate: '%{y:,.0f} 張<extra>持股張數</extra>',
    },
    {
      type: 'scatter', mode: 'lines', name: '佔比 %', x: dates, y: prates,
      yaxis: 'y2', line: { color: '#B08F6E', width: 2 },
      hovertemplate: '%{y:.3f}%<extra>佔比</extra>',
    },
    {
      type: 'scatter', mode: 'lines', name: '股價(收盤)', x: dates, y: closes,
      yaxis: 'y3', line: { color: '#1C1C1E', width: 2 },
      hovertemplate: '%{y:.2f} 元<extra>股價(收盤)</extra>',
    },
    {
      type: 'scatter', mode: 'lines', name: '持倉均價', x: dates, y: avgs,
      yaxis: 'y3', line: { color: '#2563eb', width: 2, dash: 'dot' },
      hovertemplate: '%{y:.2f} 元<extra>持倉均價</extra>',
    },
  ];

  const axisFont = { family: MONO, size: 10 };
  const titleFont = { family: SANS, size: 11 };
  const layout = {
    paper_bgcolor: '#fff',
    plot_bgcolor: '#fff',
    margin: { l: 70, r: 70, t: 10, b: 80 },
    height: 560,
    hovermode: 'x unified',
    legend: { orientation: 'h', x: 0, y: -0.14, font: { family: SANS, size: 11 } },
    xaxis: {
      type: 'category', tickangle: -45, tickfont: axisFont,
      gridcolor: BORDER, automargin: true, nticks: 14, anchor: 'y3',
      showspikes: true, spikemode: 'across', spikethickness: 1, spikecolor: '#999', spikedash: 'dot', spikesnap: 'cursor',
    },
    // 上半 (0.56–1.0)：張數 + 佔比
    yaxis: {
      domain: [0.56, 1.0], title: { text: '持股張數', font: titleFont },
      tickfont: axisFont, gridcolor: BORDER, rangemode: 'tozero',
    },
    yaxis2: {
      title: { text: '佔比 (%)', font: titleFont }, tickfont: axisFont,
      overlaying: 'y', side: 'right', showgrid: false, rangemode: 'tozero',
    },
    // 下半 (0–0.44)：股價 + 均價（同一元軸，可直接比較）
    yaxis3: {
      domain: [0, 0.44], anchor: 'x', title: { text: '股價 / 均價 (元)', font: titleFont },
      tickfont: axisFont, gridcolor: BORDER,
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
            ETF
          </label>
          <select
            value={fundOverride}
            onChange={e => { setFundOverride(e.target.value as '' | '00981A'); setData(null); setError(''); }}
            style={{ padding: '7px 12px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.87rem', color: TEXT, background: '#fff', fontFamily: SANS }}>
            <option value="">{selectedEtf.ticker}（復華）</option>
            <option value="00981A">00981A 統一台股增長</option>
          </select>
        </div>
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
            逐日查詢 {fund.ticker} 持股，可能需 15–30 秒…
          </span>
        )}
      </div>
      <p style={{ fontSize: '.74rem', color: SUB, margin: '0 0 16px' }}>
        查詢 <strong style={{ color: TEXT }}>{fund.ticker}</strong> 自成立以來，對該個股每日的持有張數、佔比與加碼/減碼軌跡。
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
          {fund.ticker} 期間內未持有「{query.trim()}」，或查無此股票。
        </div>
      )}

      {data && !data.notHeld && data.latest && (
        <>
          {/* 標題列 + 下載按鈕 */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: '.9rem', color: SUB, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>
                <strong style={{ color: TEXT, fontFamily: MONO, fontSize: '1.05rem' }}>{data.stockid}</strong>
                {' '}<strong style={{ color: TEXT }}>{data.stockname}</strong>
              </span>
              <span style={{ color: BORDER }}>|</span>
              <span>掃描 <strong style={{ color: TEXT }}>{data.scannedDays}</strong> 個交易日</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => downloadChart(data, fund.ticker)} style={DL_BTN}>↓ 下載圖表 PNG</button>
              <button onClick={() => exportExcel(data, fund.ticker)} style={DL_BTN}>↓ 匯出 Excel</button>
            </div>
          </div>

          {/* 統計卡 */}
          {(() => {
            const pl = (data.avgCost && data.currentPrice) ? (data.currentPrice - data.avgCost) / data.avgCost * 100 : null;
            const cards = [
              { label: '首次買入日', value: data.firstHeldDate ?? '—', sub: '精確到交易日', color: RED },
              { label: '目前持股',   value: `${fmtLots(data.latest.lots)} 張`, sub: data.latest.date, color: data.latest.lots > 0 ? TEXT : SUB },
              { label: '預估持倉均價', value: `${fmtPrice(data.avgCost)}`, sub: pl != null ? `現價 ${fmtPrice(data.currentPrice)}　${pl >= 0 ? '+' : ''}${pl.toFixed(1)}%` : '元/股', color: TEXT },
              { label: '目前佔比',   value: `${data.latest.prate.toFixed(3)}%`, sub: '佔基金淨值', color: TEXT },
              { label: '期間最高持股', value: `${fmtLots(data.maxLots)} 張`, sub: '建倉高峰', color: TEXT },
            ];
            return (
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cards.length},1fr)`, border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden', marginBottom: 20, background: '#FAFAF9' }}>
                {cards.map((c, i, arr) => (
                  <div key={c.label} style={{ padding: '14px 16px', borderRight: i < arr.length - 1 ? `1px solid ${BORDER}` : 'none' }}>
                    <div style={{ fontSize: '.72rem', color: SUB, fontWeight: 500, marginBottom: 4 }}>{c.label}</div>
                    <div style={{ fontSize: '1.2rem', fontWeight: 700, color: c.color, fontFamily: MONO, lineHeight: 1.2 }}>{c.value}</div>
                    <div style={{ fontSize: '.72rem', color: c.label === '預估持倉均價' && pl != null ? (pl >= 0 ? RED : GREEN) : SUB, marginTop: 4, fontFamily: MONO }}>{c.sub}</div>
                  </div>
                ))}
              </div>
            );
          })()}

          {/* 圖表：上=張數+佔比，下=股價+均價，共用 X 軸並同步游標（四個數值同時顯示）
              trace 順序：0 張數(xy)、1 佔比(xy2)、2 股價(xy3)、3 均價(xy3） */}
          <PlotlyWrapper traces={traces} layout={layout} hoverSync={['xy', 'xy2', 'xy3', 'xy3']} id={CHART_ID} style={{ marginBottom: 20 }} />

          {/* 每日表格 */}
          <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '50vh', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead>
                <tr>
                  <th style={{ ...TH, textAlign: 'left' }}>日期</th>
                  <th style={{ ...TH, textAlign: 'right' }}>持股 (張)</th>
                  <th style={{ ...TH, textAlign: 'right' }}>當日增減 (張)</th>
                  <th style={{ ...TH, textAlign: 'right' }}>中間價</th>
                  <th style={{ ...TH, textAlign: 'right' }}>預估均價</th>
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
                    <td style={{ padding: '7px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>{fmtPrice(p.mid)}</td>
                    <td style={{ padding: '7px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: TEXT, fontWeight: 500 }}>{fmtPrice(p.avgCost)}</td>
                    <td style={{ padding: '7px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>{fmtMvalue(p.mvalue)}</td>
                    <td style={{ padding: '7px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>{p.prate.toFixed(3)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 12, fontSize: '.72rem', color: SUB, lineHeight: 1.8 }}>
            <b>持股 (張)</b>＝{isCmoney ? '統一' : '復華'}公告股數 ÷ 1000　<b>當日增減</b>＝較前一交易日張數變化（紅色加碼、綠色減碼）<br />
            <b>中間價</b>＝當日 (最高價＋最低價) ÷ 2（Yahoo Finance）　<b>預估均價</b>＝以加碼日中間價估算的移動平均持倉成本（元/股）<br />
            <b>說明：</b>均價為<u>推估值</u>——以每日中間價近似實際成交價，且減碼採移動平均成本法（賣出不影響均價）。<br />
            <b>資料來源：</b>{isCmoney ? 'CMoney／口袋證券（保留逐日歷史持股）' : '復華投信 ETF 每日持股'} ＋ Yahoo Finance 日 K{isCmoney ? '；市值＝股數×當日收盤估算' : ''}
          </div>
        </>
      )}
    </div>
  );
}
