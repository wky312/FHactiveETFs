'use client';
import { useState, useMemo, useEffect, useCallback, Fragment } from 'react';
import * as XLSX from 'xlsx';

/* 目前市值前350大普通股：YTD／近五日／近一月／近一季（還原權息）＋ 台股主動式ETF持有狀況。
   可勾選要統計哪幾檔主動ETF（預設 00981A／00992A／00991A），
   持股金額 = 股數 × 最新收盤。 */

const RED    = '#C00000';   // 台灣慣例：漲＝紅
const GREEN  = '#188A4E';   // 跌＝綠
const GOLD   = '#9a6a33';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

const DEFAULT_SELECTED = ['00981A', '00992A', '00991A'];

interface EtfHolder { t: string; q: number; w: number | null }
interface Row {
  rank: number; code: string; name: string; market: '上市' | '上櫃';
  shares: number; close: number; mktcap: number;
  ytd: number | null; q3: number | null; m1: number | null; d5: number | null;
  holders: EtfHolder[];
}
interface Fund { ticker: string; name: string; holdingDate: string | null }
interface Result { latestDate: string; total: number; funds: Fund[]; rows: Row[] }

interface Calc extends Row {
  selHolders: EtfHolder[];
  amount: number;      // 選取ETF合計持股金額（元）
}

type SortKey = 'rank' | 'mktcap' | 'ytd' | 'q3' | 'm1' | 'd5' | 'amount' | 'nSel' | 'nAll';
type MarketFilter = 'all' | '上市' | '上櫃';
type HoldFilter = 'all' | 'held' | 'notHeld';

