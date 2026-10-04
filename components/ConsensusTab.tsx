'use client';
import { useState, useMemo, useEffect, useCallback } from 'react';
import * as XLSX from 'xlsx';

/* 共識持股 / 獨家壓注：全 19 檔主動式 ETF 最新持股橫向統計。 */

const RED    = '#C00000';
const GOLD   = '#9a6a33';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

interface ConsensusHolder { ticker: string; w: number }
interface ConsensusStock {
  stockid: string; stockname: string; heldBy: number; holders: ConsensusHolder[];
  sumWeight: number; avgWeight: number; maxWeight: number; maxHolder: string;
}
interface ConsensusFund {
  ticker: string; name: string; holdingDate: string | null; nHoldings: number; nSolo: number;
  navProxy: number | null; priceCoverage: number;
}
interface ConsensusResult { asOf: string; nFunds: number; funds: ConsensusFund[]; stocks: ConsensusStock[] }

type Mode = 'consensus' | 'solo';
type SortKey = 'heldBy' | 'sumWeight' | 'avgWeight';
const COLS: { key: SortKey; label: string }[] = [
  { key: 'heldBy',    label: '持有檔數' },
  { key: 'sumWeight', label: '合計權重' },
  { key: 'avgWeight', label: '平均權重' },
];

function num(v: number, d = 2): string { return v.toFixed(d); }

const TH: React.CSSProperties = {
  padding: '9px 10px', fontWeight: 600, fontSize: '.74rem', background: '#1C1C1E', color: '#fff',
  whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1, cursor: 'pointer', userSelect: 'none',
};
const miniBtn: React.CSSProperties = {
  padding: '5px 14px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6,
  cursor: 'pointer', fontSize: '.78rem', color: SUB, fontFamily: SANS, fontWeight: 500,
};

