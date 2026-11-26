'use client';
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import { OVERSEAS_FUNDS } from '@/lib/overseasFunds';
import type { TradeFollowResult, TradeResult, TradeType } from '@/lib/tradeFollow';

/* 換股追蹤分頁（海外主動式 ETF）
   經理人新增／加碼後股票有沒有漲（買對 vs 買錯）、減碼／出清後是不是反而漲了（賣飛 vs 賣對），
   以及每檔股票的換股對淨值的影響（權重變化 × 之後漲跌）。算法說明見 lib/tradeFollow.ts 與頁尾註腳。
   台股配色慣例：紅＝漲、綠＝跌。 */

const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#E8E3DF';
const CARD   = '#FFFFFF';
const UP     = '#C00000';
const DOWN   = '#1A6B45';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

type Win = 'seg' | 'd5' | 'd20' | 'd60' | 'now';
type Basis = 'abs' | 'rel';
type Verdict = 'buyGood' | 'buyBad' | 'sellMissed' | 'sellGood';

const WIN_LABEL: Record<Win, string> = { seg: '到下次動作', d5: '之後5日', d20: '之後20日', d60: '之後60日', now: '至今' };
const ALL_WINS: Win[] = ['seg', 'd5', 'd20', 'd60', 'now'];
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

/* 每一段（這次操作 → 同一檔下一次動作）對淨值的影響，單位：百分點。
   hold  持有貢獻＝這段期間實際持有的權重（操作後權重）× 這段漲跌 → 實際替淨值賺／賠多少。
   avoid 賣出後錯過／避開＝這次賣掉的權重（減碼的部分、或出清前全部）× 這段漲跌 × (−1)
         → 賣後漲＝負（錯過、少賺），賣後跌＝正（避開虧損）。買進操作沒有這一項。
   total 合計＝hold + avoid，用來排「做對／做錯」。 */
interface Impact { hold: number; avoid: number; total: number }
function impactOf(t: TradeResult, win: Win, basis: Basis): Impact | null {
  const v = (basis === 'abs' ? t.ret : t.rel)[win];
  if (v == null) return null;
  const hold = t.weightAfter / 100 * v;
  const avoid = t.side === 'sell' ? -Math.max(0, t.weightBefore - t.weightAfter) / 100 * v : 0;
  return { hold, avoid, total: hold + avoid };
}
const fmtPP = (v: number | null | undefined) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

interface StockImpact { id: string; rawId: string; name: string; total: number; hold: number; avoid: number; n: number }
function sumImpacts(list: TradeResult[], win: Win, basis: Basis): Impact | null {
  let hold = 0, avoid = 0, any = false;
  for (const t of list) { const x = impactOf(t, win, basis); if (x) { any = true; hold += x.hold; avoid += x.avoid; } }
  return any ? { hold, avoid, total: hold + avoid } : null;
}

/* 換股總結：做對／做錯的個股，依對淨值影響排名 */
function SummaryList({ title, color, list, onPick }: { title: string; color: string; list: StockImpact[]; onPick: (s: StockImpact) => void }) {
  return (
    <div style={{ flex: '1 1 340px' }}>
      <h4 style={{ margin: '0 0 6px', fontSize: '.9rem', color }}>{title}</h4>
      {list.length === 0 && <p style={{ color: '#AAA', fontSize: '.82rem', margin: '6px 0' }}>無</p>}
      {list.map((s, i) => (
        <div key={s.id} onClick={() => onPick(s)} title="點一下看這檔的完整換股歷程" style={{
          display: 'grid', gridTemplateColumns: '18px minmax(0,1fr) auto', gap: 8, alignItems: 'center',
          padding: '7px 0', borderBottom: '1px solid #F0ECE8', fontSize: '.83rem', cursor: 'pointer' }}>
          <span style={{ color: '#A8A29E', fontFamily: MONO, fontSize: '.72rem' }}>{i + 1}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ fontFamily: MONO, color: SUB, marginRight: 6 }}>{shortId(s.rawId)}</span>{s.name}
            <span style={{ display: 'block', fontSize: '.7rem', color: SUB }}>
              {s.n} 次操作｜持有貢獻 <span style={{ fontFamily: MONO, color: col(s.hold) }}>{fmtPP(s.hold)}</span>
              {' '}／賣出後錯過或避開 <span style={{ fontFamily: MONO, color: col(s.avoid) }}>{fmtPP(s.avoid)}</span>
            </span>
          </span>
          <span style={{ fontFamily: MONO, fontWeight: 700, color: col(s.total), fontSize: '.9rem' }}>{fmtPP(s.total)}</span>
        </div>
      ))}
    </div>
  );
}

