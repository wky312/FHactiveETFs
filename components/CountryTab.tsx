'use client';
import * as XLSX from 'xlsx';
import { Holding } from '@/lib/types';
import PlotlyWrapper from './PlotlyWrapper';

const RED   = '#C00000';
const GOLD  = '#B08F6E';
const GREY  = '#6B6460';
const TEXT  = '#1C1C1E';
const SUB   = '#6B6460';
const MONO  = "'IBM Plex Mono', 'Courier New', monospace";
const SANS  = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

const DONUT_COLORS = [
  '#C00000', '#D94040', '#E86060', '#F09090',
  '#B08F6E', '#C9A882', '#DEC4A6',
  '#1A6B45', '#2E8B5A', '#4AA872',
  '#6B6460', '#8A7F7A',
];

export default function CountryTab({ holdings, date, etfTicker }: { holdings: Holding[]; date: string; etfTicker: string }) {
  const allocMap = new Map<string, number>();
  for (const h of holdings) {
    allocMap.set(h.country, (allocMap.get(h.country) ?? 0) + h.prate_addaccint);
  }

  const rows = Array.from(allocMap.entries())
    .map(([country, prate]) => ({ country, prate }))
    .sort((a, b) => b.prate - a.prate);

  // Bar chart (ascending so largest is at top)
  const barRows = [...rows].sort((a, b) => a.prate - b.prate);
  const barColors = barRows.map(r =>
    r.country === '期貨' ? GOLD : r.country === '現金/其他' ? GREY : RED
  );

  const barTrace = [{
    type: 'bar', orientation: 'h',
    x: barRows.map(r => r.prate),
    y: barRows.map(r => r.country),
    text: barRows.map(r => `${r.prate.toFixed(2)}%`),
    textposition: 'outside', cliponaxis: false,
    marker: { color: barColors, line: { color: '#fff', width: 0.5 } },
    hovertemplate: '<b>%{y}</b><br>佔比: %{x:.3f}%<extra></extra>',
  }];

  const barLayout = {
    margin: { l: 120, r: 80, t: 10, b: 30 },
    height: Math.max(320, barRows.length * 38 + 60),
    paper_bgcolor: '#fff', plot_bgcolor: '#fff',
    xaxis: {
      ticksuffix: '%', gridcolor: '#EEE9E4', showgrid: true, zeroline: false,
      tickfont: { family: "'IBM Plex Mono', monospace", size: 11 },
    },
    yaxis: {
      automargin: true,
      tickfont: { family: "'Noto Sans TC', sans-serif", size: 12 },
    },
    bargap: 0.28,
  };

  // Donut: top 8 countries + 其他
  const TOP_N = 8;
  const stockRows   = rows.filter(r => r.country !== '期貨' && r.country !== '現金/其他');
  const specialRows = rows.filter(r => r.country === '期貨' || r.country === '現金/其他');
  const topRows     = stockRows.slice(0, TOP_N);
  const othersSum   = stockRows.slice(TOP_N).reduce((s, r) => s + r.prate, 0);

  const donutLabels = [...topRows.map(r => r.country), ...(othersSum > 0 ? ['其他國家'] : []), ...specialRows.map(r => r.country)];
  const donutValues = [...topRows.map(r => r.prate),   ...(othersSum > 0 ? [othersSum]  : []), ...specialRows.map(r => r.prate)];
  const donutColors = [
    ...topRows.map((_, i) => DONUT_COLORS[i % DONUT_COLORS.length]),
    ...(othersSum > 0 ? ['#D0CBC6'] : []),
    ...specialRows.map(r => r.country === '期貨' ? GOLD : GREY),
  ];

  const donutTrace = [{
    type: 'pie', hole: 0.52,
    labels: donutLabels, values: donutValues,
    marker: { colors: donutColors, line: { color: '#fff', width: 2 } },
    texttemplate: '%{value:.2f}%',
    textfont: { family: "'IBM Plex Mono', monospace", size: 11 },
    hovertemplate: '<b>%{label}</b><br>%{value:.3f}%<extra></extra>',
    sort: false,
  }];

  const donutLayout = {
    margin: { l: 10, r: 10, t: 20, b: 10 },
    height: 280,
    paper_bgcolor: '#fff', plot_bgcolor: '#fff',
    showlegend: true,
    legend: {
      font: { family: "'Noto Sans TC', sans-serif", size: 11 },
      orientation: 'v', x: 1.02, y: 0.5,
    },
  };

  // Stats
  const stockRows2 = rows.filter(r => r.country !== '期貨' && r.country !== '現金/其他');
  const top1       = stockRows2[0];
  const top3Sum    = stockRows2.slice(0, 3).reduce((s, r) => s + r.prate, 0);
  const mktCount   = stockRows2.length;

  const STAT_CARDS = [
    { label: '最大配置', value: `${top1?.prate.toFixed(2) ?? '—'}%`, sub: top1?.country ?? '', color: RED },
    { label: '市場數量', value: String(mktCount),                      sub: '個股票市場',            color: TEXT },
    { label: '前三大合計', value: `${top3Sum.toFixed(1)}%`,           sub: '集中度',                color: TEXT },
  ];

  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>

      {/* Stat cards — full width above charts */}
      <div style={{
        width: '100%',
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
        border: '1px solid #EEE9E4', borderRadius: 8, overflow: 'hidden',
        marginBottom: 4, background: '#FAFAF9',
      }}>
        {STAT_CARDS.map((c, i) => (
          <div key={c.label} style={{ padding: '14px 18px', borderRight: i < 2 ? '1px solid #EEE9E4' : 'none' }}>
            <div style={{ fontSize: '.72rem', color: SUB, fontWeight: 500, marginBottom: 5, fontFamily: SANS }}>{c.label}</div>
            <div style={{ fontSize: '1.55rem', fontWeight: 700, color: c.color, fontFamily: MONO, lineHeight: 1.1 }}>{c.value}</div>
            <div style={{ fontSize: '.72rem', color: SUB, marginTop: 4, fontFamily: SANS }}>{c.sub}</div>
          </div>
        ))}
      </div>

      {/* Bar chart */}
      <div style={{ flex: '1 1 420px', minWidth: 320 }}>
        <p style={{ margin: '0 0 8px 2px', fontSize: '.78rem', fontWeight: 600, color: SUB, letterSpacing: '.4px' }}>各國佔比</p>
        <PlotlyWrapper traces={barTrace} layout={barLayout} />
      </div>

      {/* Donut + summary table */}
      <div style={{ flex: '0 0 360px', minWidth: 280 }}>
        <p style={{ margin: '0 0 4px 2px', fontSize: '.78rem', fontWeight: 600, color: SUB, letterSpacing: '.4px' }}>配置比例</p>
        <PlotlyWrapper traces={donutTrace} layout={donutLayout} />

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12, marginBottom: 4 }}>
          <button
            onClick={() => {
              const ws = XLSX.utils.aoa_to_sheet([['國家 / 類別', '佔比%'], ...rows.map(r => [r.country, parseFloat(r.prate.toFixed(3))])]);
              ws['!cols'] = [{ wch: 16 }, { wch: 10 }];
              const wb = XLSX.utils.book_new();
              XLSX.utils.book_append_sheet(wb, ws, '國家配置');
              XLSX.writeFile(wb, `${etfTicker}_國家配置_${date}.xlsx`);
            }}
            style={{ padding: '4px 12px', background: '#fff', border: '1px solid #EEE9E4', borderRadius: 6, cursor: 'pointer', fontSize: '.75rem', color: SUB, fontFamily: SANS, fontWeight: 500 }}
          >
            ↓ 匯出 Excel
          </button>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
          <thead>
            <tr style={{ background: '#1C1C1E', color: '#fff' }}>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontFamily: SANS }}>國家 / 類別</th>
              <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, fontFamily: MONO }}>佔比合計</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.country} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAF9', borderBottom: '1px solid #EEE9E4' }}>
                <td style={{ padding: '6px 12px', color: TEXT, fontFamily: SANS }}>{r.country}</td>
                <td style={{ padding: '6px 12px', textAlign: 'right', fontFamily: MONO, color: TEXT }}>
                  {r.prate.toFixed(3)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  );
}
