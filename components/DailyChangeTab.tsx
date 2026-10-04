'use client';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { DailyChangeResult } from '@/lib/dailyChange';

// 台灣慣例：買超（加碼）紅、賣超（減碼）綠
const RED    = '#C00000';
const GREEN  = '#16a34a';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

const DEFAULT_TICKERS = ['00981A', '00991A', '00992A'];

type SortKey = 'stock' | 'lots' | 'amount';

interface Pill { ticker: string; shares: number; amount: number | null; tag?: '新' | '清' }

interface Row {
  stockid: string;
  stockname: string;
  close: number | null;
  adds: Pill[];
  cuts: Pill[];
  netShares: number;
  amount: number | null;       // 淨變動金額（無報價為 null）
  detail: { ticker: string; prev: number; cur: number }[];
}

function fmtLots(shares: number): string {
  const lots = shares / 1000;
  const s = Math.abs(lots).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return `${lots > 0 ? '+' : lots < 0 ? '-' : ''}${s}`;
}
function fmtMoney(v: number): string {
  const a = Math.abs(v);
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(2)} 億`;
  return `${sign}${(a / 1e4).toFixed(0)} 萬`;
}
function fmtMoneyPlain(v: number): string {
  return v >= 1e8 ? `${(v / 1e8).toFixed(2)} 億` : `${(v / 1e4).toFixed(0)} 萬`;
}
const dirColor = (v: number | null) => (v == null || v === 0 ? SUB : v > 0 ? RED : GREEN);

const TH: React.CSSProperties = {
  padding: '8px 14px', fontWeight: 600, fontSize: '.75rem',
  background: TEXT, color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1, userSelect: 'none',
};
const TD: React.CSSProperties = { padding: '8px 14px', fontSize: '.84rem', borderBottom: `1px solid ${BORDER}`, verticalAlign: 'top' };

export default function DailyChangeTab() {
  const [data,     setData]     = useState<DailyChangeResult | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const [selected, setSelected] = useState<string[]>(DEFAULT_TICKERS);
  const [sortKey,  setSortKey]  = useState<SortKey>('amount');
  const [sortAsc,  setSortAsc]  = useState(false);
  const [openId,   setOpenId]   = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res  = await fetch('/api/daily-change', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json as DailyChangeResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    load();
  }, [load]);

  const toggleTicker = (t: string) =>
    setSelected(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);

  const { rows, buy, sell } = useMemo(() => {
    const out: Row[] = [];
    let buyAmt = 0, sellAmt = 0;
    if (!data) return { rows: out, buy: 0, sell: 0 };
    const sel = new Set(selected);
    for (const s of data.stocks) {
      const ch = s.changes.filter(c => sel.has(c.ticker));
      if (!ch.length) continue;
      const pill = (c: { ticker: string; prev: number; cur: number }): Pill => ({
        ticker: c.ticker, shares: c.cur - c.prev,
        amount: s.close != null ? (c.cur - c.prev) * s.close : null,
        tag: c.prev === 0 ? '新' : c.cur === 0 ? '清' : undefined,
      });
      const adds = ch.filter(c => c.cur > c.prev).map(pill).sort((a, b) => Math.abs(b.amount ?? b.shares) - Math.abs(a.amount ?? a.shares));
      const cuts = ch.filter(c => c.cur < c.prev).map(pill).sort((a, b) => Math.abs(b.amount ?? b.shares) - Math.abs(a.amount ?? a.shares));
      const netShares = ch.reduce((sum, c) => sum + (c.cur - c.prev), 0);
      if (s.close != null) {
        for (const c of ch) {
          const amt = (c.cur - c.prev) * s.close;
          if (amt > 0) buyAmt += amt; else sellAmt += -amt;
        }
      }
      out.push({
        stockid: s.stockid, stockname: s.stockname, close: s.close, adds, cuts, netShares,
        amount: s.close != null ? netShares * s.close : null,
        detail: ch.map(c => ({ ticker: c.ticker, prev: c.prev, cur: c.cur })),
      });
    }
    return { rows: out, buy: buyAmt, sell: sellAmt };
  }, [data, selected]);

  const sorted = useMemo(() => {
    const dir = sortAsc ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortKey === 'stock') return dir * a.stockid.localeCompare(b.stockid);
      if (sortKey === 'lots')  return dir * (a.netShares - b.netShares);
      // 金額排序以絕對值為準；無報價者排最後
      const av = a.amount == null ? -Infinity : Math.abs(a.amount);
      const bv = b.amount == null ? -Infinity : Math.abs(b.amount);
      return dir * (av - bv);
    });
  }, [rows, sortKey, sortAsc]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc(p => !p);
    else { setSortKey(key); setSortAsc(key === 'stock'); }
  };
  const label = (key: SortKey, text: string) => sortKey === key ? `${text} ${sortAsc ? '↑' : '↓'}` : text;

  const selFunds = data?.funds.filter(f => selected.includes(f.ticker)) ?? [];
  const curDates = [...new Set(selFunds.map(f => f.curDate).filter(Boolean))] as string[];
  const noPrev = selFunds.filter(f => f.curDate && !f.prevDate);

  const chip = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: 999, fontSize: '.8rem', fontFamily: MONO, cursor: 'pointer',
    border: `1px solid ${active ? RED : BORDER}`, background: active ? RED : '#fff', color: active ? '#fff' : TEXT,
  });

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>
      <div style={{ fontSize: '.82rem', color: SUB, marginBottom: 12, lineHeight: 1.6 }}>
        各檔 ETF 最新持股日 vs 前一個持股日的個股加減碼（原始股數變動，未扣除申購贖回稀釋）。
        金額 = 變動股數 × 最新持股日收盤價。
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        {(data?.funds ?? DEFAULT_TICKERS.map(t => ({ ticker: t, name: '' }))).map(f => (
          <button key={f.ticker} onClick={() => toggleTicker(f.ticker)} style={chip(selected.includes(f.ticker))}
            title={f.name}>{f.ticker}</button>
        ))}
        <button onClick={() => setSelected(DEFAULT_TICKERS)} style={{ ...chip(false), fontFamily: SANS }}>預設三檔</button>
        {data && <button onClick={() => setSelected(data.funds.map(f => f.ticker))} style={{ ...chip(false), fontFamily: SANS }}>全部 {data.funds.length} 檔</button>}
        <button onClick={load} disabled={loading}
          style={{ marginLeft: 'auto', padding: '6px 18px', background: loading ? '#999' : RED, color: '#fff', border: 'none', borderRadius: 6,
            cursor: loading ? 'not-allowed' : 'pointer', fontSize: '.84rem', fontWeight: 600, fontFamily: SANS }}>
          {loading ? '載入中…' : '重新整理'}
        </button>
      </div>

      {error && <div style={{ color: RED, marginBottom: 12, fontSize: '.85rem' }}>⚠ {error}</div>}
      {loading && !data && <div style={{ color: SUB, padding: 24 }}>載入中…（首次約需數十秒）</div>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 10, fontSize: '.88rem' }}>
            <span>異動日期 <b style={{ fontFamily: MONO }}>{curDates.length ? curDates.join(' / ') : '—'}</b></span>
            <span>變動個股 <b style={{ fontFamily: MONO }}>{rows.length}</b> 檔</span>
            <span>合計買超 <b style={{ fontFamily: MONO, color: RED }}>{fmtMoneyPlain(buy)}</b></span>
            <span>合計賣超 <b style={{ fontFamily: MONO, color: GREEN }}>{fmtMoneyPlain(sell)}</b></span>
          </div>
          {curDates.length > 1 && (
            <div style={{ fontSize: '.78rem', color: '#b45309', marginBottom: 8 }}>
              ⚠ 所選 ETF 的最新持股日不一致：{selFunds.map(f => `${f.ticker} ${f.curDate ?? '無資料'}`).join('、')}
            </div>
          )}
          {new Set(selFunds.filter(f => f.prevDate).map(f => f.prevDate)).size > 1 && (
            <div style={{ fontSize: '.78rem', color: '#b45309', marginBottom: 8 }}>
              ⚠ 比較基準日（前一持股日）不一致，較早者代表跨多個交易日的累計變動（可能是資料庫缺漏該日持股）：
              {selFunds.filter(f => f.prevDate).map(f => `${f.ticker} ${f.prevDate}→${f.curDate}`).join('、')}
            </div>
          )}
          {noPrev.length > 0 && (
            <div style={{ fontSize: '.78rem', color: '#b45309', marginBottom: 8 }}>
              ⚠ {noPrev.map(f => f.ticker).join('、')} 沒有前一持股日可比較，未納入。
            </div>
          )}

          {selected.length === 0 ? (
            <div style={{ color: SUB, padding: 24 }}>請至少選一檔 ETF。</div>
          ) : rows.length === 0 ? (
            <div style={{ color: SUB, padding: 24 }}>所選 ETF 最新一日沒有持股變動。</div>
          ) : (
            <div className="mt" style={{ overflowX: 'auto', maxHeight: '70vh', border: `1px solid ${BORDER}`, borderRadius: 6 }}>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ ...TH, textAlign: 'left', cursor: 'pointer' }} onClick={() => toggleSort('stock')}>{label('stock', '個股')}</th>
                    <th style={{ ...TH, textAlign: 'left' }}>加碼 / 新倉 ETF</th>
                    <th style={{ ...TH, textAlign: 'left' }}>減碼 / 清倉 ETF</th>
                    <th style={{ ...TH, textAlign: 'right', cursor: 'pointer' }} onClick={() => toggleSort('lots')}>{label('lots', '淨變動張數')}</th>
                    <th style={{ ...TH, textAlign: 'right', cursor: 'pointer' }} onClick={() => toggleSort('amount')}>{label('amount', '變動金額')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(r => {
                    const open = openId === r.stockid;
                    return (
                      <FragmentRow key={r.stockid} r={r} open={open} onToggle={() => setOpenId(open ? null : r.stockid)} />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Pills({ items }: { items: Pill[] }) {
  if (!items.length) return <span style={{ color: SUB }}>—</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {items.map(p => {
        const c = dirColor(p.shares);
        return (
          <span key={p.ticker} className="m-pill" style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 12px', borderRadius: 999,
            border: `1px solid ${c}`, background: p.shares > 0 ? '#FDECEC' : '#E8F7EE',
            fontFamily: MONO, fontSize: '.8rem', whiteSpace: 'nowrap',
          }}>
            <b style={{ color: TEXT }}>{p.ticker}</b>
            {p.tag && <span style={{ color: c, fontSize: '.68rem' }}>({p.tag})</span>}
            <span style={{ color: c }}>{p.amount != null ? fmtMoney(p.amount) : `${fmtLots(p.shares)} 張`}</span>
          </span>
        );
      })}
    </div>
  );
}

function FragmentRow({ r, open, onToggle }: { r: Row; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer', background: open ? '#FAF7F4' : undefined }}>
        <td style={TD}>
          <span style={{ fontFamily: MONO, color: SUB, marginRight: 8 }}>{r.stockid}</span>
          <b>{r.stockname}</b>
        </td>
        <td style={TD}><Pills items={r.adds} /></td>
        <td style={TD}><Pills items={r.cuts} /></td>
        <td style={{ ...TD, textAlign: 'right', fontFamily: MONO, color: dirColor(r.netShares) }}>{fmtLots(r.netShares)}</td>
        <td style={{ ...TD, textAlign: 'right', fontFamily: MONO, color: dirColor(r.amount) }}>
          {r.amount == null ? <span style={{ color: SUB }}>—</span> : fmtMoney(r.amount)}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ ...TD, background: '#FAF7F4', padding: '10px 14px 14px' }}>
            <div style={{ fontSize: '.78rem', color: SUB, marginBottom: 6 }}>
              各檔持股張數（前一日 → 最新）{r.close != null ? `　收盤價 ${r.close}` : '　（無報價）'}
            </div>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontFamily: MONO, fontSize: '.8rem' }}>
              {r.detail.map(d => {
                const delta = d.cur - d.prev;
                return (
                  <span key={d.ticker}>
                    {d.ticker}　{(d.prev / 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })} → {(d.cur / 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                    <b style={{ color: dirColor(delta), marginLeft: 6 }}>({fmtLots(delta)})</b>
                  </span>
                );
              })}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