type SortKey = 'date' | 'name' | 'type' | 'wb' | 'wa' | Win;

/* seg 欄的小字：算到哪一天、被什麼操作結束 */
function segNote(t: TradeResult): string {
  if (!t.segEnd) return '';
  return t.segEndBy ? `至 ${t.segEnd.slice(5)} ${TYPE_LABEL[t.segEndBy]}` : (t.type === 'exit' ? '之後未再買回' : '之後無動作');
}

/* 依股票看：一檔股票一列，依時間列出每次操作與該段漲跌；欄位可排序 */
type StockSortKey = 'name' | 'weight' | 'hold' | 'avoid' | 'total' | 'n' | 'last';

function StockTimeline({ trades, win, basis, weightOf }: {
  trades: TradeResult[]; win: Win; basis: Basis; weightOf: (id: string) => number;
}) {
  const [sortKey, setSortKey] = useState<StockSortKey>('total');
  const [asc, setAsc] = useState(false);
  const groups = useMemo(() => {
    const m = new Map<string, TradeResult[]>();
    for (const t of trades) { const l = m.get(t.id) ?? []; l.push(t); m.set(t.id, l); }
    return [...m.values()].map(l => {
      const list = [...l].sort((a, b) => a.date.localeCompare(b.date));
      const imp = sumImpacts(list, win, basis);
      return {
        id: list[0].id, rawId: list[0].rawId, name: list[0].name, list,
        weight: weightOf(list[0].id),
        hold: imp?.hold ?? null, avoid: imp?.avoid ?? null, total: imp?.total ?? null,
        n: list.length, last: list[list.length - 1].date,
      };
    });
  }, [trades, win, basis, weightOf]);
  const sorted = useMemo(() => [...groups].sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    if (x == null && y == null) return 0;
    if (x == null) return 1;            // 無數值一律排最後
    if (y == null) return -1;
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(sortKey === 'name' ? a.rawId : x).localeCompare(String(sortKey === 'name' ? b.rawId : y));
    return asc ? c : -c;
  }), [groups, sortKey, asc]);
  const click = (k: StockSortKey) => {
    if (sortKey === k) setAsc(!asc);
    else { setSortKey(k); setAsc(k === 'name'); }
  };
  const arrow = (k: StockSortKey) => sortKey === k ? (asc ? ' ▲' : ' ▼') : '';

  if (groups.length === 0) return <p style={{ color: '#AAA', fontSize: '.85rem', textAlign: 'center' }}>這段期間沒有符合條件的換股</p>;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
      <thead><tr>
        <th style={{ ...th, textAlign: 'left' }} onClick={() => click('name')}>股票{arrow('name')}</th>
        <th style={th} onClick={() => click('weight')}>目前權重{arrow('weight')}</th>
        <th style={th} onClick={() => click('hold')} title="期間內實際持有的權重 × 漲跌">持有貢獻{arrow('hold')}</th>
        <th style={th} onClick={() => click('avoid')} title="賣掉的權重 × 賣出後漲跌：負＝錯過（少賺），正＝避開虧損">賣出後錯過／避開{arrow('avoid')}</th>
        <th style={th} onClick={() => click('total')}>合計{arrow('total')}</th>
        <th style={th} onClick={() => click('n')}>操作次數{arrow('n')}</th>
        <th style={th} onClick={() => click('last')}>最近動作{arrow('last')}</th>
        <th style={{ ...th, textAlign: 'left', cursor: 'default' }}>換股歷程（{WIN_LABEL[win]}的漲跌）</th>
      </tr></thead>
      <tbody>
        {sorted.map(g => (
          <tr key={g.id} style={{ borderBottom: '1px solid #F0ECE8', verticalAlign: 'top' }}>
            <td style={{ ...td, textAlign: 'left', fontFamily: SANS, minWidth: 150, maxWidth: 210, whiteSpace: 'normal' }}>
              <span style={{ fontFamily: MONO, color: SUB, marginRight: 6 }}>{shortId(g.rawId)}</span>{g.name}
            </td>
            <td style={{ ...td, color: g.weight > 0 ? TEXT : '#A8A29E' }}>{g.weight > 0 ? fmtW(g.weight) : '未持有'}</td>
            <td style={{ ...td, color: col(g.hold) }}>{fmtPP(g.hold)}</td>
            <td style={{ ...td, color: col(g.avoid) }}>{g.avoid ? fmtPP(g.avoid) : '—'}</td>
            <td style={{ ...td, fontWeight: 700, color: col(g.total) }}>{fmtPP(g.total)}</td>
            <td style={{ ...td, color: SUB }}>{g.n}</td>
            <td style={{ ...td, color: SUB }}>{g.last.slice(5)}</td>
            <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                {g.list.map((t, i) => {
                  const v = (basis === 'abs' ? t.ret : t.rel)[win];
                  const vd = verdictOf(t, win, basis);
                  return (
                    <span key={t.date} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {i > 0 && <span style={{ color: '#C8C2BC' }}>→</span>}
                      <span title={vd ? `${VERDICT[vd].label}（${VERDICT[vd].desc}）` : '期間未走完或無報價'} style={{
                        display: 'inline-flex', gap: 5, alignItems: 'baseline', padding: '3px 8px', borderRadius: 6,
                        background: vd ? VERDICT[vd].bg : '#F5F3F0', border: `1px solid ${vd ? VERDICT[vd].color + '55' : BORDER}`,
                        fontSize: '.76rem', whiteSpace: 'nowrap', fontFamily: SANS }}>
                        <span style={{ fontFamily: MONO, color: SUB }}>{t.date.slice(5)}</span>
                        <span style={{ color: TYPE_COLOR[t.type], fontWeight: 700 }}>{TYPE_LABEL[t.type]}</span>
                        <span style={{ fontFamily: MONO, fontWeight: 700, color: col(v) }}>{t.priced ? fmtPct(v) : '無報價'}</span>
                        {vd && <span style={{ color: VERDICT[vd].color, fontWeight: 700 }}>{VERDICT[vd].label}</span>}
                      </span>
                    </span>
                  );
                })}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ── 近期操作：近 N 份持股內的換股，依產業彙總加減碼方向與操作後表現 ── */
interface SectorRow {
  sector: string; net: number;
  buys: TradeResult[]; sells: TradeResult[];
  buyPerf: number | null; sellPerf: number | null;   // 依權重變化加權的操作後至今漲跌
  buyN: number; buyGood: number; sellN: number; sellGood: number;
}
const toIso = (d: string) => d.replace(/\//g, '-');
const dW = (t: TradeResult) => t.weightAfter - t.weightBefore;

function RecentOps({ res, basis }: { res: TradeFollowResult; basis: Basis }) {
  const [n, setN] = useState<5 | 10 | 20>(5);
  const dates = res.recentDates ?? [];
  const from = dates[Math.min(n, dates.length) - 1];
  const latest = dates[0];
  const valOf = (t: TradeResult) => (basis === 'abs' ? t.ret : t.rel).now;

  const { rows, recent, tot } = useMemo(() => {
    const recent = from ? res.trades.filter(t => toIso(t.date) >= from) : [];
    const by = new Map<string, SectorRow>();
    const tot = { buyN: 0, buyGood: 0, sellN: 0, sellGood: 0, buyW: 0, buyS: 0, sellW: 0, sellS: 0 };
    for (const t of recent) {
      const sec = res.sectors?.[t.id] ?? '其他／未分類';
      const r = by.get(sec) ?? { sector: sec, net: 0, buys: [], sells: [], buyPerf: null, sellPerf: null, buyN: 0, buyGood: 0, sellN: 0, sellGood: 0 };
      r.net += dW(t);
      (t.side === 'buy' ? r.buys : r.sells).push(t);
      by.set(sec, r);
    }
    for (const r of by.values()) {
      let bw = 0, bs = 0, sw = 0, ss = 0;
      for (const t of r.buys) { const v = valOf(t); if (v == null) continue; const w = Math.abs(dW(t)); bw += w; bs += w * v; r.buyN++; if (v > 0) r.buyGood++; }
      for (const t of r.sells) { const v = valOf(t); if (v == null) continue; const w = Math.abs(dW(t)); sw += w; ss += w * v; r.sellN++; if (v < 0) r.sellGood++; }
      r.buyPerf = bw > 0 ? bs / bw : null;
      r.sellPerf = sw > 0 ? ss / sw : null;
      tot.buyN += r.buyN; tot.buyGood += r.buyGood; tot.sellN += r.sellN; tot.sellGood += r.sellGood;
      tot.buyW += bw; tot.buyS += bs; tot.sellW += sw; tot.sellS += ss;
      r.buys.sort((a, b) => dW(b) - dW(a)); r.sells.sort((a, b) => dW(a) - dW(b));
    }
    const rows = [...by.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
    return { rows, recent, tot };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res, from, basis]);

  const adds = rows.filter(r => r.net > 0.005).sort((a, b) => b.net - a.net).slice(0, 3);
  const cuts = rows.filter(r => r.net < -0.005).sort((a, b) => a.net - b.net).slice(0, 3);
  const cnt = (k: TradeType) => recent.filter(t => t.type === k).length;
  const buyAvg = tot.buyW > 0 ? tot.buyS / tot.buyW : null;
  const sellAvg = tot.sellW > 0 ? tot.sellS / tot.sellW : null;
  const outOfRange = res.end < (latest ?? '');

  const chip = (t: TradeResult) => {
    const v = valOf(t);
    const good = v == null ? null : t.side === 'buy' ? v > 0 : v < 0;
    return (
      <span key={`${t.id}-${t.date}`} title={`${t.date} ${TYPE_LABEL[t.type]}，權重 ${fmtW(t.weightBefore)} → ${fmtW(t.weightAfter)}`} style={{
        display: 'inline-flex', gap: 4, alignItems: 'baseline', padding: '2px 7px', borderRadius: 6, fontSize: '.74rem', whiteSpace: 'nowrap',
        background: good == null ? '#F5F3F0' : good ? '#FEF2F2' : '#F0FDF4', border: `1px solid ${BORDER}` }}>
        <span style={{ fontFamily: MONO, color: SUB }}>{shortId(t.rawId)}</span>
        <span style={{ color: TYPE_COLOR[t.type], fontWeight: 700 }}>{TYPE_LABEL[t.type]}</span>
        <span style={{ fontFamily: MONO, color: SUB }}>{dW(t) >= 0 ? '+' : ''}{dW(t).toFixed(2)}</span>
        <span style={{ fontFamily: MONO, fontWeight: 700, color: col(v) }}>{t.priced ? fmtPct(v) : '無報價'}</span>
      </span>
    );
  };
  const perfCell = (v: number | null, side: 'buy' | 'sell', nGood: number, nAll: number) => {
    if (v == null) return <span style={{ color: '#AAA' }}>—</span>;
    const good = side === 'buy' ? v > 0 : v < 0;
    const label = side === 'buy' ? (good ? '加對了' : '加錯了') : (good ? '減對了' : '減早了');
    return (
      <span>
        <b style={{ fontFamily: MONO, color: col(v) }}>{fmtPct(v, 2)}</b>{' '}
        <span style={{ fontSize: '.72rem', fontWeight: 700, color: good ? (side === 'buy' ? UP : '#1D4ED8') : (side === 'buy' ? DOWN : '#B45309') }}>{label}</span>
        <div style={{ fontSize: '.68rem', color: SUB, fontFamily: SANS }}>{nGood}/{nAll} 筆{side === 'buy' ? '上漲' : '下跌'}</div>
      </span>
    );
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: '.95rem', fontWeight: 700 }}>近期操作</h3>
        {([5, 10, 20] as const).map(k => <button key={k} style={seg(n === k)} onClick={() => setN(k)}>近 {k} 個交易日</button>)}
        {from && <span style={{ fontSize: '.78rem', color: SUB }}>持股日 {from.slice(5)} ~ {latest?.slice(5)}｜共 {recent.length} 筆（新增 {cnt('new')}、加碼 {cnt('add')}、減碼 {cnt('trim')}、出清 {cnt('exit')}）</span>}
      </div>
      {outOfRange && <p style={{ fontSize: '.8rem', color: UP, margin: '8px 0 0' }}>⚠ 查詢的「迄」日早於最新持股日，近期操作可能不完整；請把「換股日 迄」留空再查詢。</p>}

      {/* 文字總結 */}
      <div style={{ margin: '12px 0', padding: '10px 14px', background: '#FAF8F6', borderRadius: 8, fontSize: '.86rem', lineHeight: 1.9 }}>
        <div><b>主要加碼：</b>{adds.length ? adds.map((r, i) => <span key={r.sector}>{i > 0 && '、'}{r.sector}（<b style={{ fontFamily: MONO, color: UP }}>+{r.net.toFixed(2)}%</b>）</span>) : '無'}</div>
        <div><b>主要減碼：</b>{cuts.length ? cuts.map((r, i) => <span key={r.sector}>{i > 0 && '、'}{r.sector}（<b style={{ fontFamily: MONO, color: DOWN }}>{r.net.toFixed(2)}%</b>）</span>) : '無'}</div>
        <div>
          <b>操作後至今表現{basis === 'rel' ? `（相對 ${res.fund}）` : ''}：</b>
          加碼的股票平均 <b style={{ fontFamily: MONO, color: col(buyAvg) }}>{fmtPct(buyAvg, 2)}</b>（{tot.buyGood}/{tot.buyN} 筆上漲，{buyAvg == null ? '—' : buyAvg > 0 ? '目前看來加對了' : '目前看來加錯了'}）；
          減碼的股票平均 <b style={{ fontFamily: MONO, color: col(sellAvg) }}>{fmtPct(sellAvg, 2)}</b>（{tot.sellGood}/{tot.sellN} 筆下跌，{sellAvg == null ? '—' : sellAvg < 0 ? '目前看來減對了' : '目前看來減早了'}）
        </div>
      </div>

      {/* 產業明細 */}
      <div style={{ overflow: 'auto', maxHeight: 520 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 960 }}>
          <thead><tr>
            <th style={{ ...th, textAlign: 'left', cursor: 'default' }}>產業</th>
            <th style={{ ...th, cursor: 'default' }} title="加碼增加的權重 − 減碼減少的權重（百分點）">淨加減碼</th>
            <th style={{ ...th, textAlign: 'left', cursor: 'default' }}>加碼／新增（權重變化、至今漲跌）</th>
            <th style={{ ...th, cursor: 'default' }}>加碼後表現</th>
            <th style={{ ...th, textAlign: 'left', cursor: 'default' }}>減碼／出清（權重變化、至今漲跌）</th>
            <th style={{ ...th, cursor: 'default' }}>減碼後表現</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} style={{ ...td, textAlign: 'center', color: '#AAA', fontFamily: SANS }}>這段期間沒有換股</td></tr>}
            {rows.map(r => (
              <tr key={r.sector} style={{ borderBottom: '1px solid #F0ECE8', verticalAlign: 'top' }}>
                <td style={{ ...td, textAlign: 'left', fontFamily: SANS, whiteSpace: 'normal', minWidth: 130, fontWeight: 600 }}>{r.sector}</td>
                <td style={{ ...td, fontWeight: 700, color: r.net > 0.005 ? UP : r.net < -0.005 ? DOWN : SUB }}>
                  {r.net >= 0 ? '+' : ''}{r.net.toFixed(2)}%
                  <div style={{ fontSize: '.68rem', fontFamily: SANS }}>{r.net > 0.005 ? '加碼' : r.net < -0.005 ? '減碼' : '持平'}</div>
                </td>
                <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }}><div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{r.buys.length ? r.buys.map(chip) : <span style={{ color: '#AAA' }}>—</span>}</div></td>
                <td style={td}>{perfCell(r.buyPerf, 'buy', r.buyGood, r.buyN)}</td>
                <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }}><div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{r.sells.length ? r.sells.map(chip) : <span style={{ color: '#AAA' }}>—</span>}</div></td>
                <td style={td}>{perfCell(r.sellPerf, 'sell', r.sellGood, r.sellN)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ margin: '8px 0 0', fontSize: '.72rem', color: SUB, lineHeight: 1.6 }}>
        淨加減碼＝該產業所有操作的權重變化加總（百分點）。操作後表現＝從操作日到最新一天的漲跌，依權重變化大小加權平均；加碼後上漲＝加對、減碼後下跌＝減對、減碼後反而上漲＝減早了。
        最新一天才做的操作還沒有之後的股價，顯示「—」。近期操作期間很短，表現僅供參考。產業分類優先用網站內建的海外族群，沒有的用 Yahoo 產業分類。
      </p>
    </div>
  );
}

