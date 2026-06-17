'use client';
import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { PEER_GROUPS } from '@/lib/peerGroups';
import PlotlyWrapper from './PlotlyWrapper';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global { interface Window { Plotly: any } }

const TEXT = '#1C1C1E';
const SUB  = '#6B6460';
const BORDER = '#EEE9E4';
const RED  = '#C00000';
const MONO = "'IBM Plex Mono', 'Courier New', monospace";
const SANS = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

const GROUPS = [
  { id: 'active', label: '台股主動式ETF' },
  { id: 'tw50',   label: '台股50' },
];

// 預設線條配色（高辨識度）
const PALETTE = [
  '#C00000', '#1A6B45', '#2563eb', '#B08F6E', '#9333ea', '#dc2626',
  '#0891b2', '#ca8a04', '#db2777', '#15803d', '#7c3aed', '#ea580c',
  '#0f766e', '#a16207', '#be123c', '#4338ca', '#65a30d', '#0369a1',
];

const CHART_ID = 'cumret-chart';
const CANVAS_W = 1120, CANVAS_H = 560;

interface CumRetSeries { ticker: string; name: string; pct: (number | null)[] }
interface CumRetResult { start: string; end: string; dates: string[]; series: CumRetSeries[] }

function todayTW(): string {
  const tw = new Date(Date.now() + 8 * 3600 * 1000);
  return `${tw.getUTCFullYear()}-${String(tw.getUTCMonth() + 1).padStart(2, '0')}-${String(tw.getUTCDate()).padStart(2, '0')}`;
}
function yearStart(): string {
  return `${new Date(Date.now() + 8 * 3600 * 1000).getUTCFullYear()}-01-01`;
}
function mmdd(d: string): string { const [, m, dd] = d.split('-'); return `${m}/${dd}`; }
function fmtPct(v: number): string { return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`; }

export default function CumulativeReturnTab() {
  const [group,    setGroup]    = useState('active');
  const [selected, setSelected] = useState<string[]>([]);
  const [colors,   setColors]   = useState<Record<string, string>>({});
  const [start,    setStart]    = useState(yearStart());
  const [end,      setEnd]      = useState(todayTW());
  const [data,     setData]     = useState<CumRetResult | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const [animSec,  setAnimSec]  = useState(8);
  const [playing,  setPlaying]  = useState(false);
  const [recording, setRecording] = useState(false);
  const [dark,     setDark]     = useState(false);
  const [vidFmt,   setVidFmt]   = useState<'mp4' | 'webm'>('mp4');

  const items = PEER_GROUPS[group].items;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef    = useRef<number | null>(null);
  const darkRef   = useRef(false);
  // 動畫繪製用的即時資料（避免 React 重繪延遲影響錄影）
  const viewRef   = useRef<{ dates: string[]; lines: { name: string; pct: (number | null)[]; color: string }[]; yMin: number; yMax: number } | null>(null);

  // 切換群組：清空選取與結果
  const switchGroup = (id: string) => {
    setGroup(id); setSelected([]); setData(null); setError('');
  };

  const assignColor = (ticker: string, prev: Record<string, string>): string => {
    if (prev[ticker]) return prev[ticker];
    const used = new Set(Object.values(prev));
    return PALETTE.find(c => !used.has(c)) ?? PALETTE[Object.keys(prev).length % PALETTE.length];
  };

  const toggle = (ticker: string) => {
    setSelected(prev => prev.includes(ticker) ? prev.filter(t => t !== ticker) : [...prev, ticker]);
    setColors(prev => prev[ticker] ? prev : { ...prev, [ticker]: assignColor(ticker, prev) });
  };
  const selectAll = () => {
    setSelected(items.map(i => i.ticker));
    setColors(prev => { const next = { ...prev }; for (const it of items) if (!next[it.ticker]) next[it.ticker] = assignColor(it.ticker, next); return next; });
  };
  const clearSel = () => setSelected([]);

  const load = useCallback(async () => {
    if (!selected.length) { setError('請至少勾選一檔商品'); return; }
    if (start > end) { setError('起始日不可晚於結束日'); return; }
    setLoading(true); setError(''); setData(null); stopAnim();
    try {
      const url = `/api/cumulative-return?group=${group}&tickers=${encodeURIComponent(selected.join(','))}&startDate=${start}&endDate=${end}`;
      const r = await fetch(url);
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
      setData(json as CumRetResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      setLoading(false);
    }
  }, [selected, start, end, group]);

  // ── Plotly 互動圖 ──
  const traces = useMemo(() => {
    if (!data) return [];
    return data.series.map(s => ({
      type: 'scatter', mode: 'lines', name: `${s.ticker} ${s.name}`,
      x: data.dates, y: s.pct, connectgaps: true,
      line: { color: colors[s.ticker] ?? '#999', width: 2.2 },
      hovertemplate: `%{x}<br>${s.name}：%{y:.2f}%<extra></extra>`,
    }));
  }, [data, colors]);

  const HEIGHT = 480, MT = 16, MB = 40;   // Plotly 圖高與上下邊距（供像素換算）
  const layout = useMemo(() => {
    // 固定 y 軸範圍，才能精準把資料座標換算成像素，做「像素級」避讓確保標註不重疊
    const allY: number[] = [];
    for (const s of data?.series ?? []) for (const v of s.pct) if (v != null) allY.push(v);
    const lo = Math.min(0, ...(allY.length ? allY : [0]));
    const hi = Math.max(0, ...(allY.length ? allY : [0]));
    const pad = (hi - lo) * 0.08 || 1;
    const yMin = lo - pad, yMax = hi + pad;

    // 各線最新值
    const ends = (data?.series ?? []).map(s => {
      let idx = -1;
      for (let i = s.pct.length - 1; i >= 0; i--) if (s.pct[i] != null) { idx = i; break; }
      return idx < 0 ? null : { ticker: s.ticker, x: data!.dates[idx], y: s.pct[idx] as number, color: colors[s.ticker] ?? '#333' };
    }).filter(Boolean) as { ticker: string; x: string; y: number; color: string }[];

    // 像素空間避讓：以固定 y 範圍換算像素，確保每個標註至少間隔 minGapPx
    const plotH = HEIGHT - MT - MB;
    const pxOf = (v: number) => MT + (1 - (v - yMin) / (yMax - yMin)) * plotH;
    const vOf  = (py: number) => yMin + (1 - (py - MT) / plotH) * (yMax - yMin);
    const minGapPx = 15;
    const sorted = ends.map(e => ({ e, py: pxOf(e.y) })).sort((a, b) => a.py - b.py); // 由上而下（像素小→大）
    let prevPy = -Infinity;
    const ayMap = new Map<string, number>();
    for (const { e, py } of sorted) {
      const ny = Math.min(Math.max(py, prevPy + minGapPx), MT + plotH - 4);
      prevPy = ny; ayMap.set(e.ticker, vOf(ny));
    }
    const annotations = ends.map(e => ({
      x: e.x, y: ayMap.get(e.ticker) ?? e.y, xref: 'x', yref: 'y',
      text: `${e.ticker} ${e.y >= 0 ? '+' : ''}${e.y.toFixed(1)}%`,
      showarrow: false, xanchor: 'left', yanchor: 'middle', xshift: 8,
      font: { size: 11, color: e.color, family: MONO },
      bgcolor: 'rgba(255,255,255,0.7)', borderpad: 1,
    }));

    return {
      margin: { l: 56, r: 128, t: MT, b: MB },
      height: HEIGHT,
      xaxis: { showgrid: false, tickfont: { size: 11, family: MONO } },
      yaxis: { title: { text: '累積報酬 %', font: { size: 12, family: SANS } }, ticksuffix: '%', range: [yMin, yMax], zeroline: true, zerolinecolor: '#999', zerolinewidth: 1.5, gridcolor: '#F0EDE8', tickfont: { size: 11, family: MONO } },
      legend: { orientation: 'h', y: -0.16, font: { size: 11, family: SANS } },
      hovermode: 'x unified',
      shapes: [{ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: 0, y1: 0, line: { color: '#999', width: 1 } }],
      annotations,
    };
  }, [data, colors]);

  const downloadPng = () => {
    const gd = document.getElementById(CHART_ID);
    if (!gd || !window.Plotly) return;
    const w = Math.max(1000, Math.round(gd.getBoundingClientRect().width));
    window.Plotly.downloadImage(gd, { format: 'png', width: w, height: 540, scale: 2, filename: `累積報酬走勢_${start}_${end}` });
  };

  // ── Canvas 動畫 ──
  const buildView = useCallback(() => {
    if (!data || !data.dates.length) { viewRef.current = null; return; }
    const lines = data.series.map(s => ({ name: `${s.ticker} ${s.name}`, pct: s.pct, color: colors[s.ticker] ?? '#999' }));
    let lo = 0, hi = 0;
    for (const l of lines) for (const v of l.pct) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const pad = (hi - lo) * 0.08 || 1;
    viewRef.current = { dates: data.dates, lines, yMin: lo - pad, yMax: hi + pad };
  }, [data, colors]);

  const drawFrame = useCallback((frame: number) => {
    const cv = canvasRef.current, view = viewRef.current;
    if (!cv || !view) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const { dates, lines, yMin, yMax } = view;
    const N = dates.length;
    // 深色 / 淺色主題
    const d = darkRef.current;
    const C = d
      ? { bg: '#0e1116', grid: '#262c36', zero: '#5b6472', text: '#e6edf3', sub: '#9aa4b2', title: '#f0f6fc' }
      : { bg: '#ffffff', grid: '#F0EDE8', zero: '#999999', text: TEXT, sub: SUB, title: TEXT };

    const L = 70, R = 96, T = 52;   // 右側只放「報酬%」數值，R 不需太大
    // 先算底部色彩圖例佈局（標示哪個顏色是哪個商品），決定底部高度
    const swatch = 13, sgap = 6, itemGap = 22;
    const legendMaxW = CANVAS_W - L - 12;
    ctx.font = `12px ${SANS}`;
    let lx = 0, row = 0;
    const placed = lines.map(ln => {
      const w = swatch + sgap + ctx.measureText(ln.name).width + itemGap;
      if (lx > 0 && lx + w > legendMaxW) { row++; lx = 0; }
      const p = { label: ln.name, color: ln.color, row, x: L + lx };
      lx += w; return p;
    });
    const legendRows = row + 1;
    const xLabelH = 18, legendH = legendRows * 20 + 6;
    const B = xLabelH + legendH + 10;
    const pw = CANVAS_W - L - R, ph = CANVAS_H - T - B;
    const xOf = (i: number) => L + (N <= 1 ? 0 : (i / (N - 1)) * pw);
    const yOf = (v: number) => T + (1 - (v - yMin) / (yMax - yMin)) * ph;

    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // y 格線 + 標籤
    ctx.textBaseline = 'middle'; ctx.font = `12px ${MONO}`;
    const ticks = 6;
    for (let k = 0; k <= ticks; k++) {
      const v = yMin + (yMax - yMin) * (k / ticks);
      const y = yOf(v);
      const zero = Math.abs(v) < 1e-9;
      ctx.strokeStyle = zero ? C.zero : C.grid; ctx.lineWidth = zero ? 1.5 : 1;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
      ctx.fillStyle = C.sub; ctx.textAlign = 'right';
      ctx.fillText(`${v >= 0 ? '+' : ''}${v.toFixed(0)}%`, L - 8, y);
    }
    // x 日期標籤
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = C.sub;
    const xticks = Math.min(7, N);
    for (let k = 0; k < xticks; k++) {
      const i = Math.round((k / (xticks - 1 || 1)) * (N - 1));
      ctx.fillText(mmdd(dates[i]), xOf(i), T + ph + 6);
    }

    // 標題 + 目前日期
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.title; ctx.font = `bold 17px ${SANS}`;
    ctx.fillText('累積報酬走勢（還原含息）', L, 28);
    ctx.fillStyle = C.sub; ctx.font = `13px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.fillText(`${dates[0]} → ${dates[Math.min(frame, N - 1)]}`, L + pw, 28);

    // 各商品線
    const f = Math.min(frame, N - 1);
    const endLabels: { x: number; y: number; pct: string; color: string }[] = [];
    for (const ln of lines) {
      ctx.strokeStyle = ln.color; ctx.lineWidth = 2.4; ctx.lineJoin = 'round';
      ctx.beginPath();
      let started = false, lastI = -1;
      for (let i = 0; i <= f; i++) {
        const v = ln.pct[i];
        if (v == null) continue;
        const x = xOf(i), y = yOf(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        lastI = i;
      }
      if (started) ctx.stroke();
      if (lastI >= 0) {
        const v = ln.pct[lastI]!; const x = xOf(lastI), y = yOf(v);
        ctx.fillStyle = ln.color; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
        endLabels.push({ x, y, pct: fmtPct(v), color: ln.color });
      }
    }
    // 「報酬%」跟著各線當前的點移動（畫在點的右側）；同一點上多條線數值接近時做 y 避讓避免重疊
    ctx.font = `bold 13px ${MONO}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const minGap = 16;
    const drawn: { x: number; y: number }[] = [];
    for (const lab of endLabels.slice().sort((a, b) => a.y - b.y)) {
      let y = lab.y;
      // 與已畫且 x 相近的標籤比對，往下推開避免重疊
      for (const p of drawn) if (Math.abs(p.x - (lab.x + 8)) < 56 && y < p.y + minGap) y = p.y + minGap;
      y = Math.min(y, T + ph);
      const lx = Math.min(lab.x + 8, CANVAS_W - 64);   // 靠右時不超出畫布
      ctx.fillStyle = lab.color;
      ctx.fillText(lab.pct, lx, y);
      drawn.push({ x: lx, y });
    }

    // 底部色彩圖例：標記哪個顏色是哪個商品
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = `12px ${SANS}`;
    const legendY0 = T + ph + xLabelH + 12;
    for (const p of placed) {
      const cy = legendY0 + p.row * 20;
      ctx.fillStyle = p.color; ctx.fillRect(p.x, cy - swatch / 2, swatch, swatch);
      ctx.fillStyle = C.text; ctx.fillText(p.label, p.x + swatch + sgap, cy);
    }
  }, []);

  const stopAnim = () => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  };

  const runAnim = useCallback((durationMs: number, onDone?: () => void) => {
    const view = viewRef.current; if (!view) return;
    const N = view.dates.length;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / durationMs);
      drawFrame(Math.round(p * (N - 1)));
      if (p < 1) { rafRef.current = requestAnimationFrame(step); }
      else { rafRef.current = null; onDone?.(); }
    };
    rafRef.current = requestAnimationFrame(step);
  }, [drawFrame]);

  // 資料/配色變動 → 重建並畫出完整靜態圖
  useEffect(() => { buildView(); drawFrame(Number.MAX_SAFE_INTEGER); }, [buildView, drawFrame]);
  // 深色切換 → 重畫
  useEffect(() => { darkRef.current = dark; drawFrame(Number.MAX_SAFE_INTEGER); }, [dark, drawFrame]);
  useEffect(() => () => stopAnim(), []);

  const play = () => {
    if (!viewRef.current) return;
    stopAnim(); setPlaying(true);
    runAnim(animSec * 1000, () => setPlaying(false));
  };

  const recordVideo = () => {
    const cv = canvasRef.current; if (!cv || !viewRef.current) return;
    if (typeof cv.captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
      setError('此瀏覽器不支援影片錄製（請用較新版 Chrome / Edge）'); return;
    }
    setError('');
    const MP4  = ['video/mp4;codecs=avc1.4d002a', 'video/mp4;codecs=avc1', 'video/mp4'];
    const WEBM = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    let mime = '', ext: 'mp4' | 'webm' = 'webm';
    if (vidFmt === 'mp4') {
      mime = MP4.find(m => MediaRecorder.isTypeSupported(m)) ?? '';
      if (mime) ext = 'mp4';
    }
    if (!mime) {
      mime = WEBM.find(m => MediaRecorder.isTypeSupported(m)) ?? '';
      ext = 'webm';
      if (vidFmt === 'mp4') setError('此瀏覽器無法直接錄 MP4，已改錄 WebM（可用轉檔工具轉成 MP4 再上傳社群）');
    }
    if (!mime) { setError('此瀏覽器不支援影片錄製'); return; }

    const stream = cv.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    const chunks: BlobPart[] = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: mime.split(';')[0] });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `累積報酬動畫_${start}_${end}.${ext}`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setRecording(false);
    };
    setRecording(true); stopAnim();
    rec.start();
    // 從 0 跑到底，結尾停留 3 秒再收尾（總長 = 動畫秒數 + 3）
    runAnim(animSec * 1000, () => {
      // 靜止畫面 captureStream 不會自動產生新影格 → 這 3 秒持續重畫，強制影格被錄進去
      const holdStart = performance.now();
      const hold = (now: number) => {
        drawFrame(Number.MAX_SAFE_INTEGER);
        if (now - holdStart < 3000) { rafRef.current = requestAnimationFrame(hold); }
        else { rafRef.current = null; rec.stop(); }
      };
      rafRef.current = requestAnimationFrame(hold);
    });
  };

  const hasResult = !!data && data.series.length > 0;

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>
      {/* 群組 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {GROUPS.map(g => (
          <button key={g.id} onClick={() => switchGroup(g.id)}
            style={{ padding: '6px 18px', borderRadius: 20, border: `1.5px solid ${group === g.id ? RED : BORDER}`,
              background: group === g.id ? RED : '#fff', color: group === g.id ? '#fff' : SUB,
              cursor: 'pointer', fontSize: '.85rem', fontWeight: group === g.id ? 600 : 400, fontFamily: SANS }}>
            {g.label}
          </button>
        ))}
      </div>

      {/* 商品勾選 + 顏色 */}
      <div style={{ border: `1px solid ${BORDER}`, borderRadius: 8, padding: '12px 14px', marginBottom: 12, background: '#FAFAF9' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={{ fontSize: '.8rem', color: SUB, fontWeight: 600 }}>選擇商品（可複選，點色塊改線色）</span>
          <button onClick={selectAll} style={miniBtn}>全選</button>
          <button onClick={clearSel} style={miniBtn}>清除</button>
          <span style={{ marginLeft: 'auto', fontSize: '.76rem', color: SUB }}>已選 {selected.length} 檔</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 6 }}>
          {items.map(it => {
            const on = selected.includes(it.ticker);
            return (
              <div key={it.ticker} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px',
                borderRadius: 6, background: on ? '#fff' : 'transparent', border: `1px solid ${on ? BORDER : 'transparent'}` }}>
                <input type="checkbox" checked={on} onChange={() => toggle(it.ticker)} style={{ cursor: 'pointer' }} />
                <input type="color" value={colors[it.ticker] ?? '#cccccc'} disabled={!on}
                  onChange={e => setColors(p => ({ ...p, [it.ticker]: e.target.value }))}
                  style={{ width: 22, height: 18, border: 'none', background: 'none', padding: 0, cursor: on ? 'pointer' : 'default', opacity: on ? 1 : .4 }} />
                <label onClick={() => toggle(it.ticker)} style={{ cursor: 'pointer', fontSize: '.78rem', color: on ? TEXT : SUB, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <span style={{ fontFamily: MONO }}>{it.ticker}</span> {it.name}
                </label>
              </div>
            );
          })}
        </div>
      </div>

      {/* 區間 + 動作 */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={{ fontSize: '.8rem', color: SUB }}>區間</label>
        <input type="date" value={start} max={end} onChange={e => setStart(e.target.value)} style={dateInput} />
        <span style={{ color: SUB }}>至</span>
        <input type="date" value={end} min={start} onChange={e => setEnd(e.target.value)} style={dateInput} />
        <button onClick={load} disabled={loading}
          style={{ padding: '8px 22px', background: loading ? '#999' : RED, color: '#fff', border: 'none', borderRadius: 6, cursor: loading ? 'not-allowed' : 'pointer', fontSize: '.88rem', fontWeight: 600 }}>
          {loading ? '載入中…' : '繪製'}
        </button>
        {loading && <span style={{ fontSize: '.8rem', color: SUB }}>查詢 Yahoo Finance 中…</span>}
      </div>

      {error && (
        <div style={{ padding: '10px 14px', background: '#fff0f0', border: '1px solid #fca5a5', borderRadius: 6, color: RED, fontSize: '.85rem', marginBottom: 12 }}>{error}</div>
      )}

      {!data && !loading && (
        <p style={{ color: '#AAA', textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>勾選商品與區間後點「繪製」</p>
      )}

      {hasResult && (
        <>
          {/* 互動圖 + 存圖 */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
            <button onClick={downloadPng} style={miniBtn}>↓ 存圖 PNG</button>
          </div>
          <PlotlyWrapper traces={traces} layout={layout} id={CHART_ID} style={{ height: 480 }} />

          {/* 動畫 + 錄影 */}
          <div style={{ marginTop: 18, borderTop: `1px solid ${BORDER}`, paddingTop: 14 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: '.85rem', fontWeight: 600, color: TEXT }}>動畫 / 影片</span>
              <label style={{ fontSize: '.78rem', color: SUB }}>秒數</label>
              <select value={animSec} onChange={e => setAnimSec(Number(e.target.value))} disabled={playing || recording}
                style={{ padding: '5px 8px', border: `1px solid ${BORDER}`, borderRadius: 6, fontFamily: MONO }}>
                {[5, 8, 12].map(s => <option key={s} value={s}>{s}s</option>)}
              </select>
              <label style={{ fontSize: '.78rem', color: SUB }}>格式</label>
              <select value={vidFmt} onChange={e => setVidFmt(e.target.value as 'mp4' | 'webm')} disabled={playing || recording}
                style={{ padding: '5px 8px', border: `1px solid ${BORDER}`, borderRadius: 6, fontFamily: MONO }}>
                <option value="mp4">MP4（社群用）</option>
                <option value="webm">WebM</option>
              </select>
              <label style={{ fontSize: '.78rem', color: SUB, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={dark} onChange={e => setDark(e.target.checked)} style={{ cursor: 'pointer' }} />
                深色背景
              </label>
              <button onClick={play} disabled={playing || recording} style={{ ...miniBtn, opacity: playing || recording ? .5 : 1 }}>
                {playing ? '播放中…' : '▶ 播放動畫'}
              </button>
              <button onClick={recordVideo} disabled={playing || recording} style={{ ...miniBtn, color: recording ? '#fff' : RED, background: recording ? RED : '#fff', borderColor: RED, opacity: playing ? .5 : 1 }}>
                {recording ? '● 錄製中…' : `● 錄製 ${vidFmt.toUpperCase()}`}
              </button>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H}
                style={{ width: '100%', maxWidth: CANVAS_W, border: `1px solid ${BORDER}`, borderRadius: 8, background: dark ? '#0e1116' : '#fff' }} />
            </div>
          </div>

          <div style={{ marginTop: 10, fontSize: '.72rem', color: SUB, lineHeight: 1.8 }}>
            累積報酬以 Yahoo 還原收盤（含息）計算，區間起點＝0%（各商品自其首個有資料日起算）。動畫從 0 起跑、按時間推進；可存 PNG 圖或錄成影片。<br />
            影片格式：上傳 IG／FB／LINE 請用 <b>MP4</b>（新版 Chrome／Edge 可直接錄；不支援時自動改錄 WebM）。可勾選「深色背景」錄出深色版本。
          </div>
        </>
      )}
    </div>
  );
}

const miniBtn: React.CSSProperties = {
  padding: '5px 14px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6,
  cursor: 'pointer', fontSize: '.78rem', color: SUB, fontFamily: SANS, fontWeight: 500,
};
const dateInput: React.CSSProperties = {
  padding: '6px 10px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.85rem', fontFamily: MONO, color: TEXT,
};
