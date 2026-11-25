'use client';
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import { OVERSEAS_FUNDS } from '@/lib/overseasFunds';
import type { TradeFollowResult, TradeResult, AllocationRow, TradeType } from '@/lib/tradeFollow';

/* 換股追蹤分頁（海外主動式 ETF）
   經理人新增／加碼後股票有沒有漲（買對 vs 買錯）、減碼／出清後是不是反而漲了（賣飛 vs 賣對），
   以及目前配置 vs 約 20 個交易日前。算法說明見 lib/tradeFollow.ts 與頁尾註腳。
   台股配色慣例：紅＝漲、綠＝跌。 */

const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#E8E3DF';
const CARD   = '#FFFFFF';
const UP     = '#C00000';
const DOWN   = '#1A6B45';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

type Win = 'd5' | 'd20' | 'd60' | 'now';
type Basis = 'abs' | 'rel';
type Verdict = 'buyGood' | 'buyBad' | 'sellMissed' | 'sellGood';

const WIN_LABEL: Record<Win, string> = { d5: '之後5日', d20: '之後20日', d60: '之後60日', now: '至今' };
const TYPE_LABEL: Record<TradeType, string> = { new: '新增', add: '加碼', trim: '減碼', exit: '出清' };
const TYPE_COLOR: Record<TradeType, string> = { new: UP, add: '#E26D5C', trim: '#4F8A6B', exit: DOWN };
const VERDICT: Record<Verdict, { label: string; desc: string; color: string; bg: string }> = {
  buyGood:    { label: '買對了', desc: '新增／加碼後上漲', color: UP,   bg: '#FEF2F2' },
  buyBad:     { label: '買錯了', desc: '新增／加碼後下跌', color: DOWN, bg: '#F0FDF4' },
  sellMissed: { label: '賣飛了', desc: '減碼／出清後反而上漲', color: '#B45309', bg: '#FFFBEB' },
  sellGood:   { label: '賣對了', desc: '減碼／出清後下跌', color: '#1D4ED8', bg: '#EFF6FF' },
};

const fmtPct = (v: number | null | undefined, d = 1) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const fmtW = (v: number) => `${v.toFixed(2)}%`;
const col = (v: number | null | undefined) => v == null ? SUB : v > 0 ? UP : v < 0 ? DOWN : SUB;
const shortId = (raw: string) => raw.split(/\s+/)[0];

function isoDaysAgo(n: number): string {
  const t = new Date(Date.now() + 8 * 3600 * 1000 - n * 86400000);
  return t.toISOString().slice(0, 10);
}

function verdictOf(t: TradeResult, win: Win, basis: Basis): Verdict | null {
  const v = (basis === 'abs' ? t.ret : t.rel)[win];
  if (v == null || v === 0) return null;
  if (t.side === 'buy') return v > 0 ? 'buyGood' : 'buyBad';
  return v > 0 ? 'sellMissed' : 'sellGood';
}

const inputStyle: React.CSSProperties = {
  padding: '8px 11px', border: `1px solid ${BORDER}`, borderRadius: 6,
  fontSize: '.87rem', color: TEXT, background: CARD, fontFamily: MONO, minWidth: 140,
};
const card: React.CSSProperties = {
  background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '16px 18px',
  boxShadow: '0 1px 6px rgba(0,0,0,.05)',
};
const th: React.CSSProperties = {
  padding: '8px 10px', fontWeight: 600, fontSize: '.73rem', background: TEXT, color: '#fff',
  whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1, textAlign: 'right', cursor: 'pointer', userSelect: 'none',
};
const td: React.CSSProperties = { padding: '7px 10px', fontFamily: MONO, fontSize: '.8rem', textAlign: 'right', whiteSpace: 'nowrap' };

function seg(active: boolean): React.CSSProperties {
  return {
    padding: '6px 14px', background: active ? TEXT : CARD, color: active ? '#fff' : SUB,
    border: `1px solid ${active ? TEXT : BORDER}`, borderRadius: 999, cursor: 'pointer',
    fontSize: '.8rem', fontWeight: 600, fontFamily: SANS,
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label style={{ fontSize: '.74rem', color: SUB, fontWeight: 500 }}>{label}</label>
      {children}
    </div>
  );
}