export default function TradeFollowTab() {
  const [fund, setFund]   = useState('00409A');
  const [start, setStart] = useState(isoDaysAgo(90));
  const [end, setEnd]     = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr]     = useState('');
  const [res, setRes]     = useState<TradeFollowResult | null>(null);

  const [win, setWin]     = useState<Win>('seg');
  const [view, setView]   = useState<'trade' | 'stock'>('stock');
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
    const out: Record<Verdict, { n: number; sum: number; imp: number }> = {
      buyGood: { n: 0, sum: 0, imp: 0 }, buyBad: { n: 0, sum: 0, imp: 0 }, sellMissed: { n: 0, sum: 0, imp: 0 }, sellGood: { n: 0, sum: 0, imp: 0 },
    };
    let buyEval = 0, sellEval = 0;
    for (const t of trades) {
      const v = verdictOf(t, win, basis);
      if (!v) continue;
      out[v].n++; out[v].sum += valOf(t)!; { const x = impactOf(t, win, basis); out[v].imp += x ? (t.side === 'buy' ? x.hold : x.avoid) : 0; }
      if (t.side === 'buy') buyEval++; else sellEval++;
    }
    return { out, buyEval, sellEval };
  }, [trades, win, basis, valOf]);

  const summary = useMemo(() => {
    const m = new Map<string, TradeResult[]>();
    for (const t of trades) { const l = m.get(t.id) ?? []; l.push(t); m.set(t.id, l); }
    const list: StockImpact[] = [];
    for (const l of m.values()) {
      const x = sumImpacts(l, win, basis);
      if (x) list.push({ id: l[0].id, rawId: l[0].rawId, name: l[0].name, ...x, n: l.length });
    }
    const goodAll = list.filter(s => s.total > 0.005), badAll = list.filter(s => s.total < -0.005);
    return {
      good: [...goodAll].sort((a, b) => b.total - a.total).slice(0, 10),
      bad: [...badAll].sort((a, b) => a.total - b.total).slice(0, 10),
      nGood: goodAll.length, nBad: badAll.length,
    };
  }, [trades, win, basis]);

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

  const rowIds = useMemo(() => new Set(rows.map(t => t.id)), [rows]);

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
        ...ALL_WINS.flatMap(w => [`${WIN_LABEL[w]} 個股%`, `${WIN_LABEL[w]} 相對%`]), '算到（下次動作）', '持有貢獻%', '賣出後錯過／避開%', '判斷（依目前選的期間/口徑）'],
      ...rows.map(t => {
        const v = verdictOf(t, win, basis);
        return [t.date, t.days, t.rawId, t.name, TYPE_LABEL[t.type], +t.weightBefore.toFixed(2), +t.weightAfter.toFixed(2),
          ...ALL_WINS.flatMap(w => [
            t.ret[w] == null ? null : +t.ret[w]!.toFixed(2), t.rel[w] == null ? null : +t.rel[w]!.toFixed(2)]),
          segNote(t), ...(() => { const x = impactOf(t, win, basis); return x ? [+x.hold.toFixed(3), t.side === 'sell' ? +x.avoid.toFixed(3) : null] : [null, null]; })(), v ? VERDICT[v].label : ''];
      }),
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '換股追蹤');
    XLSX.writeFile(wb, `換股追蹤_${res.fund}_${res.start}_${res.end}.xlsx`);
  };

  const winCols = ALL_WINS;
  const weightOf = useCallback((id: string) => res?.allocation.find(a => a.id === id)?.weight ?? 0, [res]);

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
        <p style={{ margin: '-6px 0 0', fontSize: '.76rem', color: SUB }}>
          {win === 'seg'
            ? '依時間切段：每次操作只算到同一檔股票的下一次動作（不論買或賣）那天，沒有下一次動作就算到最新一天。例：09/14 新增、09/16 加碼 → 09/14 新增只算 09/14~09/16 這段，各段不重疊。'
            : `不管經理人之後有沒有再動作，一律看換股後${WIN_LABEL[win]}的漲跌（期間還沒走完的顯示「—」）。`}
        </p>

        {/* ── 近期操作 ── */}
        <RecentOps res={res} basis={basis} />

        {/* ── 換股總結 ── */}
        <div style={card}>
          <h3 style={{ margin: 0, fontSize: '.95rem', fontWeight: 700 }}>換股總結　
            <span style={{ fontWeight: 400, fontSize: '.78rem', color: SUB }}>{res.fund} {res.fundName}｜換股日 {res.start} ~ {res.end}｜{WIN_LABEL[win]}</span>
          </h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'baseline', margin: '12px 0 4px' }}>
            <div style={{ fontSize: '.85rem', color: SUB, lineHeight: 1.8 }}>
              做對的個股 <b style={{ color: UP }}>{summary.nGood}</b> 檔<br />
              做錯的個股 <b style={{ color: DOWN }}>{summary.nBad}</b> 檔
            </div>
          </div>
          <p style={{ margin: '0 0 12px', fontSize: '.74rem', color: SUB, lineHeight: 1.6 }}>
            對淨值的影響分兩部分，依{basis === 'abs' ? '個股漲跌' : `相對 ${res.fund} 的漲跌`}計算：
            <b>持有貢獻</b>＝每段期間實際持有的權重 × 那段漲跌（例：持有 3%、那段漲 10% → +0.30%），代表這檔股票實際替淨值賺／賠多少；
            <b>賣出後錯過／避開</b>＝賣掉的權重 × 賣出後漲跌（例：出清 3%、之後漲 10% → −0.30% 錯過；之後跌 10% → +0.30% 避開）。
            兩者合計用來排名做對／做錯。點個股可看完整歷程。
            {win !== 'seg' && <b>　目前選的是固定期間，前後操作的期間會重疊，合計數字僅供參考；看淨值影響建議用「到下次動作」。</b>}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
            <SummaryList title="做對最多的個股" color={UP} list={summary.good}
              onPick={(st) => { setQ(shortId(st.rawId)); setView('stock'); setTypeFilter('all'); setVerdictFilter(null); }} />
            <SummaryList title="做錯最多的個股" color={DOWN} list={summary.bad}
              onPick={(st) => { setQ(shortId(st.rawId)); setView('stock'); setTypeFilter('all'); setVerdictFilter(null); }} />
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
                <div style={{ fontSize: '.75rem', color: SUB }}>平均漲跌 <span style={{ fontFamily: MONO, color: col(s.n ? s.sum / s.n : null) }}>{fmtPct(s.n ? s.sum / s.n : null)}</span></div>
                <div style={{ fontSize: '.75rem', color: SUB }}>{k.startsWith('buy') ? '持有貢獻' : '賣出後錯過／避開'} <span style={{ fontFamily: MONO, fontWeight: 700, color: col(s.imp) }}>{fmtPP(s.imp)}</span></div>
              </button>
            );
          })}
        </div>

        {/* ── 全部換股明細 ── */}
        <div style={card}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: '.95rem', fontWeight: 700, marginRight: 8 }}>全部換股明細</h3>
            <button style={seg(view === 'stock')} onClick={() => setView('stock')}>依股票看</button>
            <button style={seg(view === 'trade')} onClick={() => setView('trade')}>依換股紀錄看</button>
            <span style={{ width: 1, height: 20, background: BORDER, margin: '0 4px' }} />
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
          {view === 'stock' && (
            <div style={{ overflow: 'auto', maxHeight: 620 }}>
              {/* 篩選只決定「哪些股票」出現；出現的股票一律顯示完整歷程，才看得出前後操作 */}
              <StockTimeline trades={trades.filter(t => rowIds.has(t.id))} win={win} basis={basis} weightOf={weightOf} />
            </div>
          )}
          {view === 'trade' && <div style={{ overflow: 'auto', maxHeight: 560 }}>
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
                <th style={{ ...th, cursor: 'default' }}>持有貢獻</th>
                <th style={{ ...th, cursor: 'default' }}>賣出後錯過／避開</th>
                <th style={{ ...th, textAlign: 'center', cursor: 'default' }}>判斷</th>
              </tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={13} style={{ ...td, textAlign: 'center', color: '#AAA', fontFamily: SANS }}>這段期間沒有符合條件的換股</td></tr>}
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
                          {w === 'seg' && t.priced && <div style={{ fontSize: '.66rem', color: SUB, fontWeight: 400, fontFamily: SANS }}>{segNote(t)}</div>}
                        </td>
                      ))}
                      {(() => { const x = impactOf(t, win, basis); return (<>
                        <td style={{ ...td, color: col(x?.hold) }}>{x ? fmtPP(x.hold) : '—'}</td>
                        <td style={{ ...td, color: col(x?.avoid) }}>{x && t.side === 'sell' ? fmtPP(x.avoid) : '—'}</td>
                      </>); })()}
                      <td style={{ ...td, textAlign: 'center', fontFamily: SANS }}>
                        {v ? <span style={{ color: VERDICT[v].color, background: VERDICT[v].bg, borderRadius: 4, padding: '2px 6px', fontSize: '.74rem', fontWeight: 700 }}>{VERDICT[v].label}</span> : <span style={{ color: '#AAA' }}>—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>}
        </div>

        {/* ── 註腳 ── */}
        <div style={{ fontSize: '.74rem', color: SUB, lineHeight: 1.7 }}>
          <p style={{ margin: '0 0 4px', fontWeight: 600 }}>怎麼算的</p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li><b>新增／出清</b>：前一份持股沒有、這一份有＝新增；前一份有、這一份沒有＝出清。</li>
            <li><b>加碼／減碼</b>：ETF 每天有申購買回，所有持股股數會一起等比例變動，那不算經理人換股。所以先扣掉當天全體持股的共同變動，個股股數再多（少）10% 以上才算加碼（減碼）。</li>
            <li>同一檔股票連續幾天同方向調整，合併成一筆，日期記第一天。股票分割造成的股數倍增不算加碼。</li>
            <li><b>到下次動作（預設）</b>：每次操作從操作日算到同一檔股票的下一次動作（不論買或賣）那天；之後沒有動作就算到最新一天。各段時間不重疊。「買對／買錯／賣飛／賣對」預設依這段判斷。</li>
            <li><b>固定期間</b>：以換股日（持股公布日）收盤為基準，計算之後第 5／20／60 個交易日，以及到最新一天的報酬，不管之後有沒有再動作。海外股換算成新台幣、含配息（還原權息），與基金同口徑。還沒走滿的期間顯示「—」。</li>
            <li><b>持有貢獻</b>：每段期間（這次操作到下一次動作）實際持有的權重 × 那段漲跌，加總就是這檔股票在期間內實際替淨值賺／賠多少（百分點）。只算查詢區間內有換股的股票、從第一次換股起算。</li>
            <li><b>賣出後錯過／避開</b>：減碼賣掉的部分、或出清前的全部權重 × 賣出後到下一次動作的漲跌。負值＝賣後上漲、錯過（少賺）；正值＝賣後下跌、避開虧損。這是「如果沒賣」的假設數字，不是淨值實際的損益。</li>
            <li>權重用持股公布資料（操作當天的權重），未計入段內權重隨股價漂移，屬近似值。</li>
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
