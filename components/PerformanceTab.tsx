'use client';
import { useState, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { StockPerformance } from '@/lib/yahooFinance';

type SortKey = 'prate' | 'today' | 'd3' | 'd5' | 'm1' | 'm3' | 'ytd' | 'pctCustom';

const RED    = '#C00000';
const GREEN  = '#1a7f37';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

const PERF_COLS: { key: SortKey; label: string }[] = [
  { key: 'today', label: '今日' },
  { key: 'd3',    label: '近3日' },
  { key: 'd5',    label: '近5日' },
  { key: 'm1',    label: '近一月' },
  { key: 'm3',    label: '近三月' },
  { key: 'ytd',   label: 'YTD' },
];

// 台股慣例：漲=紅，跌=綠
function perfColor(v: number | null): string {
  if (v === null) return SUB;
  if (v >= 3)  return '#b91c1c';
  if (v >= 1)  return '#dc2626';
  if (v <= -3) return '#1a7f37';
  if (v <= -1) return '#2da44e';
  return TEXT;
}

function perfBg(v: number | null): string {
  if (v === null) return 'transparent';
  if (v >= 3)  return '#fee2e2';
  if (v >= 1)  return '#fef2f2';
  if (v <= -3) return '#dcfce7';
  if (v <= -1) return '#f0fdf4';
  return 'transparent';
}

function fmtPct(v: number | null): string {
  if (v === null) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function fmtNum(v: number | null, decimals = 2): string | number {
  return v === null ? '' : parseFloat(v.toFixed(decimals));
}

const TH: React.CSSProperties = {
  padding: '10px 12px', fontWeight: 600, fontSize: '.75rem', letterSpacing: '.4px',
  background: '#1C1C1E', color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1, cursor: 'pointer', userSelect: 'none',
};

function exportExcel(
  results: StockPerformance[],
  date: string, ticker: string,
  appliedRange: { start: string; end: string } | null,
  customMap: Map<string, number | null>,
) {
  const customLabel = appliedRange ? [`自訂區間%(${appliedRange.start}→${appliedRange.end})`] : [];
  const headers = ['代碼', '名稱', '佔比%', '現價', ...customLabel, '今日%', '近3日%', '近5日%', '近一月%', '近三月%', 'YTD%'];
  const rows = results.map(r => {
    const customVal = appliedRange ? [fmtNum(customMap.get(r.stockid) ?? null)] : [];
    return [
      r.stockid, r.stockname, fmtNum(r.prate, 3), r.currentPrice ?? '',
      ...customVal,
      fmtNum(r.today), fmtNum(r.d3), fmtNum(r.d5),
      fmtNum(r.m1), fmtNum(r.m3), fmtNum(r.ytd),
    ];
  });

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = [
    { wch: 8 }, { wch: 16 }, { wch: 8 }, { wch: 8 },
    ...customLabel.map(() => ({ wch: 14 })),
    { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 8 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '股價表現');
  XLSX.writeFile(wb, `${ticker}_股價表現_${date}.xlsx`);
}

export default function PerformanceTab({
  results, date, etfTicker, fundId,
}: {
  results: StockPerformance[];
  date: string;
  etfTicker: string;
  fundId: string;
}) {
  const [sortKey,      setSortKey]      = useState<SortKey>('today');
  const [sortAsc,      setSortAsc]      = useState(false);
  const [customStart,  setCustomStart]  = useState('');
  const [customEnd,    setCustomEnd]    = useState('');
  const [appliedRange, setAppliedRange] = useState<{ start: string; end: string } | null>(null);
  const [customMap,    setCustomMap]    = useState<Map<string, number | null>>(new Map());
  const [customLoading, setCustomLoading] = useState(false);
  const [customError,  setCustomError]  = useState('');

  const applyCustomRange = async () => {
    if (!customStart || !customEnd) return;
    const range = { start: customStart, end: customEnd };
    setAppliedRange(range);
    setCustomLoading(true);
    setCustomError('');
    try {
      const r = await fetch(
        `/api/performance?date=${encodeURIComponent(date)}&fundId=${encodeURIComponent(fundId)}&startDate=${customStart}&endDate=${customEnd}`
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      const map = new Map<string, number | null>();
      for (const item of (json.results as StockPerformance[])) {
        map.set(item.stockid, item.pctCustom);
      }
      setCustomMap(map);
    } catch (e) {
      setCustomError(e instanceof Error ? e.message : '載入失敗');
      setAppliedRange(null);
    } finally {
      setCustomLoading(false);
    }
  };

  const clearCustomRange = () => {
    setCustomStart('');
    setCustomEnd('');
    setAppliedRange(null);
    setCustomMap(new Map());
    setCustomError('');
  };

  const sorted = useMemo(() => {
    return [...results].sort((a, b) => {
      const av = (sortKey === 'pctCustom' ? (customMap.get(a.stockid) ?? null) : a[sortKey]) ?? -Infinity;
      const bv = (sortKey === 'pctCustom' ? (customMap.get(b.stockid) ?? null) : b[sortKey]) ?? -Infinity;
      return sortAsc ? av - bv : bv - av;
    });
  }, [results, sortKey, sortAsc, customMap]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc(p => !p);
    else { setSortKey(key); setSortAsc(false); }
  };

  const withToday   = results.filter(r => r.today !== null);
  const upCount     = withToday.filter(r => (r.today ?? 0) > 0).length;
  const downCount   = withToday.filter(r => (r.today ?? 0) < 0).length;
  const weightedRet = withToday.reduce((s, r) => s + r.prate * (r.today ?? 0) / 100, 0);

  // Detect stale price: regularMarketTime is not today (TST)
  const priceAsOfStr = (() => {
    const sample = results.find(r => r.priceAsOf);
    if (!sample?.priceAsOf) return null;
    const d = new Date(sample.priceAsOf);
    // Convert to TST (UTC+8)
    const tst = new Date(d.getTime() + 8 * 3600 * 1000);
    return `${tst.getUTCFullYear()}/${String(tst.getUTCMonth()+1).padStart(2,'0')}/${String(tst.getUTCDate()).padStart(2,'0')} ${String(tst.getUTCHours()).padStart(2,'0')}:${String(tst.getUTCMinutes()).padStart(2,'0')} TST`;
  })();

  const nowTst = new Date(Date.now() + 8 * 3600 * 1000);
  const isMarketHours = nowTst.getUTCDay() >= 1 && nowTst.getUTCDay() <= 5
    && nowTst.getUTCHours() >= 1 && (nowTst.getUTCHours() < 5 || (nowTst.getUTCHours() === 5 && nowTst.getUTCMinutes() < 30));

  return (
    <>
      {isMarketHours && (
        <div style={{ marginBottom: 12, padding: '8px 14px', background: '#FFF9EC', border: '1px solid #F5D06A', borderRadius: 6, fontSize: '.82rem', color: '#92620A' }}>
          ⚠ 台股盤中（09:00–13:30）：Yahoo Finance 不提供即時報價，現價顯示為<strong>前一交易日收盤價</strong>，13:30 收盤後約 1–2 小時更新為今日收盤價。
        </div>
      )}
      <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: '.82rem', color: SUB, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>持股日期：<strong style={{ color: TEXT, fontFamily: MONO }}>{date}</strong></span>
          <span style={{ color: BORDER }}>|</span>
          <span>股價來源：Yahoo Finance{priceAsOfStr ? `（報價截至 ${priceAsOfStr}）` : '（延遲）'}</span>
        </div>
        <button
          onClick={() => exportExcel(sorted, date, etfTicker, appliedRange, customMap)}
          style={{
            padding: '6px 16px', background: '#fff', border: `1px solid ${BORDER}`,
            borderRadius: 6, cursor: 'pointer', fontSize: '.8rem', color: SUB,
            fontFamily: SANS, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          ↓ 匯出 Excel
        </button>
      </div>

      {/* Custom date range */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', padding: '10px 14px', background: '#FAFAF9', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
        <span style={{ fontSize: '.78rem', color: SUB, fontWeight: 600, whiteSpace: 'nowrap' }}>自訂區間</span>
        <input
          type="date" value={customStart} onChange={e => setCustomStart(e.target.value)}
          style={{ padding: '5px 10px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.85rem', fontFamily: MONO, color: TEXT }}
        />
        <span style={{ fontSize: '.8rem', color: SUB }}>至</span>
        <input
          type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)}
          style={{ padding: '5px 10px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.85rem', fontFamily: MONO, color: TEXT }}
        />
        <button
          onClick={applyCustomRange}
          disabled={!customStart || !customEnd || customLoading}
          style={{
            padding: '6px 16px', background: customStart && customEnd && !customLoading ? RED : '#ccc',
            color: '#fff', border: 'none', borderRadius: 6,
            cursor: customStart && customEnd && !customLoading ? 'pointer' : 'not-allowed',
            fontSize: '.82rem', fontWeight: 600,
          }}
        >
          {customLoading ? '計算中…' : '套用'}
        </button>
        {appliedRange && !customLoading && (
          <button
            onClick={clearCustomRange}
            style={{ padding: '6px 14px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, cursor: 'pointer', fontSize: '.78rem', color: SUB }}
          >
            清除
          </button>
        )}
        {customLoading && <span style={{ fontSize: '.8rem', color: SUB }}>查詢 Yahoo Finance 中，約需 15–30 秒…</span>}
        {appliedRange && !customLoading && (
          <span style={{ fontSize: '.76rem', color: RED, fontWeight: 600 }}>
            已套用：{appliedRange.start} → {appliedRange.end}
          </span>
        )}
        {customError && <span style={{ fontSize: '.78rem', color: RED }}>{customError}</span>}
      </div>

      {/* Summary bar */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4,1fr)',
        border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden',
        marginBottom: 16, background: '#FAFAF9',
      }}>
        {[
          { label: '今日上漲',  value: `${upCount} 檔`,   color: RED   },
          { label: '今日下跌',  value: `${downCount} 檔`, color: GREEN },
          { label: '平盤/未知', value: `${results.length - upCount - downCount} 檔`, color: SUB },
          {
            label: '加權今日報酬',
            value: withToday.length ? `${weightedRet >= 0 ? '+' : ''}${weightedRet.toFixed(3)}%` : '—',
            color: weightedRet > 0 ? RED : weightedRet < 0 ? GREEN : TEXT,
          },
        ].map((c, i, arr) => (
          <div key={c.label} style={{
            padding: '14px 16px',
            borderRight: i < arr.length - 1 ? `1px solid ${BORDER}` : 'none',
          }}>
            <div style={{ fontSize: '.72rem', color: SUB, fontWeight: 500, marginBottom: 4, fontFamily: SANS }}>{c.label}</div>
            <div style={{ fontSize: '1.45rem', fontWeight: 700, color: c.color, fontFamily: MONO, lineHeight: 1.1 }}>{c.value}</div>
          </div>
        ))}
      </div>

      <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '65vh', borderRadius: 8, border: `1px solid ${BORDER}` }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 780 }}>
          <thead>
            <tr>
              <th style={{ ...TH, textAlign: 'center', width: 76 }}>代碼</th>
              <th style={{ ...TH, textAlign: 'left' }}>名稱</th>
              <th
                style={{ ...TH, textAlign: 'right', background: sortKey === 'prate' ? '#333' : '#1C1C1E' }}
                onClick={() => toggleSort('prate')}
              >
                佔比{sortKey === 'prate' ? (sortAsc ? ' ↑' : ' ↓') : ''}
              </th>
              <th style={{ ...TH, textAlign: 'right', width: 70 }}>現價</th>
              {appliedRange && (
                <th
                  onClick={() => toggleSort('pctCustom')}
                  style={{ ...TH, textAlign: 'right', width: 110, background: sortKey === 'pctCustom' ? '#7C3030' : '#A03030', whiteSpace: 'normal', lineHeight: 1.3 }}
                >
                  自訂區間{sortKey === 'pctCustom' ? (sortAsc ? ' ↑' : ' ↓') : ''}<br />
                  <span style={{ fontWeight: 400, fontSize: '.65rem', opacity: .85 }}>{appliedRange.start.slice(5)}→{appliedRange.end.slice(5)}</span>
                </th>
              )}
              {PERF_COLS.map(c => (
                <th
                  key={c.key}
                  style={{ ...TH, textAlign: 'right', background: sortKey === c.key ? '#333' : '#1C1C1E' }}
                  onClick={() => toggleSort(c.key)}
                >
                  {c.label}{sortKey === c.key ? (sortAsc ? ' ↑' : ' ↓') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={`${r.stockid}-${i}`} style={{
                background: i % 2 === 0 ? '#fff' : '#FAFAF9',
                borderBottom: `1px solid ${BORDER}`,
              }}>
                <td style={{ padding: '8px 12px', textAlign: 'center', fontSize: '.8rem', fontFamily: MONO, color: SUB }}>{r.stockid || '—'}</td>
                <td style={{ padding: '8px 12px', fontSize: '.86rem', color: TEXT, maxWidth: 180, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.stockname}</td>
                <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', color: TEXT, fontWeight: 500 }}>{r.prate.toFixed(3)}%</td>
                <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>
                  {r.currentPrice !== null ? r.currentPrice.toFixed(2) : '—'}
                </td>
                {appliedRange && (() => {
                  const v = customMap.get(r.stockid) ?? null;
                  return (
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', fontWeight: 700, color: perfColor(v), background: perfBg(v) }}>
                      {customLoading ? '…' : fmtPct(v)}
                    </td>
                  );
                })()}
                {PERF_COLS.map(c => {
                  const v = r[c.key];
                  return (
                    <td
                      key={c.key}
                      style={{
                        padding: '8px 12px', textAlign: 'right',
                        fontFamily: MONO, fontSize: '.82rem', fontWeight: 600,
                        color: perfColor(v), background: perfBg(v),
                      }}
                    >
                      {fmtPct(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
