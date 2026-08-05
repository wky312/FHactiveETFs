'use client';
import { useState, useMemo, useCallback } from 'react';
import * as XLSX from 'xlsx';

/* 經理人換手率（周轉率）：每日持股快照差分估算，比較哪家頻繁擇時、哪家買進持有。 */

const RED    = '#C00000';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

interface TurnoverRow {
  ticker: string; name: string; issuer: string; holdingDate: string | null;
  firstDate: string | null;
  nSnapshots: number; spanDays: number;
  avgAumE: number | null; buyValueE: number | null; sellValueE: number | null;
  turnoverPeriod: number | null; turnoverAnnual: number | null;
}
interface TurnoverResult { startDate: string; endDate: string; rows: TurnoverRow[] }

type SortKey = 'turnoverAnnual' | 'turnoverPeriod' | 'avgAumE' | 'buyValueE' | 'sellValueE' | 'nSnapshots';
const COLS: { key: SortKey; label: string }[] = [
  { key: 'turnoverAnnual', label: '年化換手率' },
  { key: 'turnoverPeriod', label: '期間換手率' },
  { key: 'avgAumE',        label: '平均AUM(億)' },
  { key: 'buyValueE',      label: '買進(億)' },
  { key: 'sellValueE',     label: '賣出(億)' },
  { key: 'nSnapshots',     label: '快照數' },
];

function daysAgo(n: number): string {
  const tw = new Date(Date.now() + 8 * 3600 * 1000 - n * 86400000);
  return `${tw.getUTCFullYear()}-${String(tw.getUTCMonth() + 1).padStart(2, '0')}-${String(tw.getUTCDate()).padStart(2, '0')}`;
}
function today(): string { return daysAgo(0); }
function pct(v: number | null, d = 0): string { return v == null ? '—' : `${v.toFixed(d)}%`; }
function num(v: number | null, d = 2): string { return v == null ? '—' : v.toFixed(d); }
function daysAfter(a: string, b: string): number { return (new Date(b).getTime() - new Date(a).getTime()) / 86400000; }
function mmdd(d: string | null): string { return d ? d.slice(5) : '—'; }

const TH: React.CSSProperties = {
  padding: '9px 10px', fontWeight: 600, fontSize: '.74rem', background: '#1C1C1E', color: '#fff',
  whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1, cursor: 'pointer', userSelect: 'none',
};
const miniBtn: React.CSSProperties = {
  padding: '5px 14px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6,
  cursor: 'pointer', fontSize: '.78rem', color: SUB, fontFamily: SANS, fontWeight: 500,
};
const dateInput: React.CSSProperties = {
  padding: '6px 10px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.85rem', fontFamily: MONO, color: TEXT,
};

