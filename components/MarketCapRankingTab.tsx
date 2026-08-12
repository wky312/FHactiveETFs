'use client';
import { useState, useMemo, useEffect, useCallback } from 'react';
import * as XLSX from 'xlsx';

/* 全台股（上市+上櫃）市值前150大普通股，漲跌幅排行 + 00981A/00991A 持股比例。
   基準日固定 2026/07/30 收盤；最新收盤/市值/持股比例每次載入即時算，15 分鐘快取。 */

const RED    = '#C00000';   // 台灣慣例：漲＝紅
const GREEN  = '#188A4E';   // 跌＝綠
const GOLD   = '#9a6a33';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

interface RankedStock {
  code: string; name: string; market: '上市' | '上櫃';
  mktcap: number; closeBase: number; closeLatest: number; pct: number;
  p981: number | null; p991: number | null;
}
interface RankingResult {
  baseDate: string; latestDate: string;
  holdingDate981: string | null; holdingDate991: string | null;
  total: number; stocks: RankedStock[];
}

type SortKey = 'mktcap' | 'closeBase' | 'closeLatest' | 'pct' | 'p981' | 'p991';
type MarketFilter = 'all' | '上市' | '上櫃';
type HoldFilter = 'all' | 'h981' | 'h991' | 'either' | 'both' | 'neither';

const HOLD_OPTIONS: { value: HoldFilter; label: string }[] = [
  { value: 'all',     label: '持股篩選：不限' },
  { value: 'h981',    label: '00981A 有持股' },
  { value: 'h991',    label: '00991A 有持股' },
  { value: 'either',  label: '任一有持股' },
  { value: 'both',    label: '兩檔皆有持股' },
  { value: 'neither', label: '兩檔皆未持有' },
];

// 左側固定欄寬（px），供 sticky left 疊算
const RANK_W = 40, CODE_W = 64, NAME_W = 96;