/* 「漲最多」精選清單：買進後漲最多／賣出後漲最多 */
function TopList({ title, hint, list, win, basis }: { title: string; hint: string; list: TradeResult[]; win: Win; basis: Basis }) {
  return (
    <div style={card}>
      <h3 style={{ margin: 0, fontSize: '.95rem', color: TEXT, fontWeight: 700 }}>{title}</h3>
      <p style={{ margin: '4px 0 10px', fontSize: '.75rem', color: SUB }}>{hint}</p>
      {list.length === 0 && <p style={{ color: '#AAA', fontSize: '.85rem', margin: '8px 0' }}>無</p>}
      {list.map((t, i) => {
        const v = (basis === 'abs' ? t.ret : t.rel)[win];
        return (
          <div key={`${t.id}-${t.date}`} style={{ display: 'grid', gridTemplateColumns: '18px 64px 1fr auto 70px', gap: 8,
            alignItems: 'center', padding: '7px 0', borderBottom: '1px solid #F0ECE8', fontSize: '.83rem' }}>
            <span style={{ color: '#A8A29E', fontFamily: MONO, fontSize: '.72rem' }}>{i + 1}</span>
            <span style={{ fontFamily: MONO, color: SUB }}>{shortId(t.rawId)}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: TEXT }}>{t.name}</span>
            <span style={{ fontSize: '.72rem', color: TYPE_COLOR[t.type], fontWeight: 600, whiteSpace: 'nowrap' }}>
              {t.date.slice(5)} {TYPE_LABEL[t.type]}
            </span>
            <span style={{ fontFamily: MONO, textAlign: 'right', fontWeight: 700, color: col(v) }}>{fmtPct(v)}</span>
          </div>
        );
      })}
    </div>
  );
}

type SortKey = 'date' | 'name' | 'type' | 'wb' | 'wa' | Win;

