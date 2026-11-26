'use client';
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import { OVERSEAS_FUNDS } from '@/lib/overseasFunds';
import type { TradeFollowResult, TradeResult, TradeType } from '@/lib/tradeFollow';

/* 換股追蹤分頁（海外主動式 ETF）——精簡版，只有三塊：
   ① 近期操作：近 5／10／20 個交易日加減碼哪些產業、之後有沒有加對／減對
   ② 做對／做錯最多的個股：依「對淨值」排名
   ③ 每檔股票的換股歷程：可排序
   判斷一律用「這次操作 → 同一檔下一次動作」那段、個股本身漲跌（新台幣、含息）。
   其他期間、相對報酬、逐筆明細都放在匯出的 Excel。算法見 lib/tradeFollow.ts。
   台股配色：紅＝漲／做對，綠＝跌／做錯。 */

const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#E8E3DF';
const CARD   = '#FFFFFF';
const UP     = '#C00000';
const DOWN   = '#1A6B45';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

const TYPE_LABEL: Record<TradeType, string> = { new: '新增', add: '加碼', trim: '減碼', exit: '出清' };
const TYPE_COLOR: Record<TradeType, string> = { new: UP, add: '#E26D5C', trim: '#4F8A6B', exit: DOWN };
const GOOD_BG = '#FDE4E4', BAD_BG = '#DDF5E6', NA_BG = '#F5F3F0';
const GOOD_BD = '#F3B4B4', BAD_BD = '#9FD9B5';

