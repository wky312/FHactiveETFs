'use client';
import { Holding } from '@/lib/types';
import PlotlyWrapper from './PlotlyWrapper';

const RED    = '#C00000';
const GOLD   = '#B08F6E';
const GREY   = '#4D4D4F';
const GREY_L = '#7D7D7F';

export default function CountryTab({ holdings }: { holdings: Holding[] }) {
  // Aggregate by country
  const allocMap = new Map<string, number>();
  for (const h of holdings) {
    allocMap.set(h.country, (allocMap.get(h.country) ?? 0) + h.prate_addaccint);
  }

  const rows = Array.from(allocMap.entries())
    .map(([country, prate]) => ({ country, prate }))
    .sort((a, b) => b.prate - a.prate);

  // Bar chart uses ascending order so largest bar is at top
  const chartRows = [...rows].sort((a, b) => a.prate - b.prate);

  const barColors = chartRows.map(r =>
    r.country === '期貨' ? GOLD : r.country === '現金/其他' ? GREY_L : RED
  );

  const traces = [{
    type: 'bar',
    orientation: 'h',
    x: chartRows.map(r => r.prate),
    y: chartRows.map(r => r.country),
    text: chartRows.map(r => `${r.prate.toFixed(2)}%`),
    textposition: 'outside',
    cliponaxis: false,
    marker: { color: barColors, line: { color: '#fff', width: 1 } },
    hovertemplate: '<b>%{y}</b><br>佔比: %{x:.3f}%<extra></extra>',
  }];

  const layout = {
    margin: { l: 130, r: 90, t: 20, b: 40 },
    height: Math.max(360, chartRows.length * 40 + 80),
    xaxis: { ticksuffix: '%', gridcolor: '#EFEFEF', showgrid: true, zeroline: false },
    yaxis: { automargin: true },
    bargap: 0.25,
  };

  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {/* Bar chart */}
      <div style={{ flex: 1, minWidth: 300 }}>
        <PlotlyWrapper traces={traces} layout={layout} />
      </div>

      {/* Summary table */}
      <div style={{ width: 210, flexShrink: 0 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: GREY, color: '#fff' }}>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>國家 / 類別</th>
              <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>佔比合計</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.country} style={{
                background: r.country === '期貨' ? '#FFF8E7' : r.country === '現金/其他' ? '#F2F2F2' : i % 2 === 0 ? '#F9F9F9' : '#FFF',
              }}>
                <td style={{ padding: '6px 12px', borderBottom: '1px solid #E5E5E5' }}>{r.country}</td>
                <td style={{ padding: '6px 12px', borderBottom: '1px solid #E5E5E5', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
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
