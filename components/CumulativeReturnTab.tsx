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
  { id: 'active',   label: '台股主動式ETF' },
  { id: 'overseas', label: '海外主動式ETF' },
  { id: 'tw50',     label: '台股50' },
];

// 預設線條配色（高辨識度）
const PALETTE = [
  '#C00000', '#1A6B45', '#2563eb', '#B08F6E', '#9333ea', '#dc2626',
  '#0891b2', '#ca8a04', '#db2777', '#15803d', '#7c3aed', '#ea580c',
  '#0f766e', '#a16207', '#be123c', '#4338ca', '#65a30d', '#0369a1',
];

const CHART_ID = 'cumret-chart';

// 兩種輸出版型：橫式（社群橫向、YT）與直式 4:5（手機 / IG / 限動）
// 字級全面放大，並依字級推算邊距，確保轉到手機看時績效數字仍清楚
type Orient = 'land' | 'port';
interface DrawSizes { title: number; date: number; axis: number; report: number; legend: number; swatch: number; dot: number; line: number }
const SPECS: Record<Orient, { W: number; H: number; label: string; sizes: DrawSizes }> = {
  land: {
    W: 1120, H: 560, label: '橫式（適合 FB／YouTube 橫向）',
    sizes: { title: 24, date: 17, axis: 16, report: 19, legend: 16, swatch: 16, dot: 5, line: 2.6 },
  },
  port: {
    W: 1080, H: 1350, label: '直式 4:5（適合手機／IG／限時動態）',
    sizes: { title: 34, date: 22, axis: 21, report: 36, legend: 28, swatch: 24, dot: 7, line: 3.2 },
  },
};

interface CumRetSeries { ticker: string; name: string; pct: (number | null)[] }
interface CumRetResult { start: string; end: string; dates: string[]; series: CumRetSeries[] }

function todayTW(): string {
  const tw = new Date(Date.now() + 8 * 3600 * 1000);
  return `${tw.getUTCFullYear()}-${String(tw.getUTCMonth() + 1).padStart(2, '0')}-${String(tw.getUTCDate()).padStart(2, '0')}`;
}
// 預設區間起點＝去年最後一個交易日（以年底收盤為 0% 基準，即 YTD）。
// 取去年 12/31；若逢週末則回推到最後一個平日（近似最後一個交易日，年底逢週末以外幾乎都有開盤）。
function prevYearEnd(): string {
  const y = new Date(Date.now() + 8 * 3600 * 1000).getUTCFullYear() - 1;
  const d = new Date(Date.UTC(y, 11, 31));
  const dow = d.getUTCDay();                       // 0=日, 6=六
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1); // 週六 → 退到 12/30(五)
  else if (dow === 0) d.setUTCDate(d.getUTCDate() - 2); // 週日 → 退到 12/29(五)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function mmdd(d: string): string { const [, m, dd] = d.split('-'); return `${m}/${dd}`; }
