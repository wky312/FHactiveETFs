'use client';
import { useState, useMemo } from 'react';
import * as XLSX from 'xlsx';
import type { PeerPerfResult } from '@/app/api/peer-performance/route';

const GROUPS = [
  { id: 'active',   label: '台股主動式ETF' },
  { id: 'overseas', label: '海外主動式ETF' },
  { id: 'tw50',     label: '台股50' },
];

const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const RED    = '#C00000';
const GREEN  = '#1A6B45';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

type SortKey = keyof PeerPerfResult;

const PERF_COLS: { key: SortKey; label: string }[] = [
  { key: 'pct1d',  label: '當日%' },
  { key: 'pctWTD', label: '週初至今%' },
  { key: 'pctMTD', label: '月初至今%' },
  { key: 'pctYTD', label: '年初至今%' },
  { key: 'pct5d',  label: '近5日%' },
  { key: 'pct1m',  label: '近1月%' },
  { key: 'pct3m',  label: '近3月%' },
  { key: 'pct6m',  label: '近6月%' },
  { key: 'pct1y',  label: '近一年%' },
];

const TH: React.CSSProperties = {
  padding: '10px 10px', fontWeight: 600, fontSize: '.73rem', letterSpacing: '.3px',
  background: '#1C1C1E', color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1, cursor: 'pointer', userSelect: 'none',
};

function perfColor(v: number | null): string {
  if (v === null) return SUB;
  if (v >=  3) return '#b91c1c';
  if (v >=  1) return '#dc2626';
  if (v <= -3) return '#166534';
  if (v <= -1) return '#16a34a';
  return TEXT;
}
function perfBg(v: number | null): string {
  if (v === null) return 'transparent';
  if (v >=  3) return '#fee2e2';
  if (v >=  1) return '#fef2f2';
  if (v <= -3) return '#dcfce7';
  if (v <= -1) return '#f0fdf4';
  return 'transparent';
}
function fmtPct(v: number | null): string {
  if (v === null) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}
function fmtPrice(v: number | null): string {
  if (v === null) return '—';
  // 加入千分位——海外對照組的指數是五位數（如 32,315.96），沒有分隔號很難讀。
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function exportExcel(
  rows: PeerPerfResult[], group: string, dataDate: string,
  appliedRange: { start: string; end: string } | null,
) {
  const customLabel = appliedRange ? [`自訂區間%(${appliedRange.start}→${appliedRange.end})`] : [];
  const headers = ['代號', '名稱', '收盤價', ...customLabel,
    '當日%', '週初至今%', '月初至今%', '年初至今%', '近5日%', '近1月%', '近3月%', '近6月%', '近一年%'];
  const data = rows.map(r => {
    const bad = r.anomalyReason === '無報價' ? '尚無報價' : '數值異常';
    const n = (v: number | null) => r.anomaly ? bad : (v !== null ? parseFloat(v.toFixed(2)) : '');
    const customVal = appliedRange ? [r.anomaly ? bad : (r.pctCustom !== null ? parseFloat(r.pctCustom.toFixed(2)) : '')] : [];
    return [r.ticker, r.name, r.price ?? '', ...customVal,
      n(r.pct1d), n(r.pctWTD), n(r.pctMTD), n(r.pctYTD),
      n(r.pct5d), n(r.pct1m), n(r.pct3m), n(r.pct6m), n(r.pct1y)];
  });
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  ws['!cols'] = [{ wch: 10 }, { wch: 22 }, { wch: 8 }, ...headers.slice(3).map(() => ({ wch: 14 }))];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '同業績效');
  const groupLabel = GROUPS.find(g => g.id === group)?.label ?? group;
  XLSX.writeFile(wb, `同業績效觀測_${groupLabel}_${dataDate || new Date().toISOString().slice(0, 10)}.xlsx`);
}