const fmtPct = (v: number | null | undefined, d = 1) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const fmtW = (v: number) => `${v.toFixed(2)}%`;
const col = (v: number | null | undefined) => v == null ? SUB : v > 0 ? UP : v < 0 ? DOWN : SUB;
const shortId = (raw: string) => raw.split(/\s+/)[0];
const toIso = (d: string) => d.replace(/\//g, '-');
/* 公司簡稱：去掉「股份有限公司／控股／公司」「Inc / Corp / Class A」等字尾，過長截斷 */
function shortName(name: string, rawId: string): string {
  let n = (name || '').replace(/\(.*?\)|（.*?）/g, '').trim();
  n = n.replace(/(股份有限公司|有限公司|控股公司|控股|集團|公司)$/g, '').trim();
  n = n.replace(/[\s,.-]*(INC|CORP|CORPORATION|CO|LTD|PLC|HOLDINGS?|GROUP|SA|AG|NV|SE)\b.*$/i, '').trim();
  n = n.replace(/[\s-]*CL(ASS)?[\s-]*[A-C]$/i, '').trim();
  if (!n) return shortId(rawId);
  return n.length > 10 ? n.slice(0, 10) + '…' : n;
}
const dW = (t: TradeResult) => t.weightAfter - t.weightBefore;

function isoDaysAgo(n: number): string {
  return new Date(Date.now() + 8 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);
}

/* 這次操作到下一次動作的漲跌（個股本身、新台幣、含息） */
const segRet = (t: TradeResult) => t.ret.seg ?? null;
/* 做對＝買後漲、賣後跌；做錯＝買後跌、賣後漲；null＝還沒有之後的股價 */
function isGood(t: TradeResult): boolean | null {
  const v = segRet(t);
  if (v == null || v === 0) return null;
  return t.side === 'buy' ? v > 0 : v < 0;
}
/* 對淨值（百分點）＝ 持有貢獻（段內持有權重 × 漲跌）＋ 賣出後錯過／避開（賣掉的權重 × 賣後漲跌 × −1） */
function impactParts(t: TradeResult): { hold: number; avoid: number } | null {
  const v = segRet(t);
  if (v == null) return null;
  const hold = t.weightAfter / 100 * v;
  const avoid = t.side === 'sell' ? -Math.max(0, t.weightBefore - t.weightAfter) / 100 * v : 0;
  return { hold, avoid };
}
const impactOf = (t: TradeResult) => { const p = impactParts(t); return p ? p.hold + p.avoid : null; };

const inputStyle: React.CSSProperties = {
  padding: '8px 11px', border: `1px solid ${BORDER}`, borderRadius: 6,
  fontSize: '.87rem', color: TEXT, background: CARD, fontFamily: MONO, minWidth: 140,
};
const card: React.CSSProperties = {
  background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '16px 18px',
  boxShadow: '0 1px 6px rgba(0,0,0,.05)',
};
const th: React.CSSProperties = {
  padding: '8px 10px', fontWeight: 600, fontSize: '.75rem', background: TEXT, color: '#fff',
  whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1, textAlign: 'right', userSelect: 'none',
};
const td: React.CSSProperties = { padding: '8px 10px', fontFamily: MONO, fontSize: '.82rem', textAlign: 'right', whiteSpace: 'nowrap', verticalAlign: 'top' };
const h3: React.CSSProperties = { margin: 0, fontSize: '1rem', fontWeight: 700, color: TEXT };
const note: React.CSSProperties = { margin: '4px 0 0', fontSize: '.78rem', color: SUB };

function seg(active: boolean): React.CSSProperties {
  return {
    padding: '5px 13px', background: active ? TEXT : CARD, color: active ? '#fff' : SUB,
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

/* 一次操作的小標籤：日期 動作 漲跌（紅底＝做對、綠底＝做錯） */
function TradeChip({ t, value, withName }: { t: TradeResult; value: number | null; withName?: boolean }) {
  const good = value == null ? null : t.side === 'buy' ? value > 0 : value < 0;
  return (
    <span title={`${t.date} ${TYPE_LABEL[t.type]}，權重 ${fmtW(t.weightBefore)} → ${fmtW(t.weightAfter)}`} style={{
      display: 'inline-flex', gap: 5, alignItems: 'baseline', padding: '3px 8px', borderRadius: 6,
      background: good == null ? NA_BG : good ? GOOD_BG : BAD_BG, border: `1px solid ${good == null ? BORDER : good ? GOOD_BD : BAD_BD}`,
      fontSize: '.76rem', whiteSpace: 'nowrap', fontFamily: SANS }}>
      {withName
        ? <span><b style={{ color: TEXT, fontWeight: 600 }}>{shortName(t.name, t.rawId)}</b> <span style={{ fontFamily: MONO, color: '#A8A29E', fontSize: '.68rem' }}>{shortId(t.rawId)}</span></span>
        : <span style={{ fontFamily: MONO, color: SUB }}>{t.date.slice(5)}</span>}
      <span style={{ color: TYPE_COLOR[t.type], fontWeight: 700 }}>{TYPE_LABEL[t.type]}</span>
      <b style={{ fontFamily: MONO, color: col(value) }}>{t.priced ? fmtPct(value) : '無報價'}</b>
    </span>
  );
}

function Legend() {
  return (
    <span style={{ fontSize: '.74rem', color: SUB, display: 'inline-flex', gap: 10, alignItems: 'center' }}>
      <span><span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3, verticalAlign: -1, background: GOOD_BG, border: `1px solid ${GOOD_BD}`, marginRight: 4 }} />做對（買後漲、賣後跌）</span>
      <span><span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3, verticalAlign: -1, background: BAD_BG, border: `1px solid ${BAD_BD}`, marginRight: 4 }} />做錯（買後跌、賣後漲）</span>
    </span>
  );
}

/* ── ① 近期操作 ───────────────────────────────────────────────── */
interface StockLine { id: string; rawId: string; name: string; before: number; after: number; trades: TradeResult[] }
interface SectorRow {
  sector: string; before: number; after: number; lines: StockLine[];
  buyPerf: number | null; sellPerf: number | null;
}

function weightedPerf(list: TradeResult[]): number | null {
  let w = 0, s = 0;
  for (const t of list) { const v = t.ret.now; if (v == null) continue; const k = Math.abs(dW(t)); w += k; s += k * v; }
  return w > 0 ? s / w : null;
}
function perfText(v: number | null, side: 'buy' | 'sell') {
  if (v == null) return <span style={{ color: '#AAA' }}>—</span>;
  const good = side === 'buy' ? v > 0 : v < 0;
  const label = side === 'buy' ? (good ? '加對了' : '加錯了') : (good ? '減對了' : '減早了');
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {side === 'buy' ? '加碼後' : '減碼後'} <b style={{ fontFamily: MONO, color: col(v) }}>{fmtPct(v, 2)}</b>{' '}
      <b style={{ color: good ? UP : DOWN }}>{label}</b>
    </span>
  );
}
/* 「1.20% → 0.85%」＋「淨減碼 −0.35」 */
function WeightMove({ before, after, big }: { before: number; after: number; big?: boolean }) {
  const d = after - before;
  const dir = d > 0.005 ? '淨加碼' : d < -0.005 ? '淨減碼' : '持平';
  return (
    <span style={{ whiteSpace: 'nowrap', fontFamily: MONO, fontSize: big ? '.86rem' : '.78rem' }}>
      <span style={{ color: SUB }}>{fmtW(before)}</span>
      <span style={{ color: '#A8A29E' }}> → </span>
      <b style={{ color: TEXT }}>{fmtW(after)}</b>
      <span style={{ marginLeft: 6, fontFamily: SANS, fontSize: '.72rem', fontWeight: 700, color: col(d) }}>
        {dir}{dir !== '持平' && <span style={{ fontFamily: MONO }}> {d > 0 ? '+' : ''}{d.toFixed(2)}</span>}
      </span>
    </span>
  );
}

