'use client';
import { useState, useMemo, useEffect, useCallback } from 'react';
import * as XLSX from 'xlsx';

/* 2025/12/31 市值前300大，追蹤至今還原權息報酬 + 市值排名變化。
   Tier1(排名1-150)＝00991A選股池對應區間；Tier2(151-300)＝新產品差異化區間。 */

const RED    = '#C00000';   // 台灣慣例：漲＝紅
const GREEN  = '#188A4E';   // 跌＝綠
const TIER1  = '#2F5FA8';
const TIER2  = '#9a6a33';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

interface Row {
  code: string; name: string; market: '上市' | '上櫃';
  closeBase: number; closeLatest: number;
  adjBasePrice: number; adjLatestPrice: number;
  pct: number; pctAdjusted: boolean;
  mktcapLatest: number; rankBase: number; rankLatest: number; rankChange: number;
}
interface TierStats { count: number; avgPct: number; medianPct: number; upCount: number; droppedOut: number }
interface ApiResult { baseDate: string; latestDate: string; tier1: TierStats; tier2: TierStats; rows: Row[] }

type SortKey = 'rankBase' | 'closeBase' | 'adjLatestPrice' | 'pct' | 'mktcapLatest' | 'rankLatest' | 'rankChange';
type MarketFilter = 'all' | '上市' | '上櫃';
type TierFilter = 'all' | '1' | '2';

const RANK_W = 44, CODE_W = 64, NAME_W = 100;