function fmtPct(v: number): string { return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`; }

export default function CumulativeReturnTab() {
  const [group,    setGroup]    = useState('active');
  const [selected, setSelected] = useState<string[]>([]);
  const [colors,   setColors]   = useState<Record<string, string>>({});
  const [start,    setStart]    = useState(prevYearEnd());
  const [end,      setEnd]      = useState(todayTW());
  const [data,     setData]     = useState<CumRetResult | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const [animSec,  setAnimSec]  = useState(8);
  const [playing,  setPlaying]  = useState<Orient | null>(null);
  const [recording, setRecording] = useState<Orient | null>(null);
  const [dark,     setDark]     = useState(false);
  const [vidFmt,   setVidFmt]   = useState<'mp4' | 'webm'>('mp4');

  const items = PEER_GROUPS[group].items;
  const landRef = useRef<HTMLCanvasElement>(null);
  const portRef = useRef<HTMLCanvasElement>(null);
  const refOf = (o: Orient) => (o === 'land' ? landRef : portRef);
  const rafRef = useRef<Record<Orient, number | null>>({ land: null, port: null });
  const darkRef = useRef(false);
  // 動畫繪製用的即時資料（避免 React 重繪延遲影響錄影）
  const viewRef = useRef<{ dates: string[]; lines: { name: string; pct: (number | null)[]; color: string }[]; yMin: number; yMax: number } | null>(null);

  const busy = playing !== null || recording !== null;

  const stopAnim = (o: Orient) => {
    const id = rafRef.current[o];
    if (id != null) { cancelAnimationFrame(id); rafRef.current[o] = null; }
  };
  const stopAll = () => { stopAnim('land'); stopAnim('port'); };

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
    setLoading(true); setError(''); setData(null); stopAll();
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
      line: { color: colors[s.ticker] ?? '#999', width: 2.6 },
      hovertemplate: `%{x}<br>${s.name}：%{y:.2f}%<extra></extra>`,
    }));
  }, [data, colors]);

  const HEIGHT = 480, MT = 16, MB = 48;   // Plotly 圖高與上下邊距（供像素換算）
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
    const minGapPx = 20;
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
      font: { size: 14, color: e.color, family: MONO },
      bgcolor: 'rgba(255,255,255,0.78)', borderpad: 2,
    }));

    return {
      margin: { l: 64, r: 150, t: MT, b: MB },
      height: HEIGHT,
      xaxis: { showgrid: false, tickfont: { size: 13, family: MONO } },
      yaxis: { title: { text: '累積報酬 %', font: { size: 14, family: SANS } }, ticksuffix: '%', range: [yMin, yMax], zeroline: true, zerolinecolor: '#999', zerolinewidth: 1.5, gridcolor: '#F0EDE8', tickfont: { size: 13, family: MONO } },
      legend: { orientation: 'h', y: -0.18, font: { size: 13, family: SANS } },
      hovermode: 'x unified',
      shapes: [{ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: 0, y1: 0, line: { color: '#999', width: 1 } }],
      annotations,
    };
  }, [data, colors]);

  const downloadPng = () => {
    const gd = document.getElementById(CHART_ID);
    if (!gd || !window.Plotly) return;
    const w = Math.max(1000, Math.round(gd.getBoundingClientRect().width));
    window.Plotly.downloadImage(gd, { format: 'png', width: w, height: 560, scale: 2, filename: `累積報酬走勢_${start}_${end}` });
  };

  // ── Canvas 動畫（橫式 / 直式共用同一套繪圖，依版型放大字級與邊距）──
  const buildView = useCallback(() => {
    if (!data || !data.dates.length) { viewRef.current = null; return; }
    const lines = data.series.map(s => ({ name: `${s.ticker} ${s.name}`, pct: s.pct, color: colors[s.ticker] ?? '#999' }));
    let lo = 0, hi = 0;
    for (const l of lines) for (const v of l.pct) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const pad = (hi - lo) * 0.08 || 1;
    viewRef.current = { dates: data.dates, lines, yMin: lo - pad, yMax: hi + pad };
  }, [data, colors]);

  const drawOn = useCallback((o: Orient, frame: number) => {
    const cv = refOf(o).current, view = viewRef.current;
    if (!cv || !view) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const { W, H, sizes: S } = SPECS[o];
    const { dates, lines, yMin, yMax } = view;
    const N = dates.length;
    // 深色 / 淺色主題
    const d = darkRef.current;
    const C = d
      ? { bg: '#0e1116', grid: '#262c36', zero: '#5b6472', text: '#e6edf3', sub: '#9aa4b2', title: '#f0f6fc' }
      : { bg: '#ffffff', grid: '#F0EDE8', zero: '#999999', text: TEXT, sub: SUB, title: TEXT };

    // 邊距依字級推算（字放大 → 邊距同步放大，避免擠壓或裁切）
    const T = Math.round(S.title * 1.55) + 22;       // 上：標題 + 日期
    const L = Math.round(S.axis * 3.4) + 14;         // 左：y 軸數值
    const R = Math.round(S.report * 5.2) + 20;       // 右：行末報酬% 標籤

    // 底部色彩圖例佈局（標示哪個顏色是哪個商品），決定底部高度
    const swatch = S.swatch, sgap = Math.round(S.swatch * 0.5), itemGap = Math.round(S.legend * 1.9);
    const rowH = Math.round(S.legend * 1.7);
    const legendMaxW = W - L - 12;
    ctx.font = `${S.legend}px ${SANS}`;
    let lx = 0, row = 0;
    const placed = lines.map(ln => {
      const w = swatch + sgap + ctx.measureText(ln.name).width + itemGap;
      if (lx > 0 && lx + w > legendMaxW) { row++; lx = 0; }
      const p = { label: ln.name, color: ln.color, row, x: L + lx };
      lx += w; return p;
    });
    const legendRows = row + 1;
    const xLabelH = Math.round(S.axis * 1.5), legendH = legendRows * rowH + 6;
    const B = xLabelH + legendH + 12;
    const pw = W - L - R, ph = H - T - B;
    const xOf = (i: number) => L + (N <= 1 ? 0 : (i / (N - 1)) * pw);
    const yOf = (v: number) => T + (1 - (v - yMin) / (yMax - yMin)) * ph;

    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);

    // y 格線 + 標籤
    ctx.textBaseline = 'middle'; ctx.font = `${S.axis}px ${MONO}`;
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
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = C.sub; ctx.font = `${S.axis}px ${MONO}`;
    const xticks = Math.min(7, N);
    for (let k = 0; k < xticks; k++) {
      const i = Math.round((k / (xticks - 1 || 1)) * (N - 1));
      ctx.fillText(mmdd(dates[i]), xOf(i), T + ph + 8);
    }

    // 標題 + 目前日期
    const headY = Math.round(T * 0.62);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.title; ctx.font = `bold ${S.title}px ${SANS}`;
    ctx.fillText('累積報酬走勢（還原含息）', L, headY);
    ctx.fillStyle = C.sub; ctx.font = `${S.date}px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.fillText(`${dates[0]} → ${dates[Math.min(frame, N - 1)]}`, L + pw, headY);

    // 各商品線
    const f = Math.min(frame, N - 1);
    const endLabels: { x: number; y: number; pct: string; color: string }[] = [];
    for (const ln of lines) {
      ctx.strokeStyle = ln.color; ctx.lineWidth = S.line; ctx.lineJoin = 'round';
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
        ctx.fillStyle = ln.color; ctx.beginPath(); ctx.arc(x, y, S.dot, 0, Math.PI * 2); ctx.fill();
        endLabels.push({ x, y, pct: fmtPct(v), color: ln.color });
      }
    }
    // 「報酬%」跟著各線當前的點移動（畫在點的右側）；同一點上多條線數值接近時做 y 避讓避免重疊
    ctx.font = `bold ${S.report}px ${MONO}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const minGap = Math.round(S.report * 1.25), nearX = Math.round(S.report * 3.4);
    const drawn: { x: number; y: number }[] = [];
    for (const lab of endLabels.slice().sort((a, b) => a.y - b.y)) {
      let y = lab.y;
      // 與已畫且 x 相近的標籤比對，往下推開避免重疊
      for (const p of drawn) if (Math.abs(p.x - (lab.x + 8)) < nearX && y < p.y + minGap) y = p.y + minGap;
      y = Math.min(y, T + ph);
      const rw = ctx.measureText(lab.pct).width;
      const lxp = Math.min(lab.x + 8, W - rw - 6);   // 靠右時不超出畫布
      ctx.fillStyle = lab.color;
      ctx.fillText(lab.pct, lxp, y);
      drawn.push({ x: lxp, y });
    }

    // 底部色彩圖例：標記哪個顏色是哪個商品
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = `${S.legend}px ${SANS}`;
    const legendY0 = T + ph + xLabelH + Math.round(rowH * 0.7);
    for (const p of placed) {
      const cy = legendY0 + p.row * rowH;
      ctx.fillStyle = p.color; ctx.fillRect(p.x, cy - swatch / 2, swatch, swatch);
      ctx.fillStyle = C.text; ctx.fillText(p.label, p.x + swatch + sgap, cy);
    }
  }, []);

  const runAnim = useCallback((o: Orient, durationMs: number, onDone?: () => void) => {
    const view = viewRef.current; if (!view) return;
    const N = view.dates.length;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / durationMs);
      drawOn(o, Math.round(p * (N - 1)));
      if (p < 1) { rafRef.current[o] = requestAnimationFrame(step); }
      else { rafRef.current[o] = null; onDone?.(); }
    };
    rafRef.current[o] = requestAnimationFrame(step);
  }, [drawOn]);

  // 資料/配色變動 → 重建並畫出完整靜態圖（兩種版型）
  useEffect(() => { buildView(); drawOn('land', Number.MAX_SAFE_INTEGER); drawOn('port', Number.MAX_SAFE_INTEGER); }, [buildView, drawOn]);
  // 深色切換 → 重畫
  useEffect(() => { darkRef.current = dark; drawOn('land', Number.MAX_SAFE_INTEGER); drawOn('port', Number.MAX_SAFE_INTEGER); }, [dark, drawOn]);
  useEffect(() => () => stopAll(), []);

  const play = (o: Orient) => {
    if (!viewRef.current) return;
    stopAnim(o); setPlaying(o);
    runAnim(o, animSec * 1000, () => setPlaying(null));
  };

  const recordVideo = (o: Orient) => {
    const cv = refOf(o).current; if (!cv || !viewRef.current) return;
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
    const bitrate = o === 'port' ? 12_000_000 : 8_000_000;   // 直式畫素較多，提高位元率保畫質
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
    const chunks: BlobPart[] = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: mime.split(';')[0] });
      const a = document.createElement('a');
      const dir = o === 'port' ? '直式' : '橫式';
      a.href = URL.createObjectURL(blob); a.download = `累積報酬動畫_${dir}_${start}_${end}.${ext}`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setRecording(null);
    };
    setRecording(o); stopAnim(o);
    rec.start();
    // 從 0 跑到底，結尾停留 3 秒再收尾（總長 = 動畫秒數 + 3）
    runAnim(o, animSec * 1000, () => {
      // 靜止畫面 captureStream 不會自動產生新影格 → 這 3 秒持續重畫，強制影格被錄進去
      const holdStart = performance.now();
      const hold = (now: number) => {
        drawOn(o, Number.MAX_SAFE_INTEGER);
        if (now - holdStart < 3000) { rafRef.current[o] = requestAnimationFrame(hold); }
        else { rafRef.current[o] = null; rec.stop(); }
      };
      rafRef.current[o] = requestAnimationFrame(hold);
    });
  };

  const hasResult = !!data && data.series.length > 0;

  // 單一版型的動畫控制列 + 畫布（用一般函式回傳 JSX，避免巢狀元件每次 render 重掛載 canvas）
  const videoBlock = (o: Orient) => {
    const spec = SPECS[o];
    const isPlaying = playing === o, isRec = recording === o;
    const disabled = busy && !isPlaying && !isRec;       // 其他版型忙碌時暫時禁用
    return (
      <div key={o} style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: '.82rem', fontWeight: 600, color: TEXT }}>{spec.label}</span>
          <span style={{ fontSize: '.72rem', color: SUB, fontFamily: MONO }}>{spec.W}×{spec.H}</span>
          <button onClick={() => play(o)} disabled={disabled || isPlaying || isRec} style={{ ...miniBtn, opacity: (disabled || isPlaying || isRec) ? .5 : 1, marginLeft: 'auto' }}>
            {isPlaying ? '播放中…' : '▶ 播放動畫'}
          </button>
          <button onClick={() => recordVideo(o)} disabled={disabled || isPlaying || isRec}
            style={{ ...miniBtn, color: isRec ? '#fff' : RED, background: isRec ? RED : '#fff', borderColor: RED, opacity: (disabled || isPlaying) ? .5 : 1 }}>
            {isRec ? '● 錄製中…' : `● 錄製 ${vidFmt.toUpperCase()}`}
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: o === 'port' ? 'center' : 'flex-start', overflowX: 'auto' }}>
          <canvas ref={refOf(o)} width={spec.W} height={spec.H}
            style={{ width: '100%', maxWidth: o === 'port' ? 360 : spec.W, border: `1px solid ${BORDER}`, borderRadius: 8, background: dark ? '#0e1116' : '#fff' }} />
        </div>
      </div>
    );
  };

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

          {/* 動畫 + 錄影：共用秒數 / 格式 / 深色，下面分「橫式」「直式」兩個版型 */}
          <div style={{ marginTop: 18, borderTop: `1px solid ${BORDER}`, paddingTop: 14 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
              <span style={{ fontSize: '.85rem', fontWeight: 600, color: TEXT }}>動畫 / 影片</span>
              <label style={{ fontSize: '.78rem', color: SUB }}>秒數</label>
              <select value={animSec} onChange={e => setAnimSec(Number(e.target.value))} disabled={busy}
                style={{ padding: '5px 8px', border: `1px solid ${BORDER}`, borderRadius: 6, fontFamily: MONO }}>
                {[5, 8, 12].map(s => <option key={s} value={s}>{s}s</option>)}
              </select>
              <label style={{ fontSize: '.78rem', color: SUB }}>格式</label>
              <select value={vidFmt} onChange={e => setVidFmt(e.target.value as 'mp4' | 'webm')} disabled={busy}
                style={{ padding: '5px 8px', border: `1px solid ${BORDER}`, borderRadius: 6, fontFamily: MONO }}>
                <option value="mp4">MP4（社群用）</option>
                <option value="webm">WebM</option>
              </select>
              <label style={{ fontSize: '.78rem', color: SUB, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={dark} onChange={e => setDark(e.target.checked)} disabled={busy} style={{ cursor: 'pointer' }} />
                深色背景
              </label>
            </div>

            {videoBlock('land')}
            {videoBlock('port')}
          </div>

          <div style={{ marginTop: 12, fontSize: '.72rem', color: SUB, lineHeight: 1.8 }}>
            累積報酬以 Yahoo 還原收盤（含息）計算，區間起點＝0%（各商品自其首個有資料日起算）。動畫從 0 起跑、按時間推進；可存 PNG 圖或錄成影片。<br />
            <b>直式 4:5（1080×1350）</b>專為手機／IG／限時動態設計，字級更大、轉貼到手機看績效數字仍清楚；橫式則適合 FB／YouTube 橫向。<br />
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