export default function PeerPerformanceTab() {
  const [group,        setGroup]        = useState('active');
  const [data,         setData]         = useState<PeerPerfResult[] | null>(null);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState('');
  const [asOf,         setAsOf]         = useState('');
  const [dataDate,     setDataDate]     = useState('');
  const [sortKey,      setSortKey]      = useState<SortKey>('pct1d');
  const [sortAsc,      setSortAsc]      = useState(false);
  const [customStart,  setCustomStart]  = useState('');
  const [customEnd,    setCustomEnd]    = useState('');
  const [appliedRange, setAppliedRange] = useState<{ start: string; end: string } | null>(null);

  const switchGroup = (id: string) => {
    setGroup(id);
    setData(null);
    setError('');
    setAsOf('');
    setDataDate('');
    setSortKey('pct1d');
  };

  const load = async (grp = group, range = appliedRange) => {
    setLoading(true); setError(''); setData(null);
    try {
      let url = `/api/peer-performance?group=${grp}`;
      if (range) url += `&startDate=${range.start}&endDate=${range.end}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json: PeerPerfResult[] = await r.json();
      setData(json);
      const ts = json.find(x => x.updatedAt)?.updatedAt;
      if (ts) {
        const d = new Date(new Date(ts).getTime() + 8 * 3600 * 1000);
        setAsOf(`${d.getUTCFullYear()}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`);
      }
      const dd = json.find(x => x.dataDate)?.dataDate;
      if (dd) {
        const [y, m, d] = dd.split('-');
        setDataDate(`${y}/${m}/${d}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      setLoading(false);
    }
  };

  const applyCustomRange = () => {
    if (!customStart || !customEnd) return;
    const range = { start: customStart, end: customEnd };
    setAppliedRange(range);
    load(group, range);
  };

  const clearCustomRange = () => {
    setCustomStart('');
    setCustomEnd('');
    setAppliedRange(null);
    load(group, null);
  };

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc(p => !p);
    else { setSortKey(key); setSortAsc(false); }
  };
  const thLabel = (key: SortKey, label: string) =>
    sortKey === key ? `${label} ${sortAsc ? '↑' : '↓'}` : label;

  const sorted = useMemo(() => {
    if (!data) return [];
    return [...data].sort((a, b) => {
      const av = a[sortKey] as number | null;
      const bv = b[sortKey] as number | null;
      if (av === null && bv === null) return 0;
      if (av === null) return sortAsc ? -1 : 1;
      if (bv === null) return sortAsc ? 1 : -1;
      return sortAsc ? av - bv : bv - av;
    });
  }, [data, sortKey, sortAsc]);

  // Summary row (equal-weight average)
  const avg = useMemo(() => {
    if (!sorted.length) return null;
    const result: Partial<Record<SortKey, number | null>> = {};
    const valid = sorted.filter(r => !r.anomaly && !r.benchmark);   // 數值異常者、對照基準都不納入平均
    for (const col of PERF_COLS) {
      const vals = valid.map(r => r[col.key] as number | null).filter(v => v !== null) as number[];
      result[col.key] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    }
    return result;
  }, [sorted]);

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>
      {/* Group tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {GROUPS.map(g => (
          <button key={g.id} onClick={() => switchGroup(g.id)}
            style={{
              padding: '6px 18px', borderRadius: 20,
              border: `1.5px solid ${group === g.id ? RED : BORDER}`,
              background: group === g.id ? RED : '#fff',
              color: group === g.id ? '#fff' : SUB,
              cursor: 'pointer', fontSize: '.85rem', fontWeight: group === g.id ? 600 : 400,
              fontFamily: SANS,
            }}>
            {g.label}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <button onClick={() => load(group)} disabled={loading}
          style={{ padding: '8px 22px', background: loading ? '#999' : RED, color: '#fff', border: 'none', borderRadius: 6, cursor: loading ? 'not-allowed' : 'pointer', fontSize: '.88rem', fontWeight: 600 }}>
          {loading ? '載入中…' : data ? '重新整理' : '載入'}
        </button>
        {loading && <span style={{ fontSize: '.82rem', color: SUB }}>查詢 Yahoo Finance 中，約需 20–40 秒…</span>}
        {asOf && !loading && <span style={{ fontSize: '.78rem', color: SUB }}>報價截至 {asOf} TST</span>}
        {dataDate && !loading && <span style={{ fontSize: '.78rem', color: SUB }}>區間績效計算至 {dataDate}</span>}
        <span style={{ marginLeft: 'auto', fontSize: '.75rem', color: SUB }}>績效已還原權息　點擊欄位標題排序</span>
        {sorted.length > 0 && !loading && (
          <button
            onClick={() => exportExcel(sorted, group, dataDate, appliedRange)}
            style={{ padding: '6px 16px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, cursor: 'pointer', fontSize: '.8rem', color: SUB, fontFamily: SANS, fontWeight: 500 }}
          >
            ↓ 匯出 Excel
          </button>
        )}
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
          disabled={!customStart || !customEnd || loading}
          style={{
            padding: '6px 16px', background: customStart && customEnd && !loading ? RED : '#ccc',
            color: '#fff', border: 'none', borderRadius: 6,
            cursor: customStart && customEnd && !loading ? 'pointer' : 'not-allowed',
            fontSize: '.82rem', fontWeight: 600,
          }}
        >
          套用
        </button>
        {appliedRange && (
          <button
            onClick={clearCustomRange}
            disabled={loading}
            style={{ padding: '6px 14px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, cursor: 'pointer', fontSize: '.78rem', color: SUB }}
          >
            清除
          </button>
        )}
        {appliedRange && (
          <span style={{ fontSize: '.76rem', color: RED, fontWeight: 600 }}>
            已套用：{appliedRange.start} → {appliedRange.end}
          </span>
        )}
      </div>

      {error && (
        <div style={{ padding: '10px 14px', background: '#fff0f0', border: '1px solid #fca5a5', borderRadius: 6, color: RED, fontSize: '.85rem', marginBottom: 14 }}>
          {error}
        </div>
      )}

      {!data && !loading && (
        <p style={{ color: '#AAA', textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>點擊「載入」查詢同業績效</p>
      )}

      {data && (
        <div className="mt" style={{ overflowX: 'auto', borderRadius: 8, border: `1px solid ${BORDER}` }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 960 }}>
            <thead>
              <tr>
                <th className="m-unstick" onClick={() => toggleSort('ticker')}   style={{ ...TH, textAlign: 'left',  width: 72, position: 'sticky', left: 0, zIndex: 2 }}>{thLabel('ticker',  '代號')}</th>
                <th className="m-stick0" onClick={() => toggleSort('name')}     style={{ ...TH, textAlign: 'left',  minWidth: 100, width: 100, position: 'sticky', left: 72, zIndex: 2 }}>{thLabel('name', '名稱')}</th>
                <th onClick={() => toggleSort('price')}    style={{ ...TH, textAlign: 'right', width: 70  }}>{thLabel('price',  '收盤價')}</th>
                {appliedRange && (
                  <th onClick={() => toggleSort('pctCustom')}
                    style={{ ...TH, textAlign: 'right', width: 110, background: sortKey === 'pctCustom' ? '#7C3030' : '#A03030', whiteSpace: 'normal', lineHeight: 1.3 }}>
                    {thLabel('pctCustom', `自訂區間%`)}<br />
                    <span style={{ fontWeight: 400, fontSize: '.65rem', opacity: .85 }}>{appliedRange.start.slice(5)}→{appliedRange.end.slice(5)}</span>
                  </th>
                )}
                {PERF_COLS.map(c => (
                  <th key={c.key} onClick={() => toggleSort(c.key)}
                    style={{ ...TH, textAlign: 'right', width: 78, background: sortKey === c.key ? '#333' : '#1C1C1E' }}>
                    {thLabel(c.key, c.label)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => {
                const rowBg = i % 2 === 0 ? '#fff' : '#FAFAF9';
                return (
                <tr key={r.ticker} style={{ background: rowBg, borderBottom: `1px solid ${BORDER}` }}>
                  <td className="m-unstick" style={{ padding: '8px 10px', fontFamily: MONO, fontSize: '.8rem', color: SUB, fontWeight: 600, position: 'sticky', left: 0, zIndex: 1, background: rowBg }}>{r.ticker}</td>
                  <td className="m-stick0" style={{ padding: '8px 10px', fontSize: '.83rem', color: TEXT, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 100, position: 'sticky', left: 72, zIndex: 1, background: rowBg }}>{r.name}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', color: TEXT }}>{fmtPrice(r.price)}</td>
                  {r.anomaly ? (
                    <td colSpan={(appliedRange ? 1 : 0) + PERF_COLS.length}
                      title={r.anomalyReason ?? '數值異常'}
                      style={{
                        padding: '8px 10px', textAlign: 'center', fontSize: '.8rem', letterSpacing: '.5px',
                        fontWeight: r.anomalyReason === '無報價' ? 400 : 700,
                        color: r.anomalyReason === '無報價' ? SUB : RED,
                        background: r.anomalyReason === '無報價' ? '#FAFAF9' : '#fff0f0',
                      }}>
                      {r.anomalyReason === '無報價' ? '尚無報價（未掛牌或無成交）' : '⚠ 數值異常'}
                    </td>
                  ) : (
                    <>
                      {appliedRange && (
                        <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', fontWeight: 700, color: perfColor(r.pctCustom), background: perfBg(r.pctCustom) }}>
                          {fmtPct(r.pctCustom)}
                        </td>
                      )}
                      {PERF_COLS.map(c => {
                        const v = r[c.key] as number | null;
                        return (
                          <td key={c.key} style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', fontWeight: 600, color: perfColor(v), background: perfBg(v) }}>
                            {fmtPct(v)}
                          </td>
                        );
                      })}
                    </>
                  )}
                </tr>
                );
              })}
              {/* Average row */}
              {avg && (
                <tr style={{ background: '#F0EDE8', borderTop: `2px solid ${BORDER}` }}>
                  <td colSpan={2} style={{ padding: '8px 10px', fontSize: '.78rem', color: SUB, fontWeight: 600, position: 'sticky', left: 0, zIndex: 1, background: '#F0EDE8' }}>同業等權平均<span style={{ fontWeight: 400 }}>（{sorted.filter(r => !r.benchmark && !r.anomaly).length} 檔）</span></td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontSize: '.78rem', color: SUB }}>—</td>
                  {appliedRange && (() => {
                    const vals = sorted.filter(r => !r.anomaly && !r.benchmark).map(r => r.pctCustom).filter((v): v is number => v !== null);
                    const v = vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null;
                    return (
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.78rem', fontWeight: 700, color: perfColor(v), background: perfBg(v) }}>
                        {fmtPct(v)}
                      </td>
                    );
                  })()}
                  {PERF_COLS.map(c => {
                    const v = avg[c.key] as number | null;
                    return (
                      <td key={c.key} style={{ padding: '8px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.78rem', fontWeight: 600, color: perfColor(v), background: perfBg(v) }}>
                        {fmtPct(v)}
                      </td>
                    );
                  })}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {data && (
        <div style={{ marginTop: 10, fontSize: '.72rem', color: SUB, lineHeight: 1.8 }}>
          資料來源：Yahoo Finance（與 TWSE 即時交叉比對）　週初至今 = 上週五收盤至今　月初至今 = 上月底收盤至今　年初至今 = 去年底收盤至今　近N日為交易日<br />
          美股對照組：<b>NASDAQ綜合</b>與 <b>S&amp;P500</b> 採官方總報酬指數（^XCMP／^SP500TR，<b>已含息</b>）、<b>QQQ</b> 以還原收盤計亦<b>已含配息</b>；<b>費城半導體</b>在 Yahoo 只有價格指數（無含息版），故為<b>價格報酬</b>、與其餘欄位口徑略有差異。美股交易日與台股不同，資料日可能相差一日。<br />
          <span style={{ color: RED }}>⚠ 數值異常</span> = 收盤後 Yahoo 仍缺最新交易日報價，績效不可信，已自動排除於等權平均　<b>尚無報價</b> = 該檔尚未掛牌或查無成交，同樣不納入平均<br />
          <b>同業等權平均</b>只計入互為競爭品項的標的；本組不納入的對照基準：{
            sorted.filter(r => r.benchmark).map(r => r.ticker).join('、') || '（無）'
          }
        </div>
      )}
    </div>
  );
}