export default function TradeFollowTab() {
  const [fund, setFund]   = useState('00409A');
  const [start, setStart] = useState(isoDaysAgo(90));
  const [end, setEnd]     = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr]     = useState('');
  const [res, setRes]     = useState<TradeFollowResult | null>(null);

  const [win, setWin]     = useState<Win>('now');
  const [basis, setBasis] = useState<Basis>('abs');
  const [typeFilter, setTypeFilter] = useState<'all' | TradeType>('all');
  const [verdictFilter, setVerdictFilter] = useState<Verdict | null>(null);
  const [q, setQ]         = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortAsc, setSortAsc] = useState(false);
  const autoRan = useRef(false);

  const run = useCallback(async () => {
    setLoading(true); setErr(''); setRes(null); setVerdictFilter(null);
    try {
      const qs = new URLSearchParams({ fund, start, end });
      const r = await fetch(`/api/trade-follow?${qs}`, { cache: 'no-store' });
      const json = await r.json();
      if (json.error) { setErr(json.error); return; }
      setRes(json as TradeFollowResult);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '查詢失敗');
    } finally { setLoading(false); }
  }, [fund, start, end]);

  useEffect(() => { if (!autoRan.current) { autoRan.current = true; run(); } }, [run]);

  const trades = useMemo(() => res?.trades ?? [], [res]);
  const valOf = useCallback((t: TradeResult) => (basis === 'abs' ? t.ret : t.rel)[win], [basis, win]);

  const stats = useMemo(() => {
    const out: Record<Verdict, { n: number; sum: number }> = {
      buyGood: { n: 0, sum: 0 }, buyBad: { n: 0, sum: 0 }, sellMissed: { n: 0, sum: 0 }, sellGood: { n: 0, sum: 0 },
    };
    let buyEval = 0, sellEval = 0;
    for (const t of trades) {
      const v = verdictOf(t, win, basis);
      if (!v) continue;
      out[v].n++; out[v].sum += valOf(t)!;
      if (t.side === 'buy') buyEval++; else sellEval++;
    }
    return { out, buyEval, sellEval };
  }, [trades, win, basis, valOf]);

  const topBuys = useMemo(() => trades.filter(t => t.side === 'buy' && (valOf(t) ?? 0) > 0)
    .sort((a, b) => valOf(b)! - valOf(a)!).slice(0, 10), [trades, valOf]);
  const topMissed = useMemo(() => trades.filter(t => t.side === 'sell' && (valOf(t) ?? 0) > 0)
    .sort((a, b) => valOf(b)! - valOf(a)!).slice(0, 10), [trades, valOf]);

  const rows = useMemo(() => {
    const kw = q.trim().toUpperCase();
    const list = trades.filter(t =>
      (typeFilter === 'all' || t.type === typeFilter) &&
      (!verdictFilter || verdictOf(t, win, basis) === verdictFilter) &&
      (!kw || t.rawId.toUpperCase().includes(kw) || t.name.toUpperCase().includes(kw)));
    const key = (t: TradeResult): string | number | null => {
      switch (sortKey) {
        case 'date': return t.date;
        case 'name': return t.rawId;
        case 'type': return t.type;
        case 'wb': return t.weightBefore;
        case 'wa': return t.weightAfter;
        default: return (basis === 'abs' ? t.ret : t.rel)[sortKey];
      }
    };
    return [...list].sort((a, b) => {
      const x = key(a), y = key(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sortAsc ? c : -c;
    });
  }, [trades, typeFilter, verdictFilter, q, sortKey, sortAsc, win, basis]);

  const clickSort = (k: SortKey) => {
    if (sortKey === k) setSortAsc(!sortAsc);
    else { setSortKey(k); setSortAsc(k === 'name' || k === 'type'); }
  };
  const arrow = (k: SortKey) => sortKey === k ? (sortAsc ? ' ▲' : ' ▼') : '';

  const exportXlsx = () => {
    if (!res) return;
    const basisLbl = basis === 'abs' ? '個股報酬' : `相對${res.fund}`;
    const aoa: (string | number | null)[][] = [
      [`${res.fund} ${res.fundName} 換股追蹤`, `換股日 ${res.start} ~ ${res.end}`, `口徑：${basisLbl}（新台幣、還原權息）`],
      [],
      ['換股日', '連續天數', '代號', '名稱', '動作', '調整前權重%', '調整後權重%',
        ...(['d5', 'd20', 'd60', 'now'] as Win[]).flatMap(w => [`${WIN_LABEL[w]} 個股%`, `${WIN_LABEL[w]} 相對%`]), '判斷（依目前選的期間/口徑）'],
      ...rows.map(t => {
        const v = verdictOf(t, win, basis);
        return [t.date, t.days, t.rawId, t.name, TYPE_LABEL[t.type], +t.weightBefore.toFixed(2), +t.weightAfter.toFixed(2),
          ...(['d5', 'd20', 'd60', 'now'] as Win[]).flatMap(w => [
            t.ret[w] == null ? null : +t.ret[w]!.toFixed(2), t.rel[w] == null ? null : +t.rel[w]!.toFixed(2)]),
          v ? VERDICT[v].label : ''];
      }),
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '換股追蹤');
    const alloc: (string | number)[][] = [
      ['代號', '名稱', '目前權重%', `${res.allocPrevDate} 權重%`, '變化(百分點)', '備註'],
      ...res.allocation.map(a => [a.rawId, a.name, +a.weight.toFixed(2), +a.weightPrev.toFixed(2), +(a.weight - a.weightPrev).toFixed(2), a.isNew ? '新進' : '']),
      ...res.exitedRecently.map(a => [a.rawId, a.name, 0, +a.weightPrev.toFixed(2), +(-a.weightPrev).toFixed(2), '已出清']),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(alloc), '目前配置');
    XLSX.writeFile(wb, `換股追蹤_${res.fund}_${res.start}_${res.end}.xlsx`);
  };

  const winCols: Win[] = ['d5', 'd20', 'd60', 'now'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontFamily: SANS, color: TEXT }}>
      {/* ── 查詢條件 ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <Field label="基金">
          <select value={fund} onChange={e => setFund(e.target.value)} style={{ ...inputStyle, fontFamily: SANS, minWidth: 200 }}>
            {OVERSEAS_FUNDS.map(f => <option key={f.ticker} value={f.ticker}>{f.ticker} {f.name}</option>)}
          </select>
        </Field>
        <Field label="換股日 起">
          <input type="date" value={start} onChange={e => setStart(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="換股日 迄（空白＝今天）">
          <input type="date" value={end} onChange={e => setEnd(e.target.value)} style={inputStyle} />
        </Field>
        <button onClick={run} disabled={loading} style={{
          padding: '9px 22px', background: loading ? '#999' : UP, color: '#fff', border: 'none', borderRadius: 6,
          cursor: loading ? 'default' : 'pointer', fontSize: '.87rem', fontWeight: 700, fontFamily: SANS }}>
          {loading ? '計算中…' : '查詢'}
        </button>
        {res && <button onClick={exportXlsx} style={{ ...seg(false), borderRadius: 6, padding: '8px 14px' }}>匯出 Excel</button>}
      </div>
      {loading && <p style={{ color: SUB, fontSize: '.85rem', margin: 0 }}>第一次查詢要逐檔抓海外股價與匯率，約需 30–90 秒…</p>}
      {err && <p style={{ color: UP, fontSize: '.88rem', margin: 0 }}>⚠ {err}</p>}

      {res && (<>
        {res.warning && <p style={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 6, padding: '8px 12px', fontSize: '.8rem', margin: 0 }}>{res.warning}</p>}

        {/* ── 目前配置 ── */}
        <div style={card}>
          <h3 style={{ margin: 0, fontSize: '.95rem', fontWeight: 700 }}>
            目前配置　<span style={{ fontWeight: 400, fontSize: '.78rem', color: SUB }}>
              持股日 {res.asOf}（{res.holdingsCount} 檔），對照約 20 個交易日前 {res.allocPrevDate}
            </span>
          </h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginTop: 10 }}>
            <div style={{ flex: '2 1 420px', maxHeight: 420, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={{ ...th, textAlign: 'left', cursor: 'default' }}>代號</th>
                  <th style={{ ...th, textAlign: 'left', cursor: 'default' }}>名稱</th>
                  <th style={{ ...th, cursor: 'default' }}>目前權重</th>
                  <th style={{ ...th, cursor: 'default' }}>20日前</th>
                  <th style={{ ...th, cursor: 'default' }}>變化</th>
                </tr></thead>
                <tbody>
                  {res.allocation.map((a: AllocationRow) => {
                    const d = a.weight - a.weightPrev;
                    return (
                      <tr key={a.id} style={{ borderBottom: '1px solid #F0ECE8' }}>
                        <td style={{ ...td, textAlign: 'left', color: SUB }}>{shortId(a.rawId)}</td>
                        <td style={{ ...td, textAlign: 'left', fontFamily: SANS, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {a.name}{a.isNew && <span style={{ marginLeft: 6, fontSize: '.68rem', color: '#fff', background: UP, borderRadius: 4, padding: '1px 5px' }}>新進</span>}
                        </td>
                        <td style={{ ...td, fontWeight: 700 }}>{fmtW(a.weight)}</td>
                        <td style={{ ...td, color: SUB }}>{a.isNew ? '—' : fmtW(a.weightPrev)}</td>
                        <td style={{ ...td, color: col(d) }}>{Math.abs(d) < 0.005 ? '—' : `${d > 0 ? '+' : ''}${d.toFixed(2)}`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ flex: '1 1 220px' }}>
              <h4 style={{ margin: '0 0 8px', fontSize: '.85rem', color: DOWN }}>近 20 日已出清（{res.exitedRecently.length} 檔）</h4>
              {res.exitedRecently.length === 0 && <p style={{ color: '#AAA', fontSize: '.82rem' }}>無</p>}
              {res.exitedRecently.map(a => (
                <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '5px 0', borderBottom: '1px solid #F0ECE8', fontSize: '.8rem' }}>
                  <span><span style={{ fontFamily: MONO, color: SUB }}>{shortId(a.rawId)}</span> {a.name}</span>
                  <span style={{ fontFamily: MONO, color: SUB, whiteSpace: 'nowrap' }}>原 {fmtW(a.weightPrev)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── 判斷期間 / 口徑 ── */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '.78rem', color: SUB }}>換股後期間</span>
            {winCols.map(w => <button key={w} style={seg(win === w)} onClick={() => setWin(w)}>{WIN_LABEL[w]}</button>)}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '.78rem', color: SUB }}>漲跌口徑</span>
            <button style={seg(basis === 'abs')} onClick={() => setBasis('abs')}>個股本身漲跌</button>
            <button style={seg(basis === 'rel')} onClick={() => setBasis('rel')}>相對 {res.fund}</button>
          </div>
        </div>

        {/* ── 四格總結 ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          {(Object.keys(VERDICT) as Verdict[]).map(k => {
            const s = stats.out[k];
            const denom = k.startsWith('buy') ? stats.buyEval : stats.sellEval;
            const active = verdictFilter === k;
            return (
              <button key={k} onClick={() => setVerdictFilter(active ? null : k)} style={{
                ...card, padding: '12px 14px', textAlign: 'left', cursor: 'pointer', background: VERDICT[k].bg,
                outline: active ? `2px solid ${VERDICT[k].color}` : 'none', fontFamily: SANS }}>
                <div style={{ fontSize: '.95rem', fontWeight: 700, color: VERDICT[k].color }}>{VERDICT[k].label}</div>
                <div style={{ fontSize: '.72rem', color: SUB, marginBottom: 6 }}>{VERDICT[k].desc}</div>
                <div style={{ fontFamily: MONO, fontSize: '1.3rem', fontWeight: 700, color: TEXT }}>
                  {s.n} <span style={{ fontSize: '.78rem', color: SUB, fontWeight: 400 }}>/ {denom} 筆{denom ? `（${(s.n / denom * 100).toFixed(0)}%）` : ''}</span>
                </div>
                <div style={{ fontSize: '.75rem', color: SUB }}>平均 <span style={{ fontFamily: MONO, color: col(s.n ? s.sum / s.n : null) }}>{fmtPct(s.n ? s.sum / s.n : null)}</span></div>
              </button>
            );
          })}
        </div>

        {/* ── 漲最多清單 ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
          <TopList title="買進後漲最多" hint={`新增／加碼之後（${WIN_LABEL[win]}）漲幅前 10 名`} list={topBuys} win={win} basis={basis} />
          <TopList title="賣出後反而漲最多（賣飛）" hint={`減碼／出清之後（${WIN_LABEL[win]}）漲幅前 10 名`} list={topMissed} win={win} basis={basis} />
        </div>

        {/* ── 全部換股明細 ── */}
        <div style={card}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: '.95rem', fontWeight: 700, marginRight: 8 }}>全部換股明細</h3>
            {(['all', 'new', 'add', 'trim', 'exit'] as const).map(k => (
              <button key={k} style={seg(typeFilter === k)} onClick={() => setTypeFilter(k)}>
                {k === 'all' ? '全部' : TYPE_LABEL[k]}（{k === 'all' ? trades.length : trades.filter(t => t.type === k).length}）
              </button>
            ))}
            <input placeholder="搜尋代號或名稱" value={q} onChange={e => setQ(e.target.value)} style={{ ...inputStyle, fontFamily: SANS, minWidth: 160, padding: '6px 10px' }} />
            {verdictFilter && (
              <button style={{ ...seg(true), background: VERDICT[verdictFilter].color, borderColor: VERDICT[verdictFilter].color }} onClick={() => setVerdictFilter(null)}>
                只看「{VERDICT[verdictFilter].label}」 ✕
              </button>
            )}
          </div>
          <div style={{ overflow: 'auto', maxHeight: 560 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
              <thead><tr>
                <th style={{ ...th, textAlign: 'left' }} onClick={() => clickSort('date')}>換股日{arrow('date')}</th>
                <th style={{ ...th, textAlign: 'left' }} onClick={() => clickSort('name')}>股票{arrow('name')}</th>
                <th style={{ ...th, textAlign: 'center' }} onClick={() => clickSort('type')}>動作{arrow('type')}</th>
                <th style={th} onClick={() => clickSort('wb')}>調整前{arrow('wb')}</th>
                <th style={th} onClick={() => clickSort('wa')}>調整後{arrow('wa')}</th>
                {winCols.map(w => (
                  <th key={w} style={{ ...th, background: w === win ? UP : TEXT }} onClick={() => clickSort(w)}>{WIN_LABEL[w]}{arrow(w)}</th>
                ))}
                <th style={{ ...th, textAlign: 'center', cursor: 'default' }}>判斷</th>
              </tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={10} style={{ ...td, textAlign: 'center', color: '#AAA', fontFamily: SANS }}>這段期間沒有符合條件的換股</td></tr>}
                {rows.map(t => {
                  const v = verdictOf(t, win, basis);
                  const src = basis === 'abs' ? t.ret : t.rel;
                  return (
                    <tr key={`${t.id}-${t.date}`} style={{ borderBottom: '1px solid #F0ECE8' }}>
                      <td style={{ ...td, textAlign: 'left', color: SUB }}>
                        {t.date.slice(5)}{t.days > 1 && <span style={{ fontSize: '.68rem' }}>（連{t.days}天）</span>}
                      </td>
                      <td style={{ ...td, textAlign: 'left', fontFamily: SANS, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        <span style={{ fontFamily: MONO, color: SUB, marginRight: 6 }}>{shortId(t.rawId)}</span>{t.name}
                      </td>
                      <td style={{ ...td, textAlign: 'center', fontFamily: SANS, color: TYPE_COLOR[t.type], fontWeight: 700 }}>{TYPE_LABEL[t.type]}</td>
                      <td style={{ ...td, color: SUB }}>{t.weightBefore ? fmtW(t.weightBefore) : '—'}</td>
                      <td style={{ ...td, color: SUB }}>{t.weightAfter ? fmtW(t.weightAfter) : '—'}</td>
                      {winCols.map(w => (
                        <td key={w} style={{ ...td, color: col(src[w]), fontWeight: w === win ? 700 : 400, background: w === win ? '#FFF7F5' : undefined }}>
                          {t.priced ? fmtPct(src[w]) : '無報價'}
                        </td>
                      ))}
                      <td style={{ ...td, textAlign: 'center', fontFamily: SANS }}>
                        {v ? <span style={{ color: VERDICT[v].color, background: VERDICT[v].bg, borderRadius: 4, padding: '2px 6px', fontSize: '.74rem', fontWeight: 700 }}>{VERDICT[v].label}</span> : <span style={{ color: '#AAA' }}>—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── 註腳 ── */}
        <div style={{ fontSize: '.74rem', color: SUB, lineHeight: 1.7 }}>
          <p style={{ margin: '0 0 4px', fontWeight: 600 }}>怎麼算的</p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li><b>新增／出清</b>：前一份持股沒有、這一份有＝新增；前一份有、這一份沒有＝出清。</li>
            <li><b>加碼／減碼</b>：ETF 每天有申購買回，所有持股股數會一起等比例變動，那不算經理人換股。所以先扣掉當天全體持股的共同變動，個股股數再多（少）10% 以上才算加碼（減碼）。</li>
            <li>同一檔股票連續幾天同方向調整，合併成一筆，日期記第一天。股票分割造成的股數倍增不算加碼。</li>
            <li><b>換股後漲跌</b>：以換股日（持股公布日）收盤為基準，計算之後第 5／20／60 個交易日，以及到最新一天的報酬。海外股換算成新台幣、含配息（還原權息），與基金同口徑。還沒走滿的期間顯示「—」。</li>
            <li><b>相對 {res.fund}</b>：個股報酬減去同期間 {res.fund} 本身市價報酬。正值代表這檔股票比基金整體強。</li>
            <li>海外持股的公布日與實際交易時間可能差一天（時差），短期間（5 日）的數字僅供參考。</li>
            {res.skippedDates.length > 0 && <li>略過的持股日（疑似資料不完整）：{res.skippedDates.join('、')}</li>}
            {res.unpriced.length > 0 && <li>抓不到報價、無法評估：{res.unpriced.join('、')}</li>}
          </ul>
        </div>
      </>)}
    </div>
  );
}