export default function TurnoverTab() {
  const [start,   setStart]   = useState(daysAgo(90));
  const [end,     setEnd]     = useState(today());
  const [data,    setData]    = useState<TurnoverResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('turnoverAnnual');
  const [sortAsc, setSortAsc] = useState(false);
  const [excludeIncomplete, setExcludeIncomplete] = useState(true);   // 預設排除掛牌未滿區間，較公平

  const load = useCallback(async () => {
    if (start > end) { setError('起始日不可晚於結束日'); return; }
    setLoading(true); setError(''); setData(null);
    try {
      const r = await fetch(`/api/turnover?from=${start}&to=${end}`);
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
      setData(json as TurnoverResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      setLoading(false);
    }
  }, [start, end]);

  // 掛牌未滿區間：首個持股快照日比同批最早者晚超過 7 天 → 觀測窗短，不宜與全程基金直接比較
  const incompleteInfo = useMemo(() => {
    const set = new Set<string>();
    if (!data) return { set };
    const firsts = data.rows.map(r => r.firstDate).filter((d): d is string => !!d);
    if (!firsts.length) return { set };
    const minFirst = firsts.reduce((m, d) => (d < m ? d : m), firsts[0]);
    for (const r of data.rows) if (r.firstDate && daysAfter(minFirst, r.firstDate) > 7) set.add(r.ticker);
    return { set };
  }, [data]);

  const sorted = useMemo(() => {
    if (!data) return [];
    let xs = data.rows;
    if (excludeIncomplete) xs = xs.filter(r => !incompleteInfo.set.has(r.ticker));
    return [...xs].sort((a, b) => {
      const av = a[sortKey] ?? -Infinity, bv = b[sortKey] ?? -Infinity;
      return sortAsc ? av - bv : bv - av;
    });
  }, [data, sortKey, sortAsc, excludeIncomplete, incompleteInfo]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortAsc(p => !p);
    else { setSortKey(k); setSortAsc(false); }
  };

  const exportExcel = () => {
    if (!data) return;
    const headers = ['代碼', '名稱', '發行商', '起算日', '持股日', '年化換手率%', '期間換手率%', '平均AUM(億)', '買進(億)', '賣出(億)', '快照數', '天數'];
    const rows = sorted.map(r => [
      r.ticker, r.name, r.issuer, r.firstDate ?? '', r.holdingDate ?? '',
      r.turnoverAnnual?.toFixed(1) ?? '', r.turnoverPeriod?.toFixed(1) ?? '',
      r.avgAumE?.toFixed(2) ?? '', r.buyValueE?.toFixed(2) ?? '', r.sellValueE?.toFixed(2) ?? '',
      r.nSnapshots, r.spanDays,
    ]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '換手率');
    XLSX.writeFile(wb, `經理人換手率_${start}_${end}.xlsx`);
  };

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <label style={{ fontSize: '.8rem', color: SUB }}>區間</label>
        <input type="date" value={start} max={end} onChange={e => setStart(e.target.value)} style={dateInput} />
        <span style={{ color: SUB }}>至</span>
        <input type="date" value={end} min={start} onChange={e => setEnd(e.target.value)} style={dateInput} />
        <button onClick={load} disabled={loading}
          style={{ padding: '8px 22px', background: loading ? '#999' : RED, color: '#fff', border: 'none', borderRadius: 6, cursor: loading ? 'not-allowed' : 'pointer', fontSize: '.88rem', fontWeight: 600 }}>
          {loading ? '計算中…' : '計算'}
        </button>
        {loading && <span style={{ fontSize: '.8rem', color: SUB }}>差分每日持股快照中，約需 20–60 秒…</span>}
        {data && !loading && <button onClick={exportExcel} style={{ ...miniBtn, marginLeft: 'auto' }}>↓ 匯出 Excel</button>}
      </div>
      <p style={{ fontSize: '.74rem', color: SUB, margin: '0 0 16px' }}>
        以每日持股快照差分估算各檔經理人的換手率（周轉率）。<b>高換手</b>＝頻繁擇時/調倉；<b>低換手</b>＝買進持有。
      </p>

      {error && (
        <div style={{ padding: '10px 14px', background: '#fff0f0', border: '1px solid #fca5a5', borderRadius: 6, color: RED, fontSize: '.85rem', marginBottom: 12 }}>{error}</div>
      )}

      {!data && !loading && !error && (
        <p style={{ color: '#AAA', textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>選擇區間後點「計算」</p>
      )}

      {data && data.rows.length > 0 && (
        <>
          {/* 掛牌覆蓋控制：排除在區間初期尚未掛牌的基金 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.8rem', color: TEXT, cursor: 'pointer' }}>
              <input type="checkbox" checked={excludeIncomplete} onChange={e => setExcludeIncomplete(e.target.checked)} style={{ cursor: 'pointer' }} />
              排除掛牌未滿區間的基金
            </label>
            {incompleteInfo.set.size > 0 && (
              <span style={{ fontSize: '.76rem', color: '#92620A', background: '#FFF6E5', border: '1px solid #F2D98A', borderRadius: 12, padding: '3px 10px' }}>
                {excludeIncomplete
                  ? `已排除 ${incompleteInfo.set.size} 檔（掛牌晚於區間起點）`
                  : `${incompleteInfo.set.size} 檔掛牌晚於區間起點，⚠ 標示`}
              </span>
            )}
          </div>
          <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '62vh', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
              <thead>
                <tr>
                  <th style={{ ...TH, textAlign: 'left', cursor: 'default', width: 76, position: 'sticky', left: 0, zIndex: 2 }}>代碼</th>
                  <th style={{ ...TH, textAlign: 'left', cursor: 'default', position: 'sticky', left: 76, zIndex: 2 }}>名稱</th>
                  <th style={{ ...TH, textAlign: 'center', cursor: 'default' }}>起算日</th>
                  {COLS.map(c => (
                    <th key={c.key} onClick={() => toggleSort(c.key)}
                      style={{ ...TH, textAlign: 'right', background: sortKey === c.key ? '#333' : '#1C1C1E' }}>
                      {c.label}{sortKey === c.key ? (sortAsc ? ' ↑' : ' ↓') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => {
                  const rowBg = i % 2 === 0 ? '#fff' : '#FAFAF9';
                  return (
                  <tr key={r.ticker} style={{ background: rowBg, borderBottom: `1px solid ${BORDER}` }}>
                    <td style={{ padding: '7px 10px', fontFamily: MONO, fontSize: '.8rem', color: TEXT, fontWeight: 600, position: 'sticky', left: 0, zIndex: 1, background: rowBg }}>{r.ticker}</td>
                    <td style={{ padding: '7px 10px', fontSize: '.82rem', color: TEXT, whiteSpace: 'nowrap', position: 'sticky', left: 76, zIndex: 1, background: rowBg }}>{r.name}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'center', fontFamily: MONO, fontSize: '.76rem', color: incompleteInfo.set.has(r.ticker) ? '#92620A' : SUB, whiteSpace: 'nowrap' }}>
                      {incompleteInfo.set.has(r.ticker) ? '⚠ ' : ''}{mmdd(r.firstDate)}
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', fontWeight: 700, color: RED }}>{pct(r.turnoverAnnual)}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>{pct(r.turnoverPeriod)}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>{num(r.avgAumE)}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>{num(r.buyValueE)}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>{num(r.sellValueE)}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>{r.nSnapshots}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 12, fontSize: '.72rem', color: SUB, lineHeight: 1.9 }}>
            區間 <b>{data.startDate} ～ {data.endDate}</b>。<b>期間換手率</b>＝min(總買進, 總賣出) ÷ 平均AUM（SEC 周轉率口徑，取買賣較小邊，排除純申購/贖回造成的單邊變動）；<b>年化換手率</b>＝期間換手率 × (365 ÷ 觀測天數)。<br />
            買進/賣出金額＝相鄰持股快照逐日差分的股數變化 × 當日成交均價(缺則收盤)。資料源＝共用 Supabase 每日全量持股快照。<br />
            <b>起算日</b>＝該基金在區間內首個持股快照日；若晚於區間起點(同批最早者+7天)代表<u>掛牌未滿整個區間</u>，以 ⚠ 標示，預設排除以免短觀測窗與全程基金不公平比較（可取消勾選納回）。<br />
            注意：為持股股數差分之<u>估算</u>，未能完全區分「主動調倉」與「申贖連動的等比例增減」；區間越短年化外推越不穩定，僅供相對比較。
          </div>
        </>
      )}
    </div>
  );
}