function fmtNum(n: number, d = 0): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtPct(n: number | null): string { return n == null ? '－' : (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }
const pctColor = (n: number | null) => n == null ? '#C9C3BD' : n > 0 ? RED : n < 0 ? GREEN : SUB;
const yi = (yuan: number) => fmtNum(yuan / 1e8, yuan / 1e8 >= 100 ? 0 : 2); // 億

const TH: React.CSSProperties = {
  padding: '9px 10px', fontWeight: 600, fontSize: '.74rem', background: '#1C1C1E', color: '#fff',
  whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 2, cursor: 'pointer', userSelect: 'none',
};
const miniBtn: React.CSSProperties = {
  padding: '5px 14px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6,
  cursor: 'pointer', fontSize: '.78rem', color: SUB, fontFamily: SANS, fontWeight: 500,
};

const RANK_W = 40, CODE_W = 64, NAME_W = 96;

export default function Top350EtfTab() {
  const [data,    setData]    = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [query,   setQuery]   = useState('');
  const [market,  setMarket]  = useState<MarketFilter>('all');
  const [holdF,   setHoldF]   = useState<HoldFilter>('all');
  const [selected, setSelected] = useState<string[]>(DEFAULT_SELECTED);
  const [sortKey, setSortKey] = useState<SortKey>('rank');
  const [sortAsc, setSortAsc] = useState(true);
  const [open,    setOpen]    = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setData(null);
    try {
      const r = await fetch('/api/top350-etf', { cache: 'no-store' });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
      setData(json as Result);
    } catch (e) {
      setError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const fundName = useMemo(() => new Map((data?.funds ?? []).map(f => [f.ticker, f.name])), [data]);
  const selSet = useMemo(() => new Set(selected), [selected]);

  const calc: Calc[] = useMemo(() => {
    if (!data) return [];
    return data.rows.map(r => {
      const selHolders = r.holders.filter(h => selSet.has(h.t));
      const selQ = selHolders.reduce((s, h) => s + h.q, 0);
      return {
        ...r, selHolders,
        amount: selQ * r.close,
      };
    });
  }, [data, selSet]);

  const rows = useMemo(() => {
    let xs = calc;
    if (market !== 'all') xs = xs.filter(s => s.market === market);
    if (holdF === 'held') xs = xs.filter(s => s.selHolders.length > 0);
    if (holdF === 'notHeld') xs = xs.filter(s => s.selHolders.length === 0);
    if (query.trim()) {
      const q = query.trim();
      xs = xs.filter(s => s.code.includes(q) || s.name.includes(q));
    }
    const val = (s: Calc): number | null => {
      switch (sortKey) {
        case 'nSel': return s.selHolders.length;
        case 'nAll': return s.holders.length;
        default: return s[sortKey];
      }
    };
    return [...xs].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return sortAsc ? av - bv : bv - av;
    });
  }, [calc, market, holdF, query, sortKey, sortAsc]);

  // 整體統計：以「全部350檔」為母體（不受篩選影響），回答「主動ETF買了多少、佔多少」
  const summary = useMemo(() => {
    if (!calc.length) return null;
    const totalCap = calc.reduce((s, r) => s + r.mktcap, 0);
    const held = calc.filter(r => r.selHolders.length > 0);
    const amount = calc.reduce((s, r) => s + r.amount, 0);
    const perFund = selected.map(t => {
      let amt = 0, n = 0;
      for (const r of calc) {
        const h = r.holders.find(x => x.t === t);
        if (h) { amt += h.q * r.close; n++; }
      }
      return { t, amt, n };
    });
    return { totalCap, nHeld: held.length, amount, perFund, ratio: totalCap > 0 ? (amount / totalCap) * 100 : 0 };
  }, [calc, selected]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortAsc(p => !p);
    else { setSortKey(k); setSortAsc(k === 'rank'); }
  };
  const toggleFund = (t: string) =>
    setSelected(p => p.includes(t) ? p.filter(x => x !== t) : [...p, t]);

  const exportExcel = () => {
    if (!data) return;
    const headers = ['市值排名', '代號', '名稱', '市場', '市值(億)', '最新收盤', 'YTD%', '近五日%', '近一月%', '近一季%',
      `選取ETF持股金額(億)`, '選取ETF持有檔數', '全部主動ETF持有檔數', '持有ETF(權重%)'];
    const body = rows.map(s => [
      s.rank, s.code, s.name, s.market, Math.round(s.mktcap / 1e8), s.close,
      s.ytd == null ? '' : Number(s.ytd.toFixed(2)), s.d5 == null ? '' : Number(s.d5.toFixed(2)),
      s.m1 == null ? '' : Number(s.m1.toFixed(2)), s.q3 == null ? '' : Number(s.q3.toFixed(2)),
      Number((s.amount / 1e8).toFixed(2)), s.selHolders.length, s.holders.length,
      s.holders.map(h => `${h.t}(${h.w == null ? '-' : h.w.toFixed(2)})`).join(' '),
    ]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...body]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '市值前350大_主動ETF持有');
    XLSX.writeFile(wb, `市值前350大_主動ETF持有_${data.latestDate}.xlsx`);
  };

  const colHead = (key: SortKey, label: string) => (
    <th onClick={() => toggleSort(key)}
      style={{ ...TH, textAlign: 'right', background: sortKey === key ? '#333' : '#1C1C1E' }}>
      {label}{sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : ''}
    </th>
  );

  const perfCell = (v: number | null) => (
    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', fontWeight: 700, color: pctColor(v) }}>{fmtPct(v)}</td>
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
          <option value="all">持股篩選：不限</option>
          <option value="held">選取ETF有持有</option>
          <option value="notHeld">選取ETF皆未持有</option>
        </select>
        <button onClick={() => setShowPicker(p => !p)} style={miniBtn}>
          統計ETF：{selected.length} 檔 {showPicker ? '▲' : '▼'}
        </button>
        <button onClick={load} disabled={loading} style={miniBtn}>{loading ? '載入中…' : '↻ 重新整理'}</button>
        {data && !loading && <button onClick={exportExcel} style={{ ...miniBtn, marginLeft: 'auto' }}>↓ 匯出 Excel</button>}
      </div>

      {data && showPicker && (
        <div style={{ border: `1px solid ${BORDER}`, borderRadius: 8, padding: '10px 12px', marginBottom: 12, background: '#FAFAF9' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <button style={miniBtn} onClick={() => setSelected(DEFAULT_SELECTED.filter(t => fundName.has(t)))}>預設三檔</button>
            <button style={miniBtn} onClick={() => setSelected(data.funds.map(f => f.ticker))}>全選</button>
            <button style={miniBtn} onClick={() => setSelected([])}>全不選</button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {data.funds.map(f => {
              const on = selSet.has(f.ticker);
              return (
                <button key={f.ticker} onClick={() => toggleFund(f.ticker)} title={`${f.name}（持股日 ${f.holdingDate ?? '—'}）`}
                  style={{ padding: '4px 10px', borderRadius: 14, cursor: 'pointer', fontSize: '.76rem', fontFamily: SANS,
                    border: `1px solid ${on ? GOLD : BORDER}`, background: on ? '#F6EEE4' : '#fff', color: on ? GOLD : SUB, fontWeight: on ? 700 : 500 }}>
                  {f.ticker} {f.name.replace(/^主動/, '')}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {loading && <p style={{ color: SUB, textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>抓取全市場行情、350 檔還原權息報酬與主動ETF持股中，首次約需 30–60 秒（當日算過後即快取）…</p>}
      {error && (
        <div style={{ padding: '10px 14px', background: '#fff0f0', border: '1px solid #fca5a5', borderRadius: 6, color: RED, fontSize: '.85rem', marginBottom: 12 }}>{error}</div>
      )}

      {data && summary && !loading && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            {[
              ['選取ETF合計持股（前350大內）', `${yi(summary.amount)} 億`],
              ['佔前350大總市值', `${summary.ratio.toFixed(2)}%`],
              ['被選取ETF持有檔數', `${summary.nHeld} / ${data.total}`],
            ].map(([k, v]) => (
              <div key={k} style={{ border: `1px solid ${BORDER}`, borderRadius: 8, padding: '8px 14px', minWidth: 150 }}>
                <div style={{ fontSize: '.7rem', color: SUB }}>{k}</div>
                <div style={{ fontFamily: MONO, fontSize: '1.05rem', fontWeight: 700, color: GOLD }}>{v}</div>
              </div>
            ))}
            {summary.perFund.map(f => (
              <div key={f.t} style={{ border: `1px solid ${BORDER}`, borderRadius: 8, padding: '8px 14px', minWidth: 120 }}>
                <div style={{ fontSize: '.7rem', color: SUB }}>{f.t}（{f.n} 檔）</div>
                <div style={{ fontFamily: MONO, fontSize: '1rem', fontWeight: 700 }}>{yi(f.amt)} 億</div>
              </div>
            ))}
          </div>

          <p style={{ fontSize: '.78rem', color: SUB, margin: '0 0 12px' }}>
            資料至 <b style={{ color: TEXT }}>{data.latestDate}</b> 收盤；市值 = 收盤價 × 已發行普通股數，取全市場前 <b style={{ color: TEXT }}>{data.total}</b> 大。
            篩選後 {rows.length} 檔。點列可展開各主動ETF持有明細。
          </p>

          <div className="mt" style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '65vh', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
            {/* border-collapse 用 separate：collapse 會讓 Safari / 行動版瀏覽器的 sticky <td> 直接失效 */}
            <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, minWidth: 1100 }}>
              <thead>
                <tr>
                  <th className="m-unstick" onClick={() => toggleSort('rank')} style={{ ...TH, textAlign: 'right', width: RANK_W, position: 'sticky', left: 0, zIndex: 3 }}>#{sortKey === 'rank' ? (sortAsc ? ' ↑' : ' ↓') : ''}</th>
                  <th className="m-unstick" style={{ ...TH, textAlign: 'left', cursor: 'default', width: CODE_W, position: 'sticky', left: RANK_W, zIndex: 3 }}>代號</th>
                  <th className="m-stick0" style={{ ...TH, textAlign: 'left', cursor: 'default', width: NAME_W, position: 'sticky', left: RANK_W + CODE_W, zIndex: 3, borderRight: `1px solid #333` }}>名稱</th>
                  <th className="m-hide" style={{ ...TH, textAlign: 'center', cursor: 'default' }}>市場</th>
                  {colHead('mktcap', '市值(億)')}
                  {colHead('ytd', 'YTD')}
                  {colHead('d5', '近五日')}
                  {colHead('m1', '近一月')}
                  {colHead('q3', '近一季')}
                  {colHead('amount', '選取ETF持股(億)')}
                  {colHead('nSel', '選取持有檔數')}
                  {colHead('nAll', '全部持有檔數')}
                  <th style={{ ...TH, textAlign: 'left', cursor: 'default' }}>持有的主動ETF</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s, i) => {
                  const rowBg = i % 2 === 0 ? '#fff' : '#FAFAF9';
                  const isOpen = open === s.code;
                  // 選取的ETF排前面，其餘依持股數；欄位只放前4個，全部明細點列展開
                  const sortedHolders = [...s.holders].sort((a, b) =>
                    Number(selSet.has(b.t)) - Number(selSet.has(a.t)) || b.q - a.q);
                  return (
                    <Fragment key={s.code}>
                      <tr onClick={() => setOpen(isOpen ? null : s.code)}
                        style={{ background: rowBg, borderBottom: `1px solid ${BORDER}`, cursor: s.holders.length ? 'pointer' : 'default' }}>
                        <td className="m-unstick" style={{ padding: '7px 8px', textAlign: 'right', fontFamily: MONO, fontSize: '.76rem', color: SUB, position: 'sticky', left: 0, zIndex: 1, background: rowBg }}>{s.rank}</td>
                        <td className="m-unstick" style={{ padding: '7px 8px', fontFamily: MONO, fontSize: '.8rem', fontWeight: 600, position: 'sticky', left: RANK_W, zIndex: 1, background: rowBg }}>{s.code}</td>
                        <td className="m-stick0" title={s.name} style={{ padding: '7px 8px', fontSize: '.82rem', whiteSpace: 'nowrap', maxWidth: NAME_W, overflow: 'hidden', textOverflow: 'ellipsis', position: 'sticky', left: RANK_W + CODE_W, zIndex: 1, background: rowBg, borderRight: `1px solid ${BORDER}` }}>{s.name}</td>
                        <td className="m-hide" style={{ padding: '7px 8px', textAlign: 'center', fontSize: '.76rem', color: SUB }}>
                          <span style={{ padding: '1px 8px', borderRadius: 10, border: `1px solid ${BORDER}`, whiteSpace: 'nowrap' }}>{s.market}</span>
                        </td>
                        <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem' }}>{fmtNum(s.mktcap / 1e8)}</td>
                        {perfCell(s.ytd)}{perfCell(s.d5)}{perfCell(s.m1)}{perfCell(s.q3)}
                        <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', fontWeight: s.amount > 0 ? 700 : 400, color: s.amount > 0 ? GOLD : '#C9C3BD' }}>
                          {s.amount > 0 ? yi(s.amount) : '－'}
                        </td>
                        <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: s.selHolders.length ? TEXT : '#C9C3BD' }}>{s.selHolders.length || '－'}</td>
                        <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: s.holders.length ? TEXT : '#C9C3BD' }}>{s.holders.length || '－'}</td>
                        <td style={{ padding: '7px 10px', fontSize: '.72rem', minWidth: 290 }}>
                          <div style={{ display: 'flex', flexWrap: 'nowrap', gap: 3, whiteSpace: 'nowrap' }}>
                            {sortedHolders.slice(0, 4).map(h => (
                              <span key={h.t} style={{ padding: '0 6px', borderRadius: 8, fontFamily: MONO,
                                border: `1px solid ${selSet.has(h.t) ? GOLD : BORDER}`, color: selSet.has(h.t) ? GOLD : SUB, fontWeight: selSet.has(h.t) ? 700 : 400 }}>{h.t}</span>
                            ))}
                            {sortedHolders.length > 4 && <span style={{ color: SUB }}>+{sortedHolders.length - 4}</span>}
                          </div>
                        </td>
                      </tr>
                      {isOpen && s.holders.length > 0 && (
                        <tr style={{ background: '#FBF8F4' }}>
                          <td colSpan={14} style={{ padding: '10px 16px', borderBottom: `1px solid ${BORDER}` }}>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', fontSize: '.76rem' }}>
                              {sortedHolders.map(h => (
                                <span key={h.t} style={{ color: selSet.has(h.t) ? TEXT : SUB, fontWeight: selSet.has(h.t) ? 700 : 400 }}>
                                  <span style={{ fontFamily: MONO }}>{h.t}</span> {fundName.get(h.t)?.replace(/^主動/, '')}：
                                  <span style={{ fontFamily: MONO }}> {yi(h.q * s.close)}億</span>
                                  （{h.w == null ? '－' : h.w.toFixed(2)}% 權重）
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={14} style={{ padding: '30px 0', textAlign: 'center', color: '#AAA', fontSize: '.85rem' }}>無符合條件的資料</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 12, fontSize: '.72rem', color: SUB, lineHeight: 1.9 }}>
            報酬為還原權息收盤、兩端先進位至小數2位再相除（對齊券商）；終點為最新已收盤日，起點為 YTD＝去年12/31、近五日＝往前5個交易日、近一月＝往前1個月、近一季＝往前3個月（遇休市取之前最近交易日）。
            漲跌顏色依台灣慣例：<span style={{ color: RED, fontWeight: 600 }}>紅漲</span> ／ <span style={{ color: GREEN, fontWeight: 600 }}>綠跌</span>。<br />
            持股金額 = ETF 最新申報持股股數 × 最新收盤價；各檔 ETF 持股日不一定相同（展開「統計ETF」後滑過各檔可見其持股日）。
            僅計前350大內的個股；母體為代號4碼普通股（排除ETF／DR／特別股）。
          </div>
        </>
      )}
    </div>
  );
}
