'use client';
import { useState, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { Holding } from '@/lib/types';

const RED    = '#C00000';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

type SortKey = 'stockid' | 'stockname' | 'qshare' | 'mvalue' | 'prate_addaccint' | 'country';

const TH: React.CSSProperties = {
  padding: '11px 14px', fontWeight: 600, fontSize: '.78rem', letterSpacing: '.4px',
  background: '#1C1C1E', color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1,
  cursor: 'pointer', userSelect: 'none',
};

function rowBg(h: Holding, i: number) {
  if (h.country === '期貨')      return '#FDFAF2';
  if (h.country === '現金/其他') return '#F8F8F8';
  return i % 2 === 0 ? '#fff' : '#FAFAF9';
}

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtMvalue(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(3)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

interface StatCard { label: string; value: string; sub: string; valueColor?: string }

function StatCards({ cards }: { cards: StatCard[] }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: `repeat(${cards.length}, 1fr)`,
      border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden',
      marginBottom: 16, background: '#FAFAF9',
    }}>
      {cards.map((c, i) => (
        <div key={c.label} style={{
          padding: '14px 18px',
          borderRight: i < cards.length - 1 ? `1px solid ${BORDER}` : 'none',
        }}>
          <div style={{ fontSize: '.72rem', color: SUB, fontWeight: 500, marginBottom: 5, fontFamily: SANS }}>{c.label}</div>
          <div style={{ fontSize: '1.55rem', fontWeight: 700, color: c.valueColor ?? TEXT, fontFamily: MONO, lineHeight: 1.1 }}>{c.value}</div>
          <div style={{ fontSize: '.72rem', color: SUB, marginTop: 4, fontFamily: SANS }}>{c.sub}</div>
        </div>
      ))}
    </div>
  );
}

function exportExcel(holdings: Holding[], date: string, ticker: string) {
  const headers = ['代碼', '名稱', '持股數量', '市值(NTD)', '佔比%', '國家'];
  const rows = holdings.map(h => [
    h.stockid,
    h.stockname,
    h.qshare,
    h.mvalue,
    parseFloat(h.prate_addaccint.toFixed(3)),
    h.country,
  ]);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = [
    { wch: 10 }, { wch: 20 }, { wch: 14 }, { wch: 16 }, { wch: 10 }, { wch: 12 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '持股清單');
  XLSX.writeFile(wb, `${ticker}_持股清單_${date}.xlsx`);
}

export default function HoldingsTab({ holdings, date, etfTicker }: { holdings: Holding[]; date: string; etfTicker: string }) {
  const [sortKey, setSortKey] = useState<SortKey>('prate_addaccint');
  const [sortAsc, setSortAsc] = useState(false);

  const stocks  = holdings.filter(h => h.stockid.trim() !== '');
  const byPrate = [...stocks].sort((a, b) => b.prate_addaccint - a.prate_addaccint);
  const top     = byPrate[0];
  const top10   = byPrate.slice(0, 10).reduce((s, h) => s + h.prate_addaccint, 0);
  const totalMv = holdings.reduce((s, h) => s + h.mvalue, 0);
  const mktCount = new Set(
    stocks.filter(h => h.country !== '期貨' && h.country !== '現金/其他').map(h => h.country)
  ).size;

  const sortedHoldings = useMemo(() => {
    return [...holdings].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'string' && typeof bv === 'string')
        return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
  }, [holdings, sortKey, sortAsc]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc(p => !p);
    else { setSortKey(key); setSortAsc(false); }
  };

  const thLabel = (key: SortKey, label: string) =>
    sortKey === key ? `${label} ${sortAsc ? '↑' : '↓'}` : label;

  const statCards: StatCard[] = [
    {
      label: '最大持倉',
      value: `${top?.prate_addaccint.toFixed(3) ?? '—'}%`,
      sub:   top ? `${top.stockid} · ${top.stockname.slice(0, 12)}` : '',
      valueColor: RED,
    },
    {
      label: '持股檔數',
      value: String(stocks.length),
      sub:   `跨 ${mktCount} 個市場`,
    },
    {
      label: '總市值 (NTD)',
      value: fmtMvalue(totalMv),
      sub:   '以台幣計算',
    },
    {
      label: '前十大合計',
      value: `${top10.toFixed(1)}%`,
      sub:   '集中度指標',
    },
  ];

  return (
    <>
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: '.82rem', color: SUB, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <span>資料日期：<strong style={{ color: TEXT, fontFamily: MONO }}>{date}</strong></span>
          <span style={{ color: BORDER }}>|</span>
          <span>共 <strong style={{ color: TEXT }}>{holdings.length}</strong> 筆　點擊欄位標題可排序</span>
        </div>
        <button
          onClick={() => exportExcel(sortedHoldings, date, etfTicker)}
          style={{
            padding: '6px 16px', background: '#fff', border: `1px solid ${BORDER}`,
            borderRadius: 6, cursor: 'pointer', fontSize: '.8rem', color: SUB,
            fontFamily: SANS, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          ↓ 匯出 Excel
        </button>
      </div>

      <StatCards cards={statCards} />

      <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '60vh', borderRadius: 8, border: `1px solid ${BORDER}` }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead>
            <tr>
              <th onClick={() => toggleSort('stockid')}         style={{ ...TH, textAlign: 'center', width: 88 }}>{thLabel('stockid', '代碼')}</th>
              <th onClick={() => toggleSort('stockname')}       style={{ ...TH, textAlign: 'left' }}>{thLabel('stockname', '名稱')}</th>
              <th onClick={() => toggleSort('qshare')}          style={{ ...TH, textAlign: 'right' }}>{thLabel('qshare', '持股數量')}</th>
              <th onClick={() => toggleSort('mvalue')}          style={{ ...TH, textAlign: 'right' }}>{thLabel('mvalue', '市值 (NTD)')}</th>
              <th onClick={() => toggleSort('prate_addaccint')} style={{ ...TH, textAlign: 'right' }}>{thLabel('prate_addaccint', '佔比 %')}</th>
              <th onClick={() => toggleSort('country')}         style={{ ...TH, textAlign: 'center' }}>{thLabel('country', '國家')}</th>
            </tr>
          </thead>
          <tbody>
            {sortedHoldings.map((h, i) => (
              <tr key={`${h.stockid}-${i}`} style={{ background: rowBg(h, i), borderBottom: `1px solid ${BORDER}` }}>
                <td style={{ padding: '9px 14px', textAlign: 'center', fontSize: '.82rem', fontFamily: MONO, color: SUB }}>{h.stockid || '—'}</td>
                <td style={{ padding: '9px 14px', fontSize: '.88rem', color: TEXT, maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.stockname}</td>
                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', color: TEXT }}>{fmt(h.qshare)}</td>
                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', color: TEXT }}>{fmt(h.mvalue)}</td>
                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', color: TEXT, fontWeight: 500 }}>{h.prate_addaccint.toFixed(3)}%</td>
                <td style={{ padding: '9px 14px', textAlign: 'center', fontSize: '.8rem', color: SUB }}>{h.country}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