function RecentOps({ res }: { res: TradeFollowResult }) {
  const [n, setN] = useState<5 | 10 | 20>(5);
  const dates = res.recentDates ?? [];
  const from = dates[Math.min(n, dates.length) - 1];            // 期間內第一天
  const baseDate = dates[Math.min(n, dates.length - 1)];         // 操作前基準（期間前一天）
  const latest = dates[0];

  const { rows, recent } = useMemo(() => {
    const recent = from ? res.trades.filter(t => toIso(t.date) >= from) : [];
    const wB = res.recentWeights?.[baseDate] ?? {};
    const wL = res.recentWeights?.[latest] ?? {};
    const secOf = (id: string) => res.sectors?.[id] ?? '其他／未分類';
    const by = new Map<string, SectorRow>();
    const lineOf = new Map<string, StockLine>();
    for (const t of [...recent].sort((a, b) => a.date.localeCompare(b.date))) {
      const sec = secOf(t.id);
      if (!by.has(sec)) by.set(sec, { sector: sec, before: 0, after: 0, lines: [], buyPerf: null, sellPerf: null });
      let ln = lineOf.get(t.id);
      if (!ln) {
        ln = { id: t.id, rawId: t.rawId, name: t.name, before: wB[t.id] ?? 0, after: wL[t.id] ?? 0, trades: [] };
        lineOf.set(t.id, ln); by.get(sec)!.lines.push(ln);
      }
      ln.trades.push(t);
    }
    // 產業權重＝該產業所有持股（含這段期間沒換股的）權重加總
    for (const [id, w] of Object.entries(wB)) { const r = by.get(secOf(id)); if (r) r.before += w; }
    for (const [id, w] of Object.entries(wL)) { const r = by.get(secOf(id)); if (r) r.after += w; }
    for (const r of by.values()) {
      const ts = r.lines.flatMap(l => l.trades);
      r.buyPerf = weightedPerf(ts.filter(t => t.side === 'buy'));
      r.sellPerf = weightedPerf(ts.filter(t => t.side === 'sell'));
      r.lines.sort((x, y) => (y.after - y.before) - (x.after - x.before));
    }
    const rows = [...by.values()].sort((x, y) => Math.abs(y.after - y.before) - Math.abs(x.after - x.before));
    return { rows, recent };
  }, [res, from, baseDate, latest]);

  const chg = (r: SectorRow) => r.after - r.before;
  const adds = rows.filter(r => chg(r) > 0.005).sort((a, b) => chg(b) - chg(a)).slice(0, 3);
  const cuts = rows.filter(r => chg(r) < -0.005).sort((a, b) => chg(a) - chg(b)).slice(0, 3);
  const buyAll = weightedPerf(recent.filter(t => t.side === 'buy'));
  const sellAll = weightedPerf(recent.filter(t => t.side === 'sell'));
  const md = (d?: string) => d ? d.slice(5).replace('-', '/') : '';
  const sectorList = (list: SectorRow[]) => list.length
    ? list.map((r, i) => <span key={r.sector}>{i > 0 && '、'}{r.sector}（{fmtW(r.before)} → {fmtW(r.after)}）</span>)
    : '無';

  return (
    <div style={card}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <h3 style={{ ...h3, marginRight: 6 }}>① 近期操作</h3>
        {([5, 10, 20] as const).map(k => <button key={k} style={seg(n === k)} onClick={() => setN(k)}>近 {k} 日</button>)}
        <Legend />
      </div>
      {from && (
        <p style={{ ...note, fontSize: '.84rem', color: TEXT }}>
          比較 <b>{md(baseDate)}（操作前）</b> → <b>{md(latest)}（最新）</b> 的持股權重，期間內共 {recent.length} 筆操作。
        </p>
      )}
      {res.end < (latest ?? '') && <p style={{ ...note, color: UP }}>⚠ 「換股日 迄」早於最新持股日，近期操作可能不完整，請把它留空再查詢。</p>}

      <div style={{ margin: '12px 0', padding: '12px 16px', background: '#FAF8F6', borderRadius: 8, fontSize: '.9rem', lineHeight: 2 }}>
        <div><b style={{ color: UP }}>主要加碼：</b>{sectorList(adds)}</div>
        <div><b style={{ color: DOWN }}>主要減碼：</b>{sectorList(cuts)}</div>
        <div>{perfText(buyAll, 'buy')}　　{perfText(sellAll, 'sell')}<span style={{ fontSize: '.74rem', color: SUB }}>（「之後」＝操作日到最新一天的漲跌）</span></div>
      </div>

      <div style={{ overflow: 'auto', maxHeight: 560 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
          <thead><tr>
            <th style={{ ...th, textAlign: 'left' }}>產業</th>
            <th style={{ ...th, textAlign: 'left' }}>產業權重 {md(baseDate)} → {md(latest)}</th>
            <th style={{ ...th, textAlign: 'left' }}>個股權重 {md(baseDate)} → {md(latest)}｜期間內每次操作（之後漲跌）</th>
            <th style={th}>之後表現</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={4} style={{ ...td, textAlign: 'center', color: '#AAA', fontFamily: SANS }}>這段期間沒有換股</td></tr>}
            {rows.map(r => (
              <tr key={r.sector} style={{ borderBottom: '1px solid #E8E3DF' }}>
                <td style={{ ...td, textAlign: 'left', fontFamily: SANS, whiteSpace: 'normal', minWidth: 120, maxWidth: 170, fontWeight: 600 }}>{r.sector}</td>
                <td style={{ ...td, textAlign: 'left' }}><WeightMove before={r.before} after={r.after} big /></td>
                <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal', padding: '4px 10px' }}>
                  {r.lines.map(l => (
                    <div key={l.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '4px 0', borderBottom: '1px dashed #F0ECE8' }}>
                      <span style={{ minWidth: 150, fontFamily: SANS }}>
                        <b style={{ fontWeight: 600 }}>{shortName(l.name, l.rawId)}</b>{' '}
                        <span style={{ fontFamily: MONO, color: '#A8A29E', fontSize: '.68rem' }}>{shortId(l.rawId)}</span>
                      </span>
                      <span style={{ minWidth: 220 }}><WeightMove before={l.before} after={l.after} /></span>
                      <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                        {l.trades.map((t, i) => (
                          <span key={t.date} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            {i > 0 && <span style={{ color: '#C8C2BC' }}>→</span>}
                            <TradeChip t={t} value={t.ret.now} />
                          </span>
                        ))}
                      </span>
                    </div>
                  ))}
                </td>
                <td style={{ ...td, fontFamily: SANS, lineHeight: 1.7 }}>
                  {r.buyPerf != null && <div>{perfText(r.buyPerf, 'buy')}</div>}
                  {r.sellPerf != null && <div>{perfText(r.sellPerf, 'sell')}</div>}
                  {r.buyPerf == null && r.sellPerf == null && <span style={{ color: '#AAA' }}>—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── ②③ 用的個股彙總 ─────────────────────────────────────────── */
interface StockRow {
  id: string; rawId: string; name: string; trades: TradeResult[];
  weight: number; cost: number | null; costHeld: boolean; impact: number | null; last: string;
}
type SortKey = 'name' | 'weight' | 'cost' | 'impact' | 'last';

export default function TradeFollowTab() {
  const [fund, setFund]   = useState('00409A');
  const [start, setStart] = useState(isoDaysAgo(90));
  const [end, setEnd]     = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr]     = useState('');
  const [res, setRes]     = useState<TradeFollowResult | null>(null);
  const [q, setQ]         = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('impact');
  const [asc, setAsc]     = useState(false);
  const autoRan = useRef(false);
  const tableRef = useRef<HTMLDivElement>(null);

  const run = useCallback(async () => {
    setLoading(true); setErr(''); setRes(null); setQ('');
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

  const stocks = useMemo<StockRow[]>(() => {
    if (!res) return [];
    const m = new Map<string, TradeResult[]>();
    for (const t of res.trades) { const l = m.get(t.id) ?? []; l.push(t); m.set(t.id, l); }
    return [...m.values()].map(l => {
      const list = [...l].sort((a, b) => a.date.localeCompare(b.date));
      const imps = list.map(impactOf).filter((x): x is number => x != null);
      const c = res.costReturn?.[list[0].id];
      return {
        id: list[0].id, rawId: list[0].rawId, name: list[0].name, trades: list,
        weight: res.allocation.find(a => a.id === list[0].id)?.weight ?? 0,
        cost: c?.ret ?? null, costHeld: c?.held ?? false,
        impact: imps.length ? imps.reduce((a, b) => a + b, 0) : null,
        last: list[list.length - 1].date,
      };
    });
  }, [res]);

  const good = useMemo(() => stocks.filter(s => (s.impact ?? 0) > 0.005).sort((a, b) => b.impact! - a.impact!).slice(0, 10), [stocks]);
  const bad  = useMemo(() => stocks.filter(s => (s.impact ?? 0) < -0.005).sort((a, b) => a.impact! - b.impact!).slice(0, 10), [stocks]);

  const rows = useMemo(() => {
    const kw = q.trim().toUpperCase();
    const list = kw ? stocks.filter(s => s.rawId.toUpperCase().includes(kw) || s.name.toUpperCase().includes(kw)) : stocks;
    return [...list].sort((a, b) => {
      const x = sortKey === 'name' ? a.rawId : a[sortKey];
      const y = sortKey === 'name' ? b.rawId : b[sortKey];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return asc ? c : -c;
    });
  }, [stocks, q, sortKey, asc]);

  const click = (k: SortKey) => {
    if (sortKey === k) setAsc(!asc);
    else { setSortKey(k); setAsc(k === 'name'); }
  };
  const arrow = (k: SortKey) => sortKey === k ? (asc ? ' ▲' : ' ▼') : '';
  const pick = (s: StockRow) => { setQ(shortId(s.rawId)); tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  /* Excel：畫面拿掉的細節（各期間、相對報酬、持有貢獻／賣出後錯過或避開）都放這裡 */
  const exportXlsx = () => {
    if (!res) return;
    const wins = [['seg', '到下次動作'], ['d5', '之後5日'], ['d20', '之後20日'], ['d60', '之後60日'], ['now', '至今']] as const;
    const detail: (string | number | null)[][] = [
      [`${res.fund} ${res.fundName} 換股追蹤`, `換股日 ${res.start} ~ ${res.end}`, '報酬為新台幣、含息'],
      [],
      ['換股日', '代號', '名稱', '產業', '動作', '調整前權重%', '調整後權重%',
        ...wins.flatMap(([, l]) => [`${l} 個股%`, `${l} 相對基金%`]),
        '算到（下次動作）', '持有貢獻%', '賣出後錯過／避開%', '淨值貢獻%', '判斷'],
      ...[...res.trades].sort((a, b) => a.date.localeCompare(b.date)).map(t => {
        const p = impactParts(t);
        const g = isGood(t);
        const r2 = (v: number | null | undefined) => v == null ? null : +v.toFixed(2);
        return [t.date, t.rawId, t.name, res.sectors?.[t.id] ?? '', TYPE_LABEL[t.type], r2(t.weightBefore), r2(t.weightAfter),
          ...wins.flatMap(([k]) => [r2(t.ret[k]), r2(t.rel[k])]),
          t.segEnd ? `${t.segEnd}${t.segEndBy ? ` ${TYPE_LABEL[t.segEndBy]}` : ''}` : '',
          p ? +p.hold.toFixed(3) : null, p && t.side === 'sell' ? +p.avoid.toFixed(3) : null,
          p ? +(p.hold + p.avoid).toFixed(3) : null,
          g == null ? '' : g ? '做對' : '做錯'];
      }),
    ];
    const byStock: (string | number | null)[][] = [
      ['代號', '名稱', '目前權重%', '持有報酬率%（同選股對帳單）', '淨值貢獻%', '操作次數', '最近動作'],
      ...stocks.map(s => [s.rawId, s.name, +s.weight.toFixed(2), s.cost == null ? null : +s.cost.toFixed(2),
        s.impact == null ? null : +s.impact.toFixed(3), s.trades.length, s.last]),
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(byStock), '依股票');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detail), '逐筆明細');
    XLSX.writeFile(wb, `換股追蹤_${res.fund}_${res.start}_${res.end}.xlsx`);
  };

  const rankList = (title: string, color: string, list: StockRow[]) => (
    <div style={{ flex: '1 1 320px' }}>
      <h4 style={{ margin: '0 0 6px', fontSize: '.9rem', color }}>{title}</h4>
      {list.length === 0 && <p style={{ color: '#AAA', fontSize: '.85rem', margin: '6px 0' }}>無</p>}
      {list.map((s, i) => (
        <div key={s.id} onClick={() => pick(s)} title="點一下看這檔的換股歷程" style={{
          display: 'grid', gridTemplateColumns: '20px minmax(0,1fr) auto', gap: 8, alignItems: 'center',
          padding: '8px 0', borderBottom: '1px solid #F0ECE8', fontSize: '.86rem', cursor: 'pointer' }}>
          <span style={{ color: '#A8A29E', fontFamily: MONO, fontSize: '.74rem' }}>{i + 1}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ fontFamily: MONO, color: SUB, marginRight: 6 }}>{shortId(s.rawId)}</span>{s.name}
          </span>
          <span style={{ fontSize: '.76rem', color: SUB }}>淨值貢獻 <b style={{ fontFamily: MONO, fontSize: '.92rem', color: col(s.impact) }}>{fmtPct(s.impact, 2)}</b></span>
        </div>
      ))}
    </div>
  );

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
        {res && <button onClick={exportXlsx} style={{ ...seg(false), borderRadius: 6, padding: '8px 14px' }}>匯出 Excel（含完整明細）</button>}
      </div>
      {loading && <p style={{ color: SUB, fontSize: '.85rem', margin: 0 }}>第一次查詢要逐檔抓海外股價與匯率，約需 30–90 秒…</p>}
      {err && <p style={{ color: UP, fontSize: '.88rem', margin: 0 }}>⚠ {err}</p>}

      {res && (<>
        {res.warning && <p style={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 6, padding: '8px 12px', fontSize: '.8rem', margin: 0 }}>{res.warning}</p>}

        <RecentOps res={res} />

        {/* ── ② 做對／做錯最多的個股 ── */}
        <div style={card}>
          <h3 style={h3}>② 做對／做錯最多的個股</h3>
          <p style={note}>換股日 {res.start} ~ {res.end}，共 {stocks.length} 檔有換股。依「淨值貢獻」排名：經理人在這檔股票的買賣，讓基金淨值多賺（正）或少賺（負）幾個百分點。點股票可看它的換股歷程。</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 28, marginTop: 10 }}>
            {rankList('做對最多', UP, good)}
            {rankList('做錯最多', DOWN, bad)}
          </div>
        </div>

        {/* ── ③ 每檔股票的換股歷程 ── */}
        <div style={card} ref={tableRef}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <h3 style={{ ...h3, marginRight: 6 }}>③ 每檔股票的換股歷程</h3>
            <input placeholder="搜尋代號或名稱" value={q} onChange={e => setQ(e.target.value)}
              style={{ ...inputStyle, fontFamily: SANS, minWidth: 170, padding: '6px 10px' }} />
            {q && <button style={seg(true)} onClick={() => setQ('')}>清除搜尋 ✕</button>}
            <Legend />
          </div>
          <p style={note}>歷程中每一格的漲跌＝這次操作到同一檔股票下一次動作之間的漲跌（沒有下一次就算到今天）。點欄位標題可以排序。</p>
          <div style={{ overflow: 'auto', maxHeight: 640, marginTop: 10 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
              <thead><tr>
                <th style={{ ...th, textAlign: 'left', cursor: 'pointer' }} onClick={() => click('name')}>股票{arrow('name')}</th>
                <th style={{ ...th, cursor: 'pointer' }} onClick={() => click('weight')}>目前權重{arrow('weight')}</th>
                <th style={{ ...th, cursor: 'pointer' }} onClick={() => click('cost')} title="與「選股對帳單」相同">持有報酬率{arrow('cost')}<div style={{ fontSize: '.64rem', fontWeight: 400, opacity: .8 }}>這檔股票賺幾 %</div></th>
                <th style={{ ...th, cursor: 'pointer' }} onClick={() => click('impact')}>淨值貢獻{arrow('impact')}<div style={{ fontSize: '.64rem', fontWeight: 400, opacity: .8 }}>幫基金賺幾個百分點</div></th>
                <th style={{ ...th, textAlign: 'left' }}>換股歷程</th>
              </tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: '#AAA', fontFamily: SANS }}>沒有符合的股票</td></tr>}
                {rows.map(s => (
                  <tr key={s.id} style={{ borderBottom: '1px solid #F0ECE8' }}>
                    <td style={{ ...td, textAlign: 'left', fontFamily: SANS, whiteSpace: 'normal', minWidth: 140, maxWidth: 200 }}>
                      <span style={{ fontFamily: MONO, color: SUB, marginRight: 6 }}>{shortId(s.rawId)}</span>{s.name}
                    </td>
                    <td style={{ ...td, color: s.weight > 0 ? TEXT : '#A8A29E' }}>{s.weight > 0 ? fmtW(s.weight) : '未持有'}</td>
                    <td style={{ ...td, color: col(s.cost) }}>{fmtPct(s.cost)}</td>
                    <td style={{ ...td, fontWeight: 700, color: col(s.impact) }}>{fmtPct(s.impact, 2)}</td>
                    <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
                        {s.trades.map((t, i) => (
                          <span key={t.date} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                            {i > 0 && <span style={{ color: '#C8C2BC' }}>→</span>}
                            <TradeChip t={t} value={segRet(t)} />
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── 怎麼算的（收合） ── */}
        <details style={{ fontSize: '.8rem', color: SUB, lineHeight: 1.8 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, color: TEXT }}>怎麼算的？</summary>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            <li><b>新增／出清</b>：前一天持股沒有、今天有＝新增；前一天有、今天沒有＝出清。</li>
            <li><b>加碼／減碼</b>：ETF 每天有申購買回，所有股票股數會一起增減，那不算換股。扣掉這部分後，股數再多（少）10% 以上才算加碼（減碼）。連續幾天同方向調整合併成一筆。</li>
            <li><b>歷程每一格的漲跌</b>：從這次操作當天收盤，算到同一檔股票下一次動作那天收盤；沒有下一次動作就算到最新一天。新台幣計價、含配息。</li>
            <li><b>近期操作的權重</b>：用「操作前一天」和「最新一天」兩份持股的實際權重相比。產業權重＝該產業所有持股（包含這段期間沒動的）權重加總。權重變化也會受股價漲跌影響，所以和操作的方向可能有些微差異。</li>
            <li><b>近期操作的「之後」</b>：從操作日算到最新一天。最新一天才做的操作還沒有之後的股價，顯示「—」。產業分類先用網站內建的海外族群，沒有的用 Yahoo 產業分類。</li>
            <li><b>淨值貢獻</b>：每段期間實際持有的權重 × 那段漲跌，再加上「賣掉的權重 × 賣出後漲跌」（賣後漲＝少賺、記負；賣後跌＝避開虧損、記正）。同一檔的各段加總。權重用持股公布資料，屬近似值。</li>
            <li><b>持有報酬率</b>：與「選股對帳單」的報酬相同——從第一次買進起，用平均成本計算（像證券帳戶的報酬率），當地幣別、不含配息。兩者差別：報酬率看「這檔股票本身賺幾 %」，淨值貢獻看「它幫整個基金賺幾個百分點」，會再乘上它在基金裡的權重。例如報酬率 +20%、但只占基金 1%，淨值貢獻大約只有 +0.2%。</li>
            <li>Excel 另外附上各操作之後 5／20／60 日、至今，以及相對基金本身的漲跌。</li>
            {res.skippedDates.length > 0 && <li>略過的持股日（疑似資料不完整）：{res.skippedDates.join('、')}</li>}
            {res.unpriced.length > 0 && <li>抓不到報價、無法評估：{res.unpriced.join('、')}</li>}
          </ul>
        </details>
      </>)}
    </div>
  );
}
