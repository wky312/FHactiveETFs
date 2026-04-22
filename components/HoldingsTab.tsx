'use client';
import { Holding } from '@/lib/types';
import PlotlyWrapper from './PlotlyWrapper';

const GREY   = '#4D4D4F';
const GREY_D = '#2D2D2F';

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export default function HoldingsTab({ holdings, date }: { holdings: Holding[]; date: string }) {
  const colors = holdings.map((h, i) =>
    h.country === '期貨' ? '#FFF8E7' : h.country === '現金/其他' ? '#F2F2F2' : i % 2 === 0 ? '#F9F9F9' : '#FFF'
  );

  const traces = [{
    type: 'table',
    columnwidth: [85, 200, 115, 145, 75, 130],
    header: {
      values: ['<b>代碼</b>', '<b>名稱</b>', '<b>持股數量</b>', '<b>市值 (NTD)</b>', '<b>佔比 %</b>', '<b>國家</b>'],
      fill: { color: GREY }, font: { color: 'white', size: 13 },
      align: 'center', height: 38, line: { color: GREY_D },
    },
    cells: {
      values: [
        holdings.map(h => h.stockid),
        holdings.map(h => h.stockname),
        holdings.map(h => fmt(h.qshare)),
        holdings.map(h => fmt(h.mvalue)),
        holdings.map(h => `${h.prate_addaccint.toFixed(3)}%`),
        holdings.map(h => h.country),
      ],
      fill: { color: Array(6).fill(colors) },
      font: { size: 12 },
      align: ['center', 'left', 'right', 'right', 'right', 'center'],
      height: 31, line: { color: '#E0E0E0' },
    },
  }];

  return (
    <>
      <p style={{ fontSize: '.85rem', color: '#777', marginBottom: 12 }}>
        資料日期：{date} &nbsp;|&nbsp; 共 {holdings.length} 筆
      </p>
      <PlotlyWrapper traces={traces} layout={{ margin: { l: 5, r: 5, t: 5, b: 5 }, height: Math.max(480, holdings.length * 33 + 60) }} />
    </>
  );
}
