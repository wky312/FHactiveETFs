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
}

export default function PlotlyWrapper({ traces, layout, style }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;

    const render = () => {
      if (!el || !window.Plotly) { setTimeout(render, 150); return; }
      window.Plotly.newPlot(
        el,
        traces,
        { paper_bgcolor: '#fff', plot_bgcolor: '#fff', ...layout },
        { responsive: true, displaylogo: false, displayModeBar: false },
      );
    };
    render();

    return () => { if (window.Plotly && el) window.Plotly.purge(el); };
  }, [traces, layout]);

  return <div ref={ref} style={{ width: '100%', ...style }} />;
}
