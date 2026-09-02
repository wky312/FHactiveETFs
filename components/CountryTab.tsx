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

  // 只留橫條圖：每根 bar 上已經標了百分比，甜甜圈與摘要表格都是同一份數字的重複呈現。
  const stockRows = rows.filter(r => r.country !== '期貨' && r.country !== '現金/其他');
  const top1      = stockRows[0];
  const top3Sum   = stockRows.slice(0, 3).reduce((s, r) => s + r.prate, 0);
  const mktCount  = stockRows.length;

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
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
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

      {/* Bar chart —— 這頁唯一的圖 */}
      <div style={{ width: '100%', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 2px 8px' }}>
          <p style={{ margin: 0, fontSize: '.78rem', fontWeight: 600, color: SUB, letterSpacing: '.4px' }}>各國佔比</p>
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
        <PlotlyWrapper traces={barTrace} layout={barLayout} />
      </div>

    </div>
  );
}
