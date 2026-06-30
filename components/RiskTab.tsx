'use client';
import { useState, useMemo, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { PEER_GROUPS } from '@/lib/peerGroups';

/* 風險與風險調整後報酬：年化波動、最大回撤(MDD)、Beta、夏普、資訊比率(IR)。
   以 Yahoo 還原收盤(含息)日報酬計算，Beta/IR 相對所選基準(預設 0050)。
   台股配色：報酬 紅漲綠跌；風險欄位中性深灰。 */

const RED    = '#C00000';
const GREEN  = '#1a7f37';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

const GROUPS = [
  { id: 'active',   label: '台股主動式ETF' },
  { id: 'overseas', label: '海外主動式ETF' },
  { id: 'tw50',     label: '台股50' },
];
const BENCHMARKS = [
  { ticker: '0050',  label: '0050 元大台灣50' },
  { ticker: '^TWII', label: '加權指數 ^TWII' },
];

interface RiskRow {
  ticker: string; name: string; nDays: number;
  firstDate: string | null; lastDate: string | null;
  totalReturn: number | null; annReturn: number | null; annVol: number | null;
  mdd: number | null; beta: number | null; sharpe: number | null; ir: number | null; corr: number | null;
}
interface RiskResult {
  start: string; end: string;
  benchmark: { ticker: string; name: string }; rf: number;
  rows: RiskRow[];
}

type SortKey = 'totalReturn' | 'annReturn' | 'annVol' | 'mdd' | 'beta' | 'sharpe' | 'ir' | 'corr';
const COLS: { key: SortKey; label: string; kind: 'ret' | 'risk' }[] = [
  { key: 'totalReturn', label: '區間總報酬', kind: 'ret' },
  { key: 'annReturn',   label: '年化報酬',   kind: 'ret' },
  { key: 'annVol',      label: '年化波動',   kind: 'risk' },
  { key: 'mdd',         label: '最大回撤',   kind: 'risk' },
  { key: 'beta',        label: 'Beta',       kind: 'risk' },
  { key: 'sharpe',      label: '夏普',       kind: 'risk' },
  { key: 'ir',          label: '資訊比率',   kind: 'risk' },
  { key: 'corr',        label: '相關係數',   kind: 'risk' },
];

function todayTW(): string {
  const tw = new Date(Date.now() + 8 * 3600 * 1000);
  return `${tw.getUTCFullYear()}-${String(tw.getUTCMonth() + 1).padStart(2, '0')}-${String(tw.getUTCDate()).padStart(2, '0')}`;
}
function prevYearEnd(): string {
  const y = new Date(Date.now() + 8 * 3600 * 1000).getUTCFullYear() - 1;
  const d = new Date(Date.UTC(y, 11, 31));
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  else if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function pct(v: number | null, d = 1): string { return v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`; }
function num(v: number | null, d = 2): string { return v == null ? '—' : v.toFixed(d); }
function retColor(v: number | null): string { return v == null ? SUB : v > 0 ? RED : v < 0 ? GREEN : TEXT; }
function daysAfter(a: string, b: string): number { return (new Date(b).getTime() - new Date(a).getTime()) / 86400000; }
function mmdd(d: string | null): string { return d ? d.slice(5) : '—'; }

const TH: React.CSSProperties = {
  padding: '9px 10px', fontWeight: 600, fontSize: '.73rem', letterSpacing: '.3px',
  background: '#1C1C1E', color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1, cursor: 'pointer', userSelect: 'none',
};
const miniBtn: React.CSSProperties = {
  padding: '5px 14px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6,
  cursor: 'pointer', fontSize: '.78rem', color: SUB, fontFamily: SANS, fontWeight: 500,
};
const dateInput: React.CSSProperties = {
  padding: '6px 10px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.85rem', fontFamily: MONO, color: TEXT,
};

export default function RiskTab() {
  const [group,     setGroup]     = useState('active');
  const [selected,  setSelected]  = useState<string[]>([]);
  const [benchmark, setBenchmark] = useState('0050');
  const [start,     setStart]     = useState(prevYearEnd());
  const [end,       setEnd]       = useState(todayTW());
  const [data,      setData]      = useState<RiskResult | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');
  const [sortKey,   setSortKey]   = useState<SortKey>('sharpe');
  const [sortAsc,   setSortAsc]   = useState(false);
  const [excludeIncomplete, setExcludeIncomplete] = useState(true);   // 預設排除掛牌未滿區間，較公平

  const items = PEER_GROUPS[group].items.filter(i => i.ticker !== '^TWOII');

  const switchGroup = (id: string) => { setGroup(id); setSelected([]); setData(null); setError(''); };
  const toggle = (t: string) => setSelected(p => p.includes(t) ? p.filter(x => x !== t) : [...p, t]);
  const selectAll = () => setSelected(items.filter(i => i.ticker !== benchmark && i.ticker !== '^TWII').map(i => i.ticker));
  const clearSel = () => setSelected([]);

  const load = useCallback(async () => {
    if (!selected.length) { setError('請至少勾選一檔商品'); return; }
    if (start > end) { setError('起始日不可晚於結束日'); return; }
    setLoading(true); setError(''); setData(null);
    try {
      const url = `/api/risk?group=${group}&tickers=${encodeURIComponent(selected.join(','))}&benchmark=${encodeURIComponent(benchmark)}&startDate=${start}&endDate=${end}`;
      const r = await fetch(url);
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
      setData(json as RiskResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      setLoading(false);
    }
  }, [selected, benchmark, start, end, group]);

  // 掛牌未滿區間：首個有資料日比同批最早者晚超過 7 天 → 視為涵蓋不足，不宜與全程基金直接比較
  const incompleteInfo = useMemo(() => {
    const set = new Set<string>();
    if (!data) return { set, minFirst: null as string | null };
    const firsts = data.rows.map(r => r.firstDate).filter((d): d is string => !!d);
    if (!firsts.length) return { set, minFirst: null };
    const minFirst = firsts.reduce((m, d) => (d < m ? d : m), firsts[0]);
    for (const r of data.rows) if (r.firstDate && daysAfter(minFirst, r.firstDate) > 7) set.add(r.ticker);
    return { set, minFirst };
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
    const headers = ['代碼', '名稱', '起算日', '交易日', '區間總報酬%', '年化報酬%', '年化波動%', '最大回撤%', 'Beta', '夏普', '資訊比率', '相關係數'];
    const rows = sorted.map(r => [
      r.ticker, r.name, r.firstDate ?? '', r.nDays,
      r.totalReturn?.toFixed(2) ?? '', r.annReturn?.toFixed(2) ?? '', r.annVol?.toFixed(2) ?? '',
      r.mdd?.toFixed(2) ?? '', r.beta?.toFixed(3) ?? '', r.sharpe?.toFixed(3) ?? '', r.ir?.toFixed(3) ?? '', r.corr?.toFixed(3) ?? '',
    ]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '風險指標');
    XLSX.writeFile(wb, `風險指標_${benchmark}_${start}_${end}.xlsx`);
  };

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>
      {/* 群組 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {GROUPS.map(g => (
          <button key={g.id} onClick={() => switchGroup(g.id)}
            style={{ padding: '6px 18px', borderRadius: 20, border: `1.5px solid ${group === g.id ? RED : BORDER}`,
              background: group === g.id ? RED : '#fff', color: group === g.id ? '#fff' : SUB,
              cursor: 'pointer', fontSize: '.85rem', fontWeight: group === g.id ? 600 : 400, fontFamily: SANS }}>
            {g.label}
          </button>
        ))}
      </div>

      {/* 商品勾選 */}
      <div style={{ border: `1px solid ${BORDER}`, borderRadius: 8, padding: '12px 14px', marginBottom: 12, background: '#FAFAF9' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: '.8rem', color: SUB, fontWeight: 600 }}>選擇商品（可複選）</span>
          <button onClick={selectAll} style={miniBtn}>全選</button>
          <button onClick={clearSel} style={miniBtn}>清除</button>
          <span style={{ marginLeft: 'auto', fontSize: '.76rem', color: SUB }}>已選 {selected.length} 檔</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 6 }}>
          {items.map(it => {
            const on = selected.includes(it.ticker);
            return (
              <label key={it.ticker} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px',
                borderRadius: 6, background: on ? '#fff' : 'transparent', border: `1px solid ${on ? BORDER : 'transparent'}`, cursor: 'pointer' }}>
                <input type="checkbox" checked={on} onChange={() => toggle(it.ticker)} style={{ cursor: 'pointer' }} />
                <span style={{ fontSize: '.78rem', color: on ? TEXT : SUB, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <span style={{ fontFamily: MONO }}>{it.ticker}</span> {it.name}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* 基準 + 區間 + 動作 */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={{ fontSize: '.8rem', color: SUB }}>基準</label>
        <select value={benchmark} onChange={e => setBenchmark(e.target.value)}
          style={{ padding: '6px 10px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.85rem', fontFamily: SANS, color: TEXT, background: '#fff' }}>
          {BENCHMARKS.map(b => <option key={b.ticker} value={b.ticker}>{b.label}</option>)}
        </select>
        <label style={{ fontSize: '.8rem', color: SUB }}>區間</label>
        <input type="date" value={start} max={end} onChange={e => setStart(e.target.value)} style={dateInput} />
        <span style={{ color: SUB }}>至</span>
        <input type="date" value={end} min={start} onChange={e => setEnd(e.target.value)} style={dateInput} />
        <button onClick={load} disabled={loading}
          style={{ padding: '8px 22px', background: loading ? '#999' : RED, color: '#fff', border: 'none', borderRadius: 6, cursor: loading ? 'not-allowed' : 'pointer', fontSize: '.88rem', fontWeight: 600 }}>
          {loading ? '計算中…' : '計算'}
        </button>
        {loading && <span style={{ fontSize: '.8rem', color: SUB }}>查詢 Yahoo Finance 並計算中，約需 15–40 秒…</span>}
        {data && !loading && <button onClick={exportExcel} style={{ ...miniBtn, marginLeft: 'auto' }}>↓ 匯出 Excel</button>}
      </div>

      {error && (
        <div style={{ padding: '10px 14px', background: '#fff0f0', border: '1px solid #fca5a5', borderRadius: 6, color: RED, fontSize: '.85rem', marginBottom: 12 }}>{error}</div>
      )}

      {!data && !loading && (
        <p style={{ color: '#AAA', textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>勾選商品、基準與區間後點「計算」</p>
      )}

      {data && data.rows.length > 0 && (
        <>
          {/* 掛牌覆蓋控制：排除在區間初期尚未掛牌的基金，避免短樣本與全程基金不公平比較 */}
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
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 880 }}>
              <thead>
                <tr>
                  <th style={{ ...TH, textAlign: 'left', cursor: 'default' }}>代碼</th>
                  <th style={{ ...TH, textAlign: 'left', cursor: 'default' }}>名稱</th>
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
                {sorted.map((r, i) => (
                  <tr key={r.ticker} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAF9', borderBottom: `1px solid ${BORDER}` }}>
                    <td style={{ padding: '7px 10px', fontFamily: MONO, fontSize: '.8rem', color: TEXT, fontWeight: 600 }}>{r.ticker}</td>
                    <td style={{ padding: '7px 10px', fontSize: '.82rem', color: TEXT, whiteSpace: 'nowrap' }}>{r.name}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'center', fontFamily: MONO, fontSize: '.76rem', color: incompleteInfo.set.has(r.ticker) ? '#92620A' : SUB, whiteSpace: 'nowrap' }}>
                      {incompleteInfo.set.has(r.ticker) ? '⚠ ' : ''}{mmdd(r.firstDate)}
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', fontWeight: 700, color: retColor(r.totalReturn) }}>{pct(r.totalReturn)}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', fontWeight: 600, color: retColor(r.annReturn) }}>{pct(r.annReturn)}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>{pct(r.annVol)}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: GREEN }}>{pct(r.mdd)}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>{num(r.beta)}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', fontWeight: 600, color: TEXT }}>{num(r.sharpe)}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', fontWeight: 600, color: retColor(r.ir) }}>{num(r.ir)}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>{num(r.corr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 12, fontSize: '.72rem', color: SUB, lineHeight: 1.9 }}>
            區間 <b>{data.start} ～ {data.end}</b>，基準＝<b>{data.benchmark.name}（{data.benchmark.ticker}）</b>，無風險利率＝{(data.rf * 100).toFixed(1)}%。以 Yahoo 還原收盤（含息）日報酬計算，僅取基金與基準皆有交易的共同日。<br />
            <b>年化波動</b>＝日報酬標準差×√252　<b>最大回撤(MDD)</b>＝期間相對前高的最大跌幅　<b>Beta</b>＝相對基準的系統性風險（&gt;1 比基準更敏感）<br />
            <b>夏普</b>＝(年化報酬−無風險利率)÷年化波動，越高代表每單位總風險的報酬越好　<b>資訊比率(IR)</b>＝相對基準的主動報酬÷追蹤誤差，&gt;0 代表risk-adjusted 贏過基準、是「真 alpha」的指標　<b>相關係數</b>＝與基準的連動程度<br />
            <b>起算日</b>＝該基金在區間內首個有資料日；若晚於區間起點(同批最早者+7天)代表<u>掛牌未滿整個區間</u>，會以 ⚠ 標示，預設排除以免短樣本與全程基金不公平比較（可取消勾選納回）。<br />
            注意：年化數字在區間 &lt; 1 年時為外推估計，樣本期間越短越不穩定，僅供相對比較。
          </div>
        </>
      )}
    </div>
  );
}
