'use client';
import { useEffect, useRef } from 'react';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window { Plotly: any }
}

interface Props {
  traces: any[];
  layout: any;
  style?: React.CSSProperties;
  // 若提供：index = trace 序號，值 = 該 trace 所屬 subplot id（如 ['xy','xy2','xy3','xy3']）。
  // 游標 hover 任一子圖時，會同步在所有子圖的相同 X 觸發 hover —— 讓上下子圖同時顯示該日期全部數值。
  hoverSync?: string[];
}

export default function PlotlyWrapper({ traces, layout, style, hoverSync }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current as any;
    let disposed = false;

    const render = () => {
      if (!el || !window.Plotly) { setTimeout(render, 150); return; }
      window.Plotly.newPlot(
        el,
        traces,
        { paper_bgcolor: '#fff', plot_bgcolor: '#fff', ...layout },
        { responsive: true, displaylogo: false, displayModeBar: false },
      ).then(() => {
        if (disposed || !hoverSync || hoverSync.length < 2) return;
        let busy = false;
        el.on('plotly_hover', (d: any) => {
          if (busy) return;
          const i = d?.points?.[0]?.pointNumber;
          if (i == null) return;
          // Plotly 已原生顯示「游標所在子圖」的 hover；只補上「其他子圖」避免重疊
          const shown = new Set(
            (d.points || []).map((p: any) => (p?.yaxis?._id ? 'x' + p.yaxis._id : null)),
          );
          const pts: { curveNumber: number; pointNumber: number }[] = [];
          const subs: string[] = [];
          hoverSync.forEach((sub, c) => {
            if (!shown.has(sub)) { pts.push({ curveNumber: c, pointNumber: i }); subs.push(sub); }
          });
          if (!pts.length) return;
          busy = true;
          try { window.Plotly.Fx.hover(el, pts, subs); } catch { /* noop */ }
          busy = false;
        });
        el.on('plotly_unhover', () => { try { window.Plotly.Fx.unhover(el); } catch { /* noop */ } });
      });
    };
    render();

    return () => { disposed = true; if (window.Plotly && el) window.Plotly.purge(el); };
  }, [traces, layout, hoverSync]);

  return <div ref={ref} style={{ width: '100%', ...style }} />;
}