export default function ConsensusTab() {
  const [data,    setData]    = useState<ConsensusResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [mode,    setMode]    = useState<Mode>('consensus');
  const [sortKey, setSortKey] = useState<SortKey>('heldBy');
  const [sortAsc, setSortAsc] = useState(false);
  const [query,   setQuery]   = useState('');
  const [funds,   setFunds]   = useState<string[]>([]);   // 複選＝交集：只看「全部選取者都持有」的個股

  const load = useCallback(async () => {
    setLoading(true); setError(''); setData(null);
    try {
      const r = await fetch('/api/consensus');
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
      setData(json as ConsensusResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    if (!data) return [];
    let xs = data.stocks;
    if (mode === 'solo') xs = xs.filter(s => s.heldBy === 1);
    if (funds.length) xs = xs.filter(s => funds.every(t => s.holders.some(h => h.ticker === t)));
    if (query.trim()) {
      const q = query.trim();
      xs = xs.filter(s => s.stockid.includes(q) || s.stockname.includes(q) || s.holders.some(h => h.ticker.includes(q)));
    }
    return [...xs].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      return sortAsc ? av - bv : bv - av;
    });
  }, [data, mode, funds, query, sortKey, sortAsc]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortAsc(p => !p);
    else { setSortKey(k); setSortAsc(false); }
  };

  const toggleFund = (t: string) =>
    setFunds(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);

  const exportExcel = () => {
    if (!data) return;
    const headers = ['代碼', '名稱', '持有檔數', '合計權重%', '平均權重%', '持有清單(含權重%)'];
    const body = rows.map(s => [s.stockid, s.stockname, s.heldBy, s.sumWeight.toFixed(2), s.avgWeight.toFixed(2),
      [...s.holders].sort((a, b) => b.w - a.w).map(h => `${h.ticker} ${h.w.toFixed(2)}%`).join('、')]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...body]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, mode === 'solo' ? '獨家壓注' : '共識持股');
    XLSX.writeFile(wb, `共識持股_${data.asOf}${funds.length ? '_' + funds.join('+') : ''}.xlsx`);
  };

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        {/* 模式切換 */}
        <div style={{ display: 'inline-flex', border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden' }}>
          {([['consensus', '共識持股'], ['solo', '獨家壓注']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setMode(k)}
              style={{ padding: '7px 16px', border: 'none', cursor: 'pointer', fontFamily: SANS, fontSize: '.83rem',
                fontWeight: mode === k ? 700 : 500, background: mode === k ? RED : '#fff', color: mode === k ? '#fff' : SUB }}>
              {label}
            </button>
          ))}
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜尋代碼/名稱/ETF"
          style={{ padding: '6px 12px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.85rem', fontFamily: SANS, color: TEXT, width: 180 }} />
        <button onClick={load} disabled={loading} style={miniBtn}>{loading ? '載入中…' : '↻ 重新整理'}</button>
        {data && !loading && <button onClick={exportExcel} style={{ ...miniBtn, marginLeft: 'auto' }}>↓ 匯出 Excel</button>}
      </div>
      {/* 持有者篩選（可複選＝交集） */}
      {data && !loading && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: '.74rem', color: SUB, fontWeight: 600, marginRight: 2 }}>持有者篩選（可複選＝交集）</span>
          {[...data.funds].sort((a, b) => a.ticker.localeCompare(b.ticker)).map(f => {
            const on = funds.includes(f.ticker);
            return (
              <button key={f.ticker} onClick={() => toggleFund(f.ticker)}
                style={{ padding: '3px 10px', borderRadius: 12, cursor: 'pointer', fontFamily: MONO, fontSize: '.72rem',
                  fontWeight: on ? 700 : 500, border: on ? `1px solid ${RED}` : `1px solid ${BORDER}`,
                  background: on ? RED : '#fff', color: on ? '#fff' : SUB }}>
                {f.ticker}
              </button>
            );
          })}
          {funds.length > 0 && (
            <button onClick={() => setFunds([])} style={{ ...miniBtn, padding: '3px 10px', fontSize: '.72rem', borderRadius: 12 }}>✕ 清除</button>
          )}
          {funds.length > 0 && (
            <span style={{ fontSize: '.74rem', color: RED, fontWeight: 600 }}>
              {funds.join('＋')} 都持有：{rows.length} 檔
            </span>
          )}
        </div>
      )}
      <p style={{ fontSize: '.74rem', color: SUB, margin: '0 0 14px' }}>
        {mode === 'consensus'
          ? '被越多檔主動式 ETF 同時持有＝市場共識(crowding)；可看出哪些是主動經理人的「共同信仰」。'
          : '只被 1 檔 ETF 持有＝該檔經理人的獨家壓注(差異化 alpha 來源)。'}
      </p>

      {loading && <p style={{ color: SUB, textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>彙整全市場最新持股中，約需 10–30 秒…</p>}
      {error && (
        <div style={{ padding: '10px 14px', background: '#fff0f0', border: '1px solid #fca5a5', borderRadius: 6, color: RED, fontSize: '.85rem', marginBottom: 12 }}>{error}</div>
      )}

      {data && !loading && (
        <>
          <div className="mt" style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '60vh', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead>
                <tr>
                  <th className="m-unstick" style={{ ...TH, textAlign: 'left', cursor: 'default', width: 72, position: 'sticky', left: 0, zIndex: 2 }}>代碼</th>
                  <th className="m-stick0" style={{ ...TH, textAlign: 'left', cursor: 'default', position: 'sticky', left: 72, zIndex: 2 }}>名稱</th>
                  {COLS.map(c => (
                    <th key={c.key} onClick={() => toggleSort(c.key)}
                      style={{ ...TH, textAlign: 'right', background: sortKey === c.key ? '#333' : '#1C1C1E' }}>
                      {c.label}{sortKey === c.key ? (sortAsc ? ' ↑' : ' ↓') : ''}
                    </th>
                  ))}
                  <th style={{ ...TH, textAlign: 'left', cursor: 'default' }}>{mode === 'solo' ? '持有者' : '前三大持有者（懸停看全部）'}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s, i) => {
                  const rowBg = i % 2 === 0 ? '#fff' : '#FAFAF9';
                  return (
                  <tr key={s.stockid} style={{ background: rowBg, borderBottom: `1px solid ${BORDER}` }}>
                    <td className="m-unstick" style={{ padding: '7px 10px', fontFamily: MONO, fontSize: '.8rem', color: TEXT, fontWeight: 600, position: 'sticky', left: 0, zIndex: 1, background: rowBg }}>{s.stockid}</td>
                    <td className="m-stick0" style={{ padding: '7px 10px', fontSize: '.82rem', color: TEXT, whiteSpace: 'nowrap', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', position: 'sticky', left: 72, zIndex: 1, background: rowBg }}>{s.stockname}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.84rem', fontWeight: 700, color: s.heldBy >= 5 ? RED : s.heldBy === 1 ? GOLD : TEXT }}>{s.heldBy}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>{num(s.sumWeight)}%</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>{num(s.avgWeight)}%</td>
                    <td style={{ padding: '7px 10px', fontFamily: MONO, fontSize: '.74rem', color: SUB, whiteSpace: 'nowrap' }}
                      title={[...s.holders].sort((a, b) => b.w - a.w).map(h => `${h.ticker} ${num(h.w)}%`).join('、')}>
                      {(() => {
                        const sorted = [...s.holders].sort((a, b) => b.w - a.w);
                        const top = sorted.slice(0, 3);
                        const extra = sorted.filter(h => funds.includes(h.ticker) && !top.some(t => t.ticker === h.ticker));
                        const shown = [...top, ...extra];
                        const rest = s.heldBy - shown.length;
                        return (
                          <>
                            {shown.map((h, j) => (
                              <span key={h.ticker}>
                                {j > 0 && <span style={{ color: '#D0CBC6' }}>・</span>}
                                <span style={{ color: funds.includes(h.ticker) ? RED : TEXT, fontWeight: funds.includes(h.ticker) ? 700 : 500 }}>
                                  {h.ticker}
                                </span>
                                <span style={{ color: SUB }}> {num(h.w, 1)}%</span>
                              </span>
                            ))}
                            {rest > 0 && <span style={{ color: '#B0AAA4' }}> +{rest}</span>}
                          </>
                        );
                      })()}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 各檔獨家壓注數 */}
          {mode === 'solo' && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: '.78rem', color: SUB, fontWeight: 600, marginBottom: 6 }}>各檔獨家壓注檔數（只有它持有）</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {[...data.funds].sort((a, b) => b.nSolo - a.nSolo).map(f => (
                  <span key={f.ticker} style={{ fontSize: '.74rem', fontFamily: MONO, padding: '3px 10px', borderRadius: 12, background: '#FAF6EF', border: `1px solid #EADFcf`, color: TEXT }}>
                    {f.ticker} <b style={{ color: GOLD }}>{f.nSolo}</b>/{f.nHoldings}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 12, fontSize: '.72rem', color: SUB, lineHeight: 1.9 }}>
            資料 as-of <b>{data.asOf}</b>，涵蓋 <b>{data.nFunds}</b> 檔台股主動式 ETF（各取自身最新持股快照）。<br />
            <b>持有檔數</b>＝同時持有該股的 ETF 數（≥5 標紅＝高度共識；=1 標金＝獨家壓注）　<b>合計權重</b>＝各持有者佔比加總　<b>持有者欄</b>＝佔比前三大（篩選中的基金若不在前三會標紅補列）。<br />
            資料源＝共用 Supabase 每日全量持股快照（已濾現金/期貨類）。權重為各 ETF 申報佔比。
          </div>
        </>
      )}
    </div>
  );
}