function fmtNum(n: number, d = 2): string { return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fmtInt(n: number): string { return Math.round(n).toLocaleString('en-US'); }
function fmtPct(n: number): string { return (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }
function fmtRankChg(n: number): string { return n > 0 ? `▲${n}` : n < 0 ? `▼${Math.abs(n)}` : '－'; }

const TH: React.CSSProperties = {
  padding: '9px 10px', fontWeight: 600, fontSize: '.74rem', background: '#1C1C1E', color: '#fff',
  whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 2, cursor: 'pointer', userSelect: 'none',
};
const miniBtn: React.CSSProperties = {
  padding: '5px 14px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6,
  cursor: 'pointer', fontSize: '.78rem', color: SUB, fontFamily: SANS, fontWeight: 500,
};

function TierCard({ label, sub, stats, color }: { label: string; sub: string; stats: TierStats; color: string }) {
  return (
    <div style={{ flex: '1 1 260px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '14px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ fontWeight: 700, fontSize: '.92rem', color: TEXT }}>{label}</span>
        <span style={{ fontSize: '.72rem', color: SUB, marginLeft: 'auto', textAlign: 'right' }}>{sub}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        <div><div style={{ fontSize: '.66rem', color: SUB }}>平均漲幅</div><div style={{ fontFamily: MONO, fontWeight: 700, fontSize: '1.05rem', color }}>{fmtPct(stats.avgPct)}</div></div>
        <div><div style={{ fontSize: '.66rem', color: SUB }}>中位數</div><div style={{ fontFamily: MONO, fontWeight: 700, fontSize: '1.05rem', color }}>{fmtPct(stats.medianPct)}</div></div>
        <div><div style={{ fontSize: '.66rem', color: SUB }}>上漲比例</div><div style={{ fontFamily: MONO, fontWeight: 700, fontSize: '1.05rem', color: TEXT }}>{stats.upCount}/{stats.count}</div></div>
        <div><div style={{ fontSize: '.66rem', color: SUB }}>跌出前300大</div><div style={{ fontFamily: MONO, fontWeight: 700, fontSize: '1.05rem', color: TEXT }}>{stats.droppedOut} 檔</div></div>
      </div>
    </div>
  );
}

export default function Top300YtdTab() {
  const [data,    setData]    = useState<ApiResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [query,   setQuery]   = useState('');
  const [market,  setMarket]  = useState<MarketFilter>('all');
  const [tier,    setTier]    = useState<TierFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('rankBase');
  const [sortAsc, setSortAsc] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setData(null);
    try {
      const r = await fetch('/api/top300-ytd', { cache: 'no-store' });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
      setData(json as ApiResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    if (!data) return [];
    let xs = data.rows;
    if (market !== 'all') xs = xs.filter(r => r.market === market);
    if (tier !== 'all') xs = xs.filter(r => (tier === '1' ? r.rankBase <= 150 : r.rankBase > 150));
    if (query.trim()) {
      const q = query.trim();
      xs = xs.filter(r => r.code.includes(q) || r.name.includes(q));
    }
    return [...xs].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      return sortAsc ? av - bv : bv - av;
    });
  }, [data, market, tier, query, sortKey, sortAsc]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortAsc(p => !p);
    else { setSortKey(k); setSortAsc(k === 'rankBase' || k === 'rankLatest'); }
  };

  const exportExcel = () => {
    if (!data) return;
    const headers = ['基準排名(12/31)', '代號', '名稱', '市場', 'Tier', '12/31還原價', `${data.latestDate}還原收盤價`, '今年漲幅%(還原權息)', '目前市值(億)', '最新排名', '排名前進'];
    const body = rows.map(r => [
      r.rankBase, r.code, r.name, r.market, r.rankBase <= 150 ? 1 : 2,
      Number(r.adjBasePrice.toFixed(2)), Number(r.adjLatestPrice.toFixed(2)), Number(r.pct.toFixed(2)),
      Math.round(r.mktcapLatest / 1e8), r.rankLatest, r.rankChange,
    ]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...body]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '前300大YTD還原權息');
    XLSX.writeFile(wb, `台股前300大YTD還原權息_${data.baseDate}至${data.latestDate}.xlsx`);
  };

  const colHead = (key: SortKey, label: string, className?: string) => (
    <th className={className} onClick={() => toggleSort(key)} style={{ ...TH, textAlign: 'right', background: sortKey === key ? '#333' : '#1C1C1E' }}>
      {label}{sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : ''}
    </th>
  );

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>
      {loading && !data && (
        <p style={{ color: SUB, textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>
          抓取300檔還原權息報酬與市值排名中，若為今天第一次查詢約需20–30秒；同一天內之後再查會用快取秒開，請耐心等候…
        </p>
      )}
      {error && (
        <div style={{ padding: '10px 14px', background: '#fff0f0', border: '1px solid #fca5a5', borderRadius: 6, color: RED, fontSize: '.85rem', marginBottom: 12 }}>{error}</div>
      )}

      {data && (
        <>
          <div style={{
            display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16,
            padding: '9px 14px', background: '#FAFAF9', border: `1px solid ${BORDER}`, borderRadius: 8,
            fontSize: '.78rem', color: SUB, fontFamily: SANS,
          }}>
            <span>基準日期：<b style={{ color: TEXT, fontFamily: MONO }}>{data.baseDate}</b></span>
            <span>資料日期：<b style={{ color: TEXT, fontFamily: MONO }}>{data.latestDate}</b>（最新收盤，非即時報價）</span>
            <span style={{ color: '#B0AAA4' }}>｜</span>
            <span>股價與漲幅皆採<b style={{ color: TEXT }}>還原權息</b>（Yahoo Finance adjClose，釘死在這兩個已收盤日期，跟「創新高強勢股」「個股與績效」分頁同一套口徑）；市值/排名仍用原始成交價計算。</span>
          </div>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <TierCard label="Tier 1　市值排名 1–150" sub="＝ 00991A 選股池對應區間" stats={data.tier1} color={TIER1} />
            <TierCard label="Tier 2　市值排名 151–300" sub="＝ 新產品多出來的差異化區間" stats={data.tier2} color={TIER2} />
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜尋代號/名稱"
              style={{ padding: '6px 12px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.85rem', fontFamily: SANS, color: TEXT, width: 160 }} />
            <div style={{ display: 'inline-flex', border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden' }}>
              {([['all', '全部'], ['上市', '上市'], ['上櫃', '上櫃']] as const).map(([k, label]) => (
                <button key={k} onClick={() => setMarket(k)}
                  style={{ padding: '7px 14px', border: 'none', cursor: 'pointer', fontFamily: SANS, fontSize: '.83rem',
                    fontWeight: market === k ? 700 : 500, background: market === k ? RED : '#fff', color: market === k ? '#fff' : SUB }}>
                  {label}
                </button>
              ))}
            </div>
            <div style={{ display: 'inline-flex', border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden' }}>
              {([['all', '全部Tier'], ['1', 'Tier1'], ['2', 'Tier2']] as const).map(([k, label]) => (
                <button key={k} onClick={() => setTier(k)}
                  style={{ padding: '7px 14px', border: 'none', cursor: 'pointer', fontFamily: SANS, fontSize: '.83rem',
                    fontWeight: tier === k ? 700 : 500, background: tier === k ? RED : '#fff', color: tier === k ? '#fff' : SUB }}>
                  {label}
                </button>
              ))}
            </div>
            <button onClick={load} disabled={loading} style={miniBtn}>{loading ? '載入中…' : '↻ 重新整理'}</button>
            {data && !loading && <button onClick={exportExcel} style={{ ...miniBtn, marginLeft: 'auto' }}>↓ 匯出 Excel</button>}
          </div>
          <div style={{ fontSize: '.76rem', color: SUB, marginBottom: 10 }}>顯示 {rows.length} / {data.rows.length} 檔</div>

          <div className="mt" style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '65vh', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, minWidth: 900 }}>
              <thead>
                <tr>
                  <th className="m-unstick" onClick={() => toggleSort('rankBase')} style={{ ...TH, textAlign: 'right', width: RANK_W, position: 'sticky', left: 0, zIndex: 3 }}>基準# {sortKey === 'rankBase' ? (sortAsc ? '↑' : '↓') : ''}</th>
                  <th className="m-unstick" style={{ ...TH, textAlign: 'left', cursor: 'default', width: CODE_W, position: 'sticky', left: RANK_W, zIndex: 3 }}>代號</th>
                  <th className="m-stick0" style={{ ...TH, textAlign: 'left', cursor: 'default', width: NAME_W, position: 'sticky', left: RANK_W + CODE_W, zIndex: 3, borderRight: '1px solid #333' }}>名稱</th>
                  <th className="m-hide" style={{ ...TH, textAlign: 'center', cursor: 'default' }}>市場</th>
                  <th className="m-hide" style={{ ...TH, textAlign: 'center', cursor: 'default' }}>Tier</th>
                  {colHead('closeBase', '12/31還原價', 'm-hide')}
                  {colHead('adjLatestPrice', '最新收盤還原價')}
                  {colHead('pct', '今年漲幅')}
                  {colHead('mktcapLatest', '目前市值(億)')}
                  {colHead('rankLatest', '最新排名')}
                  {colHead('rankChange', '排名前進')}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const rowBg = i % 2 === 0 ? '#fff' : '#FAFAF9';
                  const pctColor = r.pct > 0 ? RED : r.pct < 0 ? GREEN : SUB;
                  const rcColor = r.rankChange > 0 ? RED : r.rankChange < 0 ? GREEN : SUB;
                  const isTier1 = r.rankBase <= 150;
                  return (
                    <tr key={r.code} style={{ background: rowBg, borderBottom: `1px solid ${BORDER}` }}>
                      <td className="m-unstick" style={{ padding: '7px 8px', textAlign: 'right', fontFamily: MONO, fontSize: '.76rem', color: SUB, position: 'sticky', left: 0, zIndex: 1, background: rowBg }}>{r.rankBase}</td>
                      <td className="m-unstick" style={{ padding: '7px 8px', fontFamily: MONO, fontSize: '.8rem', color: TEXT, fontWeight: 600, position: 'sticky', left: RANK_W, zIndex: 1, background: rowBg }}>{r.code}</td>
                      <td className="m-stick0" title={r.name} style={{ padding: '7px 8px', fontSize: '.82rem', color: TEXT, whiteSpace: 'nowrap', maxWidth: NAME_W, overflow: 'hidden', textOverflow: 'ellipsis', position: 'sticky', left: RANK_W + CODE_W, zIndex: 1, background: rowBg, borderRight: `1px solid ${BORDER}` }}>{r.name}</td>
                      <td className="m-hide" style={{ padding: '7px 8px', textAlign: 'center', fontSize: '.76rem', color: SUB }}>
                        <span style={{ padding: '1px 8px', borderRadius: 10, border: `1px solid ${BORDER}`, whiteSpace: 'nowrap' }}>{r.market}</span>
                      </td>
                      <td className="m-hide" style={{ padding: '7px 8px', textAlign: 'center' }}>
                        <span style={{
                          fontSize: '.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                          color: isTier1 ? TIER1 : TIER2, background: isTier1 ? '#E8EEFB' : '#F7EDD9',
                        }}>T{isTier1 ? 1 : 2}</span>
                      </td>
                      <td className="m-hide" style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>{fmtNum(r.adjBasePrice)}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>
                        {fmtNum(r.adjLatestPrice)}{!r.pctAdjusted && <span title="Yahoo還原資料缺漏，退回原始收盤價估算" style={{ color: '#C99', marginLeft: 3 }}>※</span>}
                      </td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.84rem', fontWeight: 700, color: pctColor }}>{fmtPct(r.pct)}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>{fmtInt(r.mktcapLatest / 1e8)}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: r.rankLatest > 300 ? '#B0AAA4' : TEXT }}>{r.rankLatest > 90000 ? '—' : r.rankLatest}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', fontWeight: 700, color: rcColor }}>{fmtRankChg(r.rankChange)}</td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={11} style={{ padding: '30px 0', textAlign: 'center', color: '#AAA', fontSize: '.85rem' }}>無符合條件的資料</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 12, fontSize: '.72rem', color: SUB, lineHeight: 1.9 }}>
            篩選規則：代號4碼、首碼非0的普通股（排除ETF/存託憑證-DR/特別股），依2025/12/31市值取全市場前300大。市值＝原始收盤價×已發行普通股數（股本用最新值回推，非12/31當時股本）；「最新排名」以最新收盤市值在全市場重新排名，超過300代表已跌出前300大。漲跌顏色依台灣慣例：<span style={{ color: RED, fontWeight: 600 }}>紅漲</span>／<span style={{ color: GREEN, fontWeight: 600 }}>綠跌</span>。標示「※」代表該檔 Yahoo 還原權息資料抓不到，暫以原始收盤價估算漲幅，僅極少數個股會發生。
          </div>
        </>
      )}
    </div>
  );
}