function fmtNum(n: number, d = 2): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtPct(n: number): string { return (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }

const TH: React.CSSProperties = {
  padding: '9px 10px', fontWeight: 600, fontSize: '.74rem', background: '#1C1C1E', color: '#fff',
  whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 2, cursor: 'pointer', userSelect: 'none',
};
const miniBtn: React.CSSProperties = {
  padding: '5px 14px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6,
  cursor: 'pointer', fontSize: '.78rem', color: SUB, fontFamily: SANS, fontWeight: 500,
};

export default function MarketCapRankingTab() {
  const [data,    setData]    = useState<RankingResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [query,   setQuery]   = useState('');
  const [market,  setMarket]  = useState<MarketFilter>('all');
  const [holdF,   setHoldF]   = useState<HoldFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('pct');
  const [sortAsc, setSortAsc] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setData(null);
    try {
      const r = await fetch('/api/market-cap-ranking', { cache: 'no-store' });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
      setData(json as RankingResult);
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
    if (market !== 'all') xs = xs.filter(s => s.market === market);
    if (holdF !== 'all') {
      xs = xs.filter(s => {
        const h981 = s.p981 != null, h991 = s.p991 != null;
        switch (holdF) {
          case 'h981': return h981;
          case 'h991': return h991;
          case 'either': return h981 || h991;
          case 'both': return h981 && h991;
          case 'neither': return !h981 && !h991;
          default: return true;
        }
      });
    }
    if (query.trim()) {
      const q = query.trim();
      xs = xs.filter(s => s.code.includes(q) || s.name.includes(q));
    }
    return [...xs].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return sortAsc ? av - bv : bv - av;
    });
  }, [data, market, holdF, query, sortKey, sortAsc]);

  const stats = useMemo(() => {
    if (!rows.length) return null;
    const up = rows.filter(s => s.pct > 0).length;
    const down = rows.filter(s => s.pct < 0).length;
    const avg = rows.reduce((s, r) => s + r.pct, 0) / rows.length;
    return { up, down, flat: rows.length - up - down, avg };
  }, [rows]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortAsc(p => !p);
    else { setSortKey(k); setSortAsc(false); }
  };

  const exportExcel = () => {
    if (!data) return;
    const headers = ['排名', '代號', '名稱', '市場', '市值(億)', '7/30收盤', '最新收盤', '漲跌幅%', '00981A%', '00991A%'];
    const body = rows.map((s, i) => [
      i + 1, s.code, s.name, s.market, Math.round(s.mktcap / 1e8),
      s.closeBase, s.closeLatest, Number(s.pct.toFixed(2)),
      s.p981 == null ? '' : Number(s.p981.toFixed(2)),
      s.p991 == null ? '' : Number(s.p991.toFixed(2)),
    ]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...body]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '市值前150大漲跌排行');
    XLSX.writeFile(wb, `市值前150大漲跌排行_${data.baseDate}至${data.latestDate}.xlsx`);
  };

  const colHead = (key: SortKey, label: string) => (
    <th onClick={() => toggleSort(key)}
      style={{ ...TH, textAlign: 'right', background: sortKey === key ? '#333' : '#1C1C1E' }}>
      {label}{sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : ''}
    </th>
  );

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>
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
        <select value={holdF} onChange={e => setHoldF(e.target.value as HoldFilter)}
          style={{ padding: '6px 10px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.83rem', fontFamily: SANS, color: TEXT, cursor: 'pointer' }}>
          {HOLD_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button onClick={load} disabled={loading} style={miniBtn}>{loading ? '載入中…' : '↻ 重新整理'}</button>
        {data && !loading && <button onClick={exportExcel} style={{ ...miniBtn, marginLeft: 'auto' }}>↓ 匯出 Excel</button>}
      </div>

      {data && !loading && (
        <p style={{ fontSize: '.78rem', color: SUB, margin: '0 0 12px' }}>
          區間：<b style={{ color: TEXT }}>{data.baseDate}</b> 收盤 → <b style={{ color: TEXT }}>{data.latestDate}</b> 收盤（自動抓最新一個交易日，收盤後才會更新到當天）。
          市值 = 最新收盤價 × 已發行普通股數，取全市場前 <b style={{ color: TEXT }}>{data.total}</b> 大。
          {stats && (
            <> 篩選後 {rows.length} 檔：<span style={{ color: RED, fontWeight: 600 }}>{stats.up} 漲</span>
              {' / '}<span style={{ color: GREEN, fontWeight: 600 }}>{stats.down} 跌</span>
              {' / '}{stats.flat} 平，平均漲跌幅 <span style={{ color: stats.avg >= 0 ? RED : GREEN, fontWeight: 600 }}>{fmtPct(stats.avg)}</span>。
            </>
          )}
        </p>
      )}

      {loading && <p style={{ color: SUB, textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>抓取全市場行情與持股資料中，約需 10–20 秒…</p>}
      {error && (
        <div style={{ padding: '10px 14px', background: '#fff0f0', border: '1px solid #fca5a5', borderRadius: 6, color: RED, fontSize: '.85rem', marginBottom: 12 }}>{error}</div>
      )}

      {data && !loading && (
        <>
          <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '65vh', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
            {/* border-collapse 用 separate：collapse 會讓 Safari / 行動版瀏覽器的 sticky <td> 直接失效 */}
            <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, minWidth: 820 }}>
              <thead>
                <tr>
                  <th style={{ ...TH, textAlign: 'right', cursor: 'default', width: RANK_W, position: 'sticky', left: 0, zIndex: 3 }}>#</th>
                  <th style={{ ...TH, textAlign: 'left', cursor: 'default', width: CODE_W, position: 'sticky', left: RANK_W, zIndex: 3 }}>代號</th>
                  <th style={{ ...TH, textAlign: 'left', cursor: 'default', width: NAME_W, position: 'sticky', left: RANK_W + CODE_W, zIndex: 3, borderRight: `1px solid #333` }}>名稱</th>
                  <th style={{ ...TH, textAlign: 'center', cursor: 'default' }}>市場</th>
                  {colHead('mktcap', '市值(億)')}
                  {colHead('closeBase', '7/30收盤')}
                  {colHead('closeLatest', '最新收盤')}
                  {colHead('pct', '漲跌幅')}
                  {colHead('p981', '00981A%')}
                  {colHead('p991', '00991A%')}
                </tr>
              </thead>
              <tbody>
                {rows.map((s, i) => {
                  const rowBg = i % 2 === 0 ? '#fff' : '#FAFAF9';
                  const pctColor = s.pct > 0 ? RED : s.pct < 0 ? GREEN : SUB;
                  return (
                    <tr key={s.code} style={{ background: rowBg, borderBottom: `1px solid ${BORDER}` }}>
                      <td style={{ padding: '7px 8px', textAlign: 'right', fontFamily: MONO, fontSize: '.76rem', color: SUB, position: 'sticky', left: 0, zIndex: 1, background: rowBg }}>{i + 1}</td>
                      <td style={{ padding: '7px 8px', fontFamily: MONO, fontSize: '.8rem', color: TEXT, fontWeight: 600, position: 'sticky', left: RANK_W, zIndex: 1, background: rowBg }}>{s.code}</td>
                      <td title={s.name} style={{ padding: '7px 8px', fontSize: '.82rem', color: TEXT, whiteSpace: 'nowrap', maxWidth: NAME_W, overflow: 'hidden', textOverflow: 'ellipsis', position: 'sticky', left: RANK_W + CODE_W, zIndex: 1, background: rowBg, borderRight: `1px solid ${BORDER}` }}>{s.name}</td>
                      <td style={{ padding: '7px 8px', textAlign: 'center', fontSize: '.76rem', color: SUB }}>
                        <span style={{ padding: '1px 8px', borderRadius: 10, border: `1px solid ${BORDER}`, whiteSpace: 'nowrap' }}>{s.market}</span>
                      </td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>{fmtNum(s.mktcap / 1e8, 0)}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>{fmtNum(s.closeBase)}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>{fmtNum(s.closeLatest)}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.84rem', fontWeight: 700, color: pctColor }}>{fmtPct(s.pct)}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: s.p981 == null ? '#C9C3BD' : GOLD, fontWeight: s.p981 == null ? 400 : 700 }}>
                        {s.p981 == null ? '－' : `${s.p981.toFixed(2)}%`}
                      </td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: s.p991 == null ? '#C9C3BD' : GOLD, fontWeight: s.p991 == null ? 400 : 700 }}>
                        {s.p991 == null ? '－' : `${s.p991.toFixed(2)}%`}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={10} style={{ padding: '30px 0', textAlign: 'center', color: '#AAA', fontSize: '.85rem' }}>無符合條件的資料</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 12, fontSize: '.72rem', color: SUB, lineHeight: 1.9 }}>
            篩選規則：僅計入代號 4 碼、首碼非 0 的普通股（排除 ETF／存託憑證-DR／特別股），依最新收盤市值取全市場前 {data.total} 大。
            漲跌顏色依台灣慣例：<span style={{ color: RED, fontWeight: 600 }}>紅漲</span> ／ <span style={{ color: GREEN, fontWeight: 600 }}>綠跌</span>。<br />
            00981A（主動統一台股增長）持股 as-of <b>{data.holdingDate981 ?? '—'}</b>；00991A（主動復華未來50）持股 as-of <b>{data.holdingDate991 ?? '—'}</b>，
            取自共用 Supabase 最新申報持股，佔基金淨資產比例，「－」代表當期未持有。點欄位標題可排序；代號/名稱固定於左側，方便橫向捲動時對照。
          </div>
        </>
      )}
    </div>
  );
}
