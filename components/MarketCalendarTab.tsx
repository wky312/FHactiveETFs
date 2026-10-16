'use client';
import { useEffect, useMemo, useState } from 'react';
import type { CalendarPayload, Category, MarketEvent, Metric, ReactionStats } from '@/lib/marketCalendar/types';
import { CATEGORY_META, METRIC_LABEL_ZH } from '@/lib/marketCalendar/config';
import { solarTermOn, solarTermsBetween, type SolarTerm } from '@/lib/solarTerms';

/* ── 復華設計 token（與 Dashboard 一致）── */
const RED    = '#C00000';   // 台股慣例：漲 / 高於預期 = 紅
const GREEN  = '#1A6B45';   // 跌 / 低於預期 = 綠
const GOLD   = '#B08F6E';
const CARD   = '#FFFFFF';
const HEADER = '#F7F4F0';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#E8E3DF';
const GRID   = '#EFEAE4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

/* 二十四節氣標示色：節（月初）／氣（月中），純顯示用 */
const TERM_JIE = '#2E7F5B';
const TERM_QI  = '#8A6D1F';

const CATS = Object.keys(CATEGORY_META) as Category[];
const TZ = { tpe: { id: 'Asia/Taipei', label: '台灣時間' }, et: { id: 'America/New_York', label: '美東時間' } } as const;
type TzKey = keyof typeof TZ;
const DAY = 86400_000;

/* ── helpers ── */
const ymdIn = (ms: number, tz: string) => new Date(ms).toLocaleDateString('en-CA', { timeZone: tz });
const addDays = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const wd = (ymd: string) => WEEK[new Date(ymd + 'T00:00:00Z').getUTCDay()];
const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;

/* 事件在所選時區的日期與時間（整天事件用它自己的當地日期，不做時區換算） */
function when(e: MarketEvent, tz: string): { date: string; time: string | null } {
  if (e.allDay) return { date: e.date, time: null };
  const ms = Date.parse(e.start);
  const time = new Date(ms).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  return { date: ymdIn(ms, tz), time };
}

const endMs = (e: MarketEvent) => e.allDay ? Date.parse(addDays(e.endDate ?? e.date, 1) + 'T00:00:00+08:00') : Date.parse(e.start);

function countdown(ms: number): string {
  if (ms <= 0) return '進行中';
  const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / 3600_000), m = Math.floor((ms % 3600_000) / 60_000);
  return d > 0 ? `${d} 天 ${h} 小時` : h > 0 ? `${h} 小時 ${m} 分` : `${m} 分鐘`;
}

const num = (s: string | null | undefined) => {
  if (!s) return null;
  const v = parseFloat(s.replace(/[%K,]/g, ''));
  return Number.isFinite(v) ? v : null;
};
const fin = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);
const signPct = (x: number | null | undefined, d = 2) => fin(x) ? `${x > 0 ? '+' : ''}${x.toFixed(d)}%` : '—';
const upDown = (x: number | null | undefined) => fin(x) ? (x > 0 ? RED : x < 0 ? GREEN : TEXT) : SUB;

/* ── 小元件 ── */
function Section({ title, note, right, children }: { title: string; note?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 3px rgba(28,28,30,.05)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 18px', background: HEADER, borderBottom: `1px solid ${BORDER}`, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '.98rem', fontWeight: 700, color: TEXT, fontFamily: SANS }}>{title}</div>
          {note && <div style={{ fontSize: '.76rem', color: SUB, marginTop: 2, fontFamily: SANS }}>{note}</div>}
        </div>
        {right}
      </div>
      <div style={{ padding: 18 }}>{children}</div>
    </div>
  );
}

function CatChip({ c, small }: { c: Category; small?: boolean }) {
  const m = CATEGORY_META[c];
  return (
    <span style={{
      display: 'inline-block', padding: small ? '1px 7px' : '2px 9px', borderRadius: 999, fontSize: small ? '.7rem' : '.74rem',
      color: m.color, background: `${m.color}14`, border: `1px solid ${m.color}40`, fontWeight: 600, whiteSpace: 'nowrap',
    }}>{m.label}</span>
  );
}

const Stars = ({ n }: { n: number }) => (
  <span title={`重要性 ${n}/3`} style={{ color: n === 3 ? RED : GOLD, letterSpacing: 1, fontSize: '.78rem', whiteSpace: 'nowrap' }}>
    {'★'.repeat(n)}<span style={{ color: GRID }}>{'★'.repeat(3 - n)}</span>
  </span>
);

const Tentative = () => (
  <span style={{ fontSize: '.7rem', color: SUB, border: `1px dashed ${SUB}`, borderRadius: 4, padding: '0 5px', whiteSpace: 'nowrap' }}>預估</span>
);

function toggleBtn(active: boolean): React.CSSProperties {
  return {
    padding: '5px 12px', borderRadius: 999, cursor: 'pointer', fontSize: '.8rem', fontFamily: SANS, fontWeight: 600,
    border: `1.4px solid ${active ? RED : BORDER}`, background: active ? RED : '#fff', color: active ? '#fff' : SUB,
  };
}

/* ── 預期 vs 實際 ── */
function Surprise({ m }: { m: Metric }) {
  const a = num(m.actual), f = num(m.forecast);
  if (a == null || f == null) return <span style={{ color: SUB }}>—</span>;
  const d = +(a - f).toFixed(2);
  if (d === 0) return <span style={{ color: TEXT }}>符合預期</span>;
  return <span style={{ color: d > 0 ? RED : GREEN, fontWeight: 600 }}>{d > 0 ? '▲ 高於' : '▼ 低於'}預期 {Math.abs(d)}{m.actual?.includes('%') ? ' 個百分點' : m.actual?.includes('K') ? 'K' : ''}</span>;
}

function MetricsTable({ metrics }: { metrics: Metric[] }) {
  const th: React.CSSProperties = { textAlign: 'right', padding: '6px 10px', color: SUB, fontWeight: 500, borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { textAlign: 'right', padding: '6px 10px', fontFamily: MONO, borderBottom: `1px solid ${GRID}`, whiteSpace: 'nowrap' };
  return (
    <div className="mt" style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: '.82rem', minWidth: 460 }}>
        <thead><tr>
          <th style={{ ...th, textAlign: 'left' }}>項目</th><th style={th}>市場預期</th><th style={th}>前值</th><th style={th}>實際</th><th style={th}>意外幅度</th>
        </tr></thead>
        <tbody>
          {metrics.map(m => (
            <tr key={m.label}>
              <td style={{ ...td, textAlign: 'left', fontFamily: SANS }}>{METRIC_LABEL_ZH[m.label] ?? m.label}</td>
              <td style={td}>{m.forecast ?? '—'}</td>
              <td style={td}>{m.previous ?? '—'}</td>
              <td style={{ ...td, fontWeight: 700 }}>{m.actual ?? '—'}</td>
              <td style={{ ...td, fontFamily: SANS }}><Surprise m={m} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── 歷史反應 ── */
function ReactionTable({ h }: { h: ReactionStats }) {
  const th: React.CSSProperties = { textAlign: 'right', padding: '6px 10px', color: SUB, fontWeight: 500, borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { textAlign: 'right', padding: '6px 10px', fontFamily: MONO, borderBottom: `1px solid ${GRID}`, whiteSpace: 'nowrap' };
  return (
    <div className="mt" style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: '.82rem', minWidth: 620 }}>
        <thead><tr>
          <th style={{ ...th, textAlign: 'left' }}>市場</th>
          <th style={th}>T+1 平均</th><th style={th}>T+1 中位數</th><th style={th}>T+1 上漲機率</th>
          <th style={th}>T+5 平均</th><th style={th}>T+5 上漲機率</th><th style={th}>波動放大</th><th style={th}>樣本</th>
        </tr></thead>
        <tbody>
          {h.markets.map(m => (
            <tr key={m.symbol}>
              <td style={{ ...td, textAlign: 'left', fontFamily: SANS, fontWeight: 600 }}>{m.name}</td>
              <td style={{ ...td, color: upDown(m.t1.mean) }}>{signPct(m.t1.mean)}</td>
              <td style={{ ...td, color: upDown(m.t1.median) }}>{signPct(m.t1.median)}</td>
              <td style={td}>{fin(m.t1.upPct) ? `${m.t1.upPct}%` : '—'}</td>
              <td style={{ ...td, color: upDown(m.t5.mean) }}>{signPct(m.t5.mean)}</td>
              <td style={td}>{fin(m.t5.upPct) ? `${m.t5.upPct}%` : '—'}</td>
              <td style={{ ...td, fontWeight: 700, color: fin(m.volRatio) && m.volRatio >= 1.3 ? RED : TEXT }}>{fin(m.volRatio) ? `${m.volRatio.toFixed(2)}x` : '—'}</td>
              <td style={{ ...td, color: SUB }}>{m.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SamplesTable({ h }: { h: ReactionStats }) {
  const syms = h.markets.map(m => m.symbol);
  const th: React.CSSProperties = { textAlign: 'right', padding: '5px 8px', color: SUB, fontWeight: 500, borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { textAlign: 'right', padding: '5px 8px', fontFamily: MONO, borderBottom: `1px solid ${GRID}`, whiteSpace: 'nowrap' };
  return (
    <div className="mt" style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: '.78rem', minWidth: 560 }}>
        <thead><tr>
          <th style={{ ...th, textAlign: 'left' }}>日期</th><th style={{ ...th, textAlign: 'left' }}>事件</th>
          {h.markets.map(m => <th key={m.symbol} style={th}>{m.name} T+1</th>)}
        </tr></thead>
        <tbody>
          {h.samples.map(s => (
            <tr key={s.id}>
              <td style={{ ...td, textAlign: 'left' }}>{s.date}</td>
              <td style={{ ...td, textAlign: 'left', fontFamily: SANS }}>{s.title}</td>
              {syms.map(sym => <td key={sym} style={{ ...td, color: upDown(s.moves[sym]?.t1) }}>{signPct(s.moves[sym]?.t1)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── 事件列 ── */
function InlineMetric({ m, past }: { m: Metric; past: boolean }) {
  const a = num(m.actual), f = num(m.forecast);
  const d = a != null && f != null ? +(a - f).toFixed(2) : null;
  const col = d == null || d === 0 ? TEXT : d > 0 ? RED : GREEN;
  return (
    <div style={{ fontSize: '.78rem', color: SUB, marginTop: 3, fontFamily: MONO, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
      <span style={{ fontFamily: SANS }}>{METRIC_LABEL_ZH[m.label] ?? m.label}</span>
      {m.forecast && <span>預期 {m.forecast}</span>}
      {m.previous && <span>前值 {m.previous}</span>}
      {m.actual
        ? <b style={{ color: col }}>實際 {m.actual}{d != null && d !== 0 ? (d > 0 ? ' ▲' : ' ▼') : ''}</b>
        : past ? <span>實際 —</span> : null}
    </div>
  );
}

function EventRow({ e, tz, now, open, onToggle, history }: {
  e: MarketEvent; tz: string; now: number; open: boolean; onToggle: () => void; history?: ReactionStats;
}) {
  const w = when(e, tz);
  const past = endMs(e) < now;
  const leads = (e.metrics ?? []).filter(m => m.actual || m.forecast).slice(0, 2);
  const published = !!e.metrics?.some(m => m.actual);
  const days = Math.ceil((Date.parse(e.allDay ? e.date + 'T00:00:00+08:00' : e.start) - now) / DAY);
  return (
    <div style={{ borderBottom: `1px solid ${GRID}` }}>
      <button onClick={onToggle} style={{
        all: 'unset', boxSizing: 'border-box', width: '100%', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 6px', flexWrap: 'wrap', fontFamily: SANS,
      }}>
        <div style={{ width: 86, flexShrink: 0 }}>
          <div style={{ fontFamily: MONO, fontWeight: 700, color: past ? SUB : TEXT, fontSize: '.92rem' }}>
            {md(w.date)}<span style={{ fontFamily: SANS, fontWeight: 500, color: SUB, fontSize: '.78rem' }}> ({wd(w.date)})</span>
          </div>
          <div style={{ fontFamily: MONO, color: SUB, fontSize: '.76rem' }}>
            {w.time ?? (e.endDate ? `至 ${md(e.endDate)}` : '整天')}
          </div>
        </div>
        <div style={{ flex: '1 1 240px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Stars n={e.importance} />
            <span style={{ fontWeight: 700, color: TEXT, fontSize: '.92rem' }}>{e.title}</span>
            {e.tentative && <Tentative />}
          </div>
          {leads.map(m => <InlineMetric key={m.label} m={m} past={past} />)}
        </div>
        <CatChip c={e.category} small />
        <div style={{ width: 64, textAlign: 'right', fontSize: '.78rem', color: days <= 3 && !past ? RED : SUB, fontWeight: days <= 3 && !past ? 700 : 400 }}>
          {past ? (published ? '已公布' : '已過') : days <= 0 ? '今天' : `${days} 天後`}
        </div>
        <span style={{ color: SUB, fontSize: '.8rem', width: 12 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ padding: '4px 6px 16px 104px', display: 'grid', gap: 14 }} className="mc-detail">
          {e.note && <div style={{ fontSize: '.84rem', color: TEXT, lineHeight: 1.6 }}>{e.note}</div>}
          {e.metrics && e.metrics.length > 0 && <MetricsTable metrics={e.metrics} />}
          {history ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ fontSize: '.84rem', fontWeight: 700, color: TEXT }}>
                歷史市場反應：{history.label}<span style={{ fontWeight: 400, color: SUB }}>（{history.n} 次樣本，事件後第 1 / 第 5 個交易日）</span>
              </div>
              <ReactionTable h={history} />
              <details>
                <summary style={{ cursor: 'pointer', fontSize: '.8rem', color: SUB }}>最近 {history.samples.length} 次明細</summary>
                <div style={{ marginTop: 8 }}><SamplesTable h={history} /></div>
              </details>
            </div>
          ) : (
            <div style={{ fontSize: '.8rem', color: SUB }}>此類事件尚無歷史反應樣本。</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── 月曆格 ── */
const addMonths = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (ym: string) => `${ym.slice(0, 4)} 年 ${Number(ym.slice(5))} 月`;

function MonthGrid({ month, events, tz, today, selected, onSelect }: {
  month: string; events: MarketEvent[]; tz: string; today: string; selected: string | null; onSelect: (d: string | null) => void;
}) {
  const [y, m] = month.split('-').map(Number);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const offset = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;  // 週一起算
  const cells = Math.ceil((offset + dim) / 7) * 7;

  const byDay = useMemo(() => {
    const map = new Map<string, MarketEvent[]>();
    for (const e of events) {
      const start = when(e, tz).date;
      const end = e.allDay ? (e.endDate ?? start) : start;
      for (let d = start, i = 0; d <= end && i < 10; d = addDays(d, 1), i++) map.set(d, [...(map.get(d) ?? []), e]);
    }
    for (const list of map.values()) list.sort((a, b) => b.importance - a.importance || a.start.localeCompare(b.start));
    return map;
  }, [events, tz]);

  return (
    <div>
      <style>{`
        .mc-cell { min-height: 92px; }
        @media (max-width: 640px) {
          .mc-cell { min-height: 54px; padding: 3px !important; }
          .mc-chips { flex-direction: row !important; flex-wrap: wrap; gap: 3px !important; }
          .mc-chip { padding: 0 !important; width: 7px; height: 7px; border-radius: 50% !important; border: 0 !important; background: var(--c) !important; }
          .mc-chip-txt, .mc-more { display: none !important; }
          .mc-term { font-size: .6rem !important; padding: 0 2px !important; }
        }
      `}</style>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 1, background: GRID, border: `1px solid ${GRID}`, borderRadius: 8, overflow: 'hidden' }}>
        {['一', '二', '三', '四', '五', '六', '日'].map(w => (
          <div key={w} style={{ background: HEADER, textAlign: 'center', padding: '5px 0', fontSize: '.74rem', color: SUB, fontWeight: 600 }}>{w}</div>
        ))}
        {Array.from({ length: cells }, (_, i) => {
          const dayNum = i - offset + 1;
          if (dayNum < 1 || dayNum > dim) return <div key={i} style={{ background: '#FBF9F7' }} />;
          const ymd = `${month}-${String(dayNum).padStart(2, '0')}`;
          const evs = byDay.get(ymd) ?? [];
          const term = solarTermOn(ymd);
          const isToday = ymd === today, isSel = ymd === selected;
          const weekend = i % 7 >= 5;
          return (
            <div key={i} className="mc-cell" onClick={() => onSelect(isSel ? null : ymd)} style={{
              background: isSel ? '#FFF4F2' : weekend ? '#FCFAF8' : CARD, padding: 5, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 3,
              outline: isSel ? `2px solid ${RED}` : 'none', outlineOffset: -2, minWidth: 0,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                <span style={{
                  fontFamily: MONO, fontSize: '.78rem', fontWeight: isToday ? 700 : 500, color: isToday ? '#fff' : weekend ? SUB : TEXT,
                  background: isToday ? RED : 'transparent', borderRadius: 999, minWidth: 20, height: 20, lineHeight: '20px', textAlign: 'center', flexShrink: 0,
                }}>{dayNum}</span>
                {term && (
                  <span title={`${term.name}（${term.kind === '節' ? '節：月初' : '氣：月中'}）`} className="mc-term" style={{
                    fontSize: '.66rem', lineHeight: 1.3, padding: '0 4px', borderRadius: 3, whiteSpace: 'nowrap', fontFamily: SANS, fontWeight: 600,
                    color: term.kind === '節' ? TERM_JIE : TERM_QI, background: `${term.kind === '節' ? TERM_JIE : TERM_QI}14`,
                  }}>{term.name}</span>
                )}
              </div>
              <div className="mc-chips" style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                {evs.slice(0, 3).map(e => {
                  const c = CATEGORY_META[e.category].color;
                  const done = e.metrics?.some(x => x.actual);
                  return (
                    <div key={e.id} className="mc-chip" title={e.title} style={{
                      ['--c' as string]: c, background: `${c}14`, border: `1px ${e.tentative ? 'dashed' : 'solid'} ${c}55`, borderLeft: `3px solid ${c}`,
                      borderRadius: 3, padding: '1px 4px', fontSize: '.68rem', lineHeight: 1.35, color: TEXT, fontWeight: e.importance === 3 ? 700 : 400,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      <span className="mc-chip-txt">{done ? '✓ ' : ''}{e.title}</span>
                    </div>
                  );
                })}
                {evs.length > 3 && <div className="mc-more" style={{ fontSize: '.66rem', color: SUB }}>+{evs.length - 3} 項</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── 訂閱 ── */
function Subscribe() {
  const [cats, setCats] = useState<Category[]>([]);
  const [min, setMin] = useState(1);
  const [alarm, setAlarm] = useState(0);
  const [copied, setCopied] = useState(false);
  const [host, setHost] = useState('fhactiveetf.vercel.app');
  // eslint-disable-next-line react-hooks/set-state-in-effect -- 只在 client 讀網址主機（預覽網址也能產生正確訂閱連結）
  useEffect(() => { setHost(window.location.host); }, []);

  const qs = new URLSearchParams();
  if (cats.length) qs.set('cat', cats.join(','));
  if (min > 1) qs.set('min', String(min));
  if (alarm) qs.set('alarm', String(alarm));
  const path = `/api/market-calendar/ics${qs.toString() ? `?${qs}` : ''}`;
  const webcal = `webcal://${host}${path}`;
  const https = `https://${host}${path}`;
  const google = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;

  const copy = async () => {
    try { await navigator.clipboard.writeText(https); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* 無剪貼簿權限 */ }
  };
  const btn = (primary: boolean): React.CSSProperties => ({
    display: 'inline-block', padding: '8px 16px', borderRadius: 8, fontSize: '.84rem', fontWeight: 700, fontFamily: SANS,
    textDecoration: 'none', cursor: 'pointer', border: `1.4px solid ${RED}`, background: primary ? RED : '#fff', color: primary ? '#fff' : RED,
  });
  const label: React.CSSProperties = { fontSize: '.78rem', color: SUB, marginRight: 8 };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={label}>類別</span>
          <button style={toggleBtn(cats.length === 0)} onClick={() => setCats([])}>全部</button>
          {CATS.map(c => (
            <button key={c} style={toggleBtn(cats.includes(c))}
              onClick={() => setCats(cs => cs.includes(c) ? cs.filter(x => x !== c) : [...cs, c])}>
              {CATEGORY_META[c].label}
            </button>
          ))}
        </div>
        <label style={{ fontSize: '.8rem', color: SUB }}>
          <span style={label}>重要性</span>
          <select value={min} onChange={e => setMin(Number(e.target.value))} style={{ padding: '4px 8px', border: `1px solid ${BORDER}`, borderRadius: 6 }}>
            <option value={1}>全部</option><option value={2}>★★ 以上</option><option value={3}>只要 ★★★</option>
          </select>
        </label>
        <label style={{ fontSize: '.8rem', color: SUB }}>
          <span style={label}>提醒</span>
          <select value={alarm} onChange={e => setAlarm(Number(e.target.value))} style={{ padding: '4px 8px', border: `1px solid ${BORDER}`, borderRadius: 6 }}>
            <option value={0}>不提醒</option><option value={30}>前 30 分鐘</option><option value={60}>前 1 小時</option><option value={1440}>前 1 天</option>
          </select>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <a href={webcal} style={btn(true)}>iPhone / Mac 訂閱</a>
        <a href={google} target="_blank" rel="noreferrer" style={btn(false)}>加入 Google 日曆（Android）</a>
        <button onClick={copy} style={btn(false)}>{copied ? '已複製 ✓' : '複製訂閱網址'}</button>
      </div>
      <code style={{ fontFamily: MONO, fontSize: '.76rem', color: SUB, background: HEADER, padding: '6px 10px', borderRadius: 6, wordBreak: 'break-all' }}>{https}</code>
      <div style={{ fontSize: '.8rem', color: SUB, lineHeight: 1.8 }}>
        <div><b style={{ color: TEXT }}>iPhone：</b>用手機開本頁點「iPhone / Mac 訂閱」→ 訂閱；或到「設定 → App → 行事曆 → 行事曆帳號 → 加入帳號 → 其他 → 加入已訂閱的行事曆」，貼上網址。</div>
        <div><b style={{ color: TEXT }}>Android：</b>Google 日曆 App 不能直接加網址，請用電腦開「加入 Google 日曆」（或 Google 日曆網頁版「其他日曆 ＋ → 透過網址」貼上網址），手機就會自動同步。</div>
        <div>訂閱後事件日期異動、數據公布後的實際值都會自動更新（iPhone 約數小時、Google 約 8～24 小時同步一次）。</div>
      </div>
    </div>
  );
}

/* ── 主元件 ── */
export default function MarketCalendarTab() {
  const [data, setData] = useState<CalendarPayload | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [cats, setCats] = useState<Category[]>([]);
  const [minImp, setMinImp] = useState(1);
  const [tzKey, setTzKey] = useState<TzKey>('tpe');
  const [month, setMonth] = useState<string | null>(null);          // null＝跟著「今天」所在月份
  const [selDay, setSelDay] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchPast, setSearchPast] = useState(false);

  /* 深連結 ?m=YYYY-MM：進站還原、切月寫回（保留 tab / etf 等其他參數）。
     在 effect 內讀 window 以免 SSR hydration mismatch。 */
  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get('m');
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 一次性還原網址狀態
    if (m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m)) setMonth(m);
  }, []);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (month) sp.set('m', month); else sp.delete('m');
    if (sp.toString() !== window.location.search.replace(/^\?/, '')) {
      window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`);
    }
  }, [month]);

  useEffect(() => {
    let alive = true;
    fetch('/api/market-calendar')
      .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`); return j as CalendarPayload; })
      .then(j => { if (alive) setData(j); })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const tz = TZ[tzKey].id;
  const filtered = useMemo(() => (data?.events ?? []).filter(e =>
    (!cats.length || cats.includes(e.category)) && e.importance >= minImp), [data, cats, minImp]);
  const upcoming = useMemo(() => filtered.filter(e => endMs(e) >= now), [filtered, now]);
  const today = ymdIn(now, 'Asia/Taipei');
  const curMonth = today.slice(0, 7);
  const shown = month ?? curMonth;
  /* 可切換範圍：往前一年（實際值回補的範圍）～ 最遠的已排程事件 */
  const minMonth = addMonths(curMonth, -12);
  const maxMonth = useMemo(() => {
    const last = (data?.events ?? []).reduce((mx, e) => (e.endDate ?? e.date) > mx ? (e.endDate ?? e.date) : mx, today);
    return last.slice(0, 7) > addMonths(curMonth, 12) ? last.slice(0, 7) : addMonths(curMonth, 12);
  }, [data, today, curMonth]);
  const monthOptions = useMemo(() => {
    const out: string[] = [];
    for (let m = minMonth; m <= maxMonth; m = addMonths(m, 1)) out.push(m);
    return out;
  }, [minMonth, maxMonth]);

  /* 該月事件（含跨月的多日事件）；點選日期後只留當天 */
  const monthEvents = useMemo(() => filtered.filter(e => {
    const s = when(e, tz).date, en = e.allDay ? (e.endDate ?? s) : s;
    return s.slice(0, 7) <= shown && en.slice(0, 7) >= shown;
  }), [filtered, tz, shown]);
  const listed = useMemo(() => (selDay
    ? monthEvents.filter(e => { const s = when(e, tz).date, en = e.allDay ? (e.endDate ?? s) : s; return s <= selDay && en >= selDay; })
    : monthEvents).sort((a, b) => a.start.localeCompare(b.start)), [monthEvents, selDay, tz]);
  const goMonth = (m: string) => { setMonth(m === curMonth ? null : m); setSelDay(null); setOpenId(null); };

  const next = upcoming.find(e => e.importance === 3 && Date.parse(e.allDay ? e.date + 'T00:00:00+08:00' : e.start) > now);
  const monday = addDays(today, -((new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7));
  const inWeek = (e: MarketEvent, from: string) => {
    const d = when(e, 'Asia/Taipei').date, end = e.endDate ?? d;
    return end >= from && d <= addDays(from, 6);
  };
  const thisWeek = upcoming.filter(e => inWeek(e, monday));
  const nextWeek = upcoming.filter(e => inWeek(e, addDays(monday, 7)));

  /* 搜尋：標題 / 代碼 / 類型 / 指標名稱（中英文）＋二十四節氣，不受下方類別、重要性篩選影響 */
  type Hit = { id: string; date: string; sort: string; ev?: MarketEvent; term?: SolarTerm };
  const searchHits = useMemo<Hit[] | null>(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return null;
    const hits: Hit[] = (data?.events ?? []).filter(e => {
      if (!searchPast && endMs(e) < now) return false;
      const hay = [e.title, e.type, e.symbol, e.historyKey, e.category, CATEGORY_META[e.category].label,
        ...(e.metrics ?? []).flatMap(m => [m.label, METRIC_LABEL_ZH[m.label]])].filter(Boolean).join(' ').toLowerCase();
      return terms.every(t => hay.includes(t));
    }).map(e => ({ id: e.id, date: when(e, tz).date, sort: e.start, ev: e }));
    const t0 = ymdIn(now, 'Asia/Taipei');
    for (const { date, term } of solarTermsBetween(searchPast ? addDays(t0, -400) : t0, addDays(t0, 400))) {
      const hay = `${term.name} ${term.kind} 節氣 二十四節氣`;
      if (terms.every(t => hay.includes(t))) hits.push({ id: `term-${date}`, date, sort: `${date}T00:00:00`, term });
    }
    return hits.sort((a, c) => searchPast ? c.sort.localeCompare(a.sort) : a.sort.localeCompare(c.sort));
  }, [data, query, searchPast, now, tz]);
  const jumpTo = (e: MarketEvent) => {
    const d = when(e, tz).date;
    setMonth(d.slice(0, 7) === curMonth ? null : d.slice(0, 7)); setSelDay(d); setOpenId(e.id);
    document.getElementById('mc-month')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const historyRank = useMemo(() => Object.values(data?.history ?? {})
    .map(h => ({ h, tw: h.markets.find(m => m.symbol === '^TWII')?.volRatio ?? NaN, us: h.markets.find(m => m.symbol === '^IXIC')?.volRatio ?? NaN }))
    .sort((a, b) => (fin(b.tw) ? b.tw : 0) - (fin(a.tw) ? a.tw : 0)), [data]);

  if (error) return <div style={{ padding: 24, color: RED, fontFamily: SANS }}>載入失敗：{error}</div>;
  if (!data) return <div style={{ padding: 40, textAlign: 'center', color: SUB, fontFamily: SANS }}>載入行事曆中…（首次載入需整理各資料來源，約 20 秒）</div>;

  const weekList = (evs: MarketEvent[]) => evs.length ? evs.map(e => {
    const w = when(e, 'Asia/Taipei');
    return (
      <div key={e.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0', fontSize: '.84rem' }}>
        <span style={{ fontFamily: MONO, color: SUB, width: 124, flexShrink: 0, whiteSpace: 'nowrap' }}>{md(w.date)}({wd(w.date)}) {w.time ?? ''}</span>
        <span style={{ color: e.importance === 3 ? TEXT : SUB, fontWeight: e.importance === 3 ? 700 : 400 }}>{e.title}</span>
        {e.tentative && <Tentative />}
      </div>
    );
  }) : <div style={{ fontSize: '.84rem', color: SUB }}>無</div>;

  const failed = Object.entries(data.sources).filter(([, s]) => !s.ok);

  return (
    <div style={{ display: 'grid', gap: 18, fontFamily: SANS }}>
      <style>{`@media (max-width: 640px) { .mc-detail { padding-left: 6px !important; } }`}</style>

      {/* 倒數＋本週 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
        <div style={{ background: RED, color: '#fff', borderRadius: 12, padding: '18px 20px', display: 'grid', gap: 6 }}>
          <div style={{ fontSize: '.8rem', opacity: 0.85 }}>距離下一個重大事件（★★★）</div>
          {next ? <>
            <div style={{ fontSize: '1.9rem', fontWeight: 800, fontFamily: MONO, lineHeight: 1.1 }}>
              {countdown(Date.parse(next.allDay ? next.date + 'T00:00:00+08:00' : next.start) - now)}
            </div>
            <div style={{ fontSize: '1rem', fontWeight: 700 }}>{next.title}{next.tentative ? '（預估）' : ''}</div>
            <div style={{ fontSize: '.8rem', opacity: 0.85 }}>
              {(() => { const w = when(next, 'Asia/Taipei'); return `${w.date}（${wd(w.date)}）${w.time ? ` ${w.time} 台灣時間` : ''}`; })()}
            </div>
          </> : <div>近期無</div>}
        </div>
        <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: '14px 18px' }}>
          <div style={{ fontSize: '.86rem', fontWeight: 700, color: TEXT, marginBottom: 6 }}>本週重點 <span style={{ fontWeight: 400, color: SUB, fontSize: '.76rem' }}>{md(monday)}–{md(addDays(monday, 6))}</span></div>
          {weekList(thisWeek)}
        </div>
        <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: '14px 18px' }}>
          <div style={{ fontSize: '.86rem', fontWeight: 700, color: TEXT, marginBottom: 6 }}>下週重點 <span style={{ fontWeight: 400, color: SUB, fontSize: '.76rem' }}>{md(addDays(monday, 7))}–{md(addDays(monday, 13))}</span></div>
          {weekList(nextWeek)}
        </div>
      </div>

      {/* 搜尋 */}
      <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: '12px 16px', display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜尋事件或節氣，例如 intel、ppi、台積電、fomc、霜降、立冬…"
            style={{ flex: '1 1 260px', padding: '8px 12px', border: `1.4px solid ${BORDER}`, borderRadius: 8, fontSize: '.9rem', fontFamily: SANS, outline: 'none' }} />
          <label style={{ fontSize: '.8rem', color: SUB, display: 'inline-flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={searchPast} onChange={e => setSearchPast(e.target.checked)} />含已過事件
          </label>
          {query && <button style={toggleBtn(false)} onClick={() => setQuery('')}>清除</button>}
        </div>
        {searchHits && (searchHits.length === 0
          ? <div style={{ fontSize: '.84rem', color: SUB }}>找不到符合「{query.trim()}」的{searchPast ? '' : '後續'}事件。</div>
          : <div style={{ maxHeight: 320, overflowY: 'auto' }}>
              {searchHits.slice(0, 60).map(h => {
                if (h.term) {
                  const past = h.date < today, days = Math.ceil((Date.parse(h.date + 'T00:00:00+08:00') - now) / DAY);
                  const col = h.term.kind === '節' ? TERM_JIE : TERM_QI;
                  return (
                    <button key={h.id} onClick={() => { setMonth(h.date.slice(0, 7) === curMonth ? null : h.date.slice(0, 7)); setSelDay(h.date); setOpenId(null); document.getElementById('mc-month')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} style={{
                      all: 'unset', boxSizing: 'border-box', width: '100%', cursor: 'pointer', display: 'flex', gap: 12, alignItems: 'center',
                      padding: '7px 4px', borderBottom: `1px solid ${GRID}`, fontFamily: SANS, flexWrap: 'wrap',
                    }}>
                      <span style={{ fontFamily: MONO, fontWeight: 700, width: 150, flexShrink: 0, color: past ? SUB : TEXT, fontSize: '.86rem' }}>{h.date}（{wd(h.date)}）</span>
                      <span style={{ fontSize: '.7rem', fontWeight: 600, color: col, background: `${col}14`, borderRadius: 3, padding: '0 5px' }}>{h.term.kind === '節' ? '節氣・節' : '節氣・氣'}</span>
                      <span style={{ fontWeight: 700, fontSize: '.88rem', color: past ? SUB : TEXT }}>{h.term.name}</span>
                      <span style={{ marginLeft: 'auto', fontSize: '.78rem', color: SUB }}>{past ? '已過' : days <= 0 ? '今天' : `${days} 天後`}</span>
                    </button>
                  );
                }
                const e = h.ev!;
                const w = when(e, tz), past = endMs(e) < now;
                const days = Math.ceil((Date.parse(e.allDay ? e.date + 'T00:00:00+08:00' : e.start) - now) / DAY);
                return (
                  <button key={h.id} onClick={() => jumpTo(e)} style={{
                    all: 'unset', boxSizing: 'border-box', width: '100%', cursor: 'pointer', display: 'flex', gap: 12, alignItems: 'center',
                    padding: '7px 4px', borderBottom: `1px solid ${GRID}`, fontFamily: SANS, flexWrap: 'wrap',
                  }}>
                    <span style={{ fontFamily: MONO, fontWeight: 700, width: 150, flexShrink: 0, color: past ? SUB : TEXT, fontSize: '.86rem' }}>
                      {w.date}（{wd(w.date)}）{w.time ? <span style={{ fontWeight: 500, color: SUB }}> {w.time}</span> : null}
                    </span>
                    <Stars n={e.importance} />
                    <span style={{ fontWeight: 700, fontSize: '.88rem', color: past ? SUB : TEXT }}>{e.title}</span>
                    {e.tentative && <Tentative />}
                    <span style={{ marginLeft: 'auto', fontSize: '.78rem', color: days <= 3 && !past ? RED : SUB, fontWeight: days <= 3 && !past ? 700 : 400 }}>
                      {past ? '已過' : days <= 0 ? '今天' : `${days} 天後`}
                    </span>
                  </button>
                );
              })}
              {searchHits.length > 60 && <div style={{ fontSize: '.76rem', color: SUB, padding: '6px 4px' }}>僅顯示前 60 筆，請再輸入更精確的關鍵字。</div>}
            </div>)}
      </div>

      {/* 篩選 */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: '12px 16px' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button style={toggleBtn(cats.length === 0)} onClick={() => setCats([])}>全部</button>
          {CATS.map(c => (
            <button key={c} style={toggleBtn(cats.includes(c))}
              onClick={() => setCats(cs => cs.includes(c) ? cs.filter(x => x !== c) : [...cs, c])}>{CATEGORY_META[c].label}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[1, 2, 3].map(n => <button key={n} style={toggleBtn(minImp === n)} onClick={() => setMinImp(n)}>{n === 1 ? '所有重要性' : `${'★'.repeat(n)} 以上`}</button>)}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(Object.keys(TZ) as TzKey[]).map(k => <button key={k} style={toggleBtn(tzKey === k)} onClick={() => setTzKey(k)}>{TZ[k].label}</button>)}
        </div>
      </div>

      <div id="mc-month" style={{ height: 0, marginTop: -18, scrollMarginTop: 30 }} /><Section title={monthLabel(shown)}
        note={shown < curMonth
          ? '歷史月份：已公布的事件顯示預期／前值／實際（✓ 表示已有實際值）。可往前回看一年。'
          : '✓ 表示已公布實際值；虛線框＝日期尚未官方確認。美國 CPI／PPI／非農／PCE 只排到官方已公布的日程，新年度日程公布後自動補上。'}
        right={
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <button style={{ ...toggleBtn(false), opacity: shown <= minMonth ? 0.4 : 1 }} disabled={shown <= minMonth} onClick={() => goMonth(addMonths(shown, -1))} aria-label="上個月">◀</button>
            <select value={shown} onChange={e => goMonth(e.target.value)} aria-label="跳到月份"
              style={{ padding: '5px 8px', border: `1px solid ${BORDER}`, borderRadius: 999, fontFamily: SANS, fontSize: '.8rem', background: '#fff' }}>
              {monthOptions.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
            <button style={{ ...toggleBtn(false), opacity: shown >= maxMonth ? 0.4 : 1 }} disabled={shown >= maxMonth} onClick={() => goMonth(addMonths(shown, 1))} aria-label="下個月">▶</button>
            <button style={toggleBtn(shown === curMonth)} onClick={() => goMonth(curMonth)}>今天</button>
          </div>
        }>
        <MonthGrid month={shown} events={monthEvents} tz={tz} today={today} selected={selDay} onSelect={d => { setSelDay(d); setOpenId(null); }} />
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10, fontSize: '.74rem', color: SUB }}>
          {CATS.map(c => <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <i style={{ width: 9, height: 9, borderRadius: 2, background: CATEGORY_META[c].color, display: 'inline-block' }} />{CATEGORY_META[c].label}
          </span>)}
          <span style={{ color: TERM_JIE, fontWeight: 600 }}>節（月初）</span>
          <span style={{ color: TERM_QI, fontWeight: 600 }}>氣（月中）</span>
          <span>二十四節氣僅供參考，台北日期</span>
          <span>點日期只看當天；再點一次取消</span>
        </div>
      </Section>

      <Section title={selDay ? `${md(selDay)}（${wd(selDay)}）事件` : `${monthLabel(shown)}事件列表`}
        note={`時間以${TZ[tzKey].label}顯示；點一下展開市場預期、實際值與歷史市場反應。`}
        right={selDay ? <button style={toggleBtn(false)} onClick={() => setSelDay(null)}>顯示整月</button> : undefined}>
        {listed.length === 0 && <div style={{ color: SUB, fontSize: '.86rem' }}>沒有符合條件的事件。{(cats.length > 0 || minImp > 1) && '（目前有套用類別／重要性篩選）'}</div>}
        {listed.map(e => (
          <EventRow key={e.id} e={e} tz={tz} now={now} open={openId === e.id}
            onToggle={() => setOpenId(id => id === e.id ? null : e.id)} history={data.history[e.historyKey]} />
        ))}
      </Section>

      <Section title="哪類事件最容易掀起波動？" note="波動放大＝事件後首個交易日平均絕對漲跌 ÷ 平常日平均絕對漲跌；≥1.3x 標紅。依加權指數排序，樣本 2015 年起。">
        <div className="mt" style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: '.82rem', minWidth: 640, width: '100%' }}>
            <thead><tr>
              {['事件類型', '樣本', '加權 波動放大', '加權 T+1 平均', '加權 T+1 上漲機率', 'NASDAQ 波動放大', 'NASDAQ T+1 平均', '費半 T+1 平均'].map((h, i) => (
                <th key={h} style={{ textAlign: i < 1 ? 'left' : 'right', padding: '6px 10px', color: SUB, fontWeight: 500, borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {historyRank.map(({ h, tw, us }) => {
                const twm = h.markets.find(m => m.symbol === '^TWII');
                const usm = h.markets.find(m => m.symbol === '^IXIC');
                const sox = h.markets.find(m => m.symbol === '^SOX');
                const td: React.CSSProperties = { textAlign: 'right', padding: '6px 10px', fontFamily: MONO, borderBottom: `1px solid ${GRID}`, whiteSpace: 'nowrap' };
                return (
                  <tr key={h.historyKey}>
                    <td style={{ ...td, textAlign: 'left', fontFamily: SANS, fontWeight: 600 }}>{h.label}</td>
                    <td style={{ ...td, color: SUB }}>{h.n}</td>
                    <td style={{ ...td, fontWeight: 700, color: fin(tw) && tw >= 1.3 ? RED : TEXT }}>{fin(tw) ? `${tw.toFixed(2)}x` : '—'}</td>
                    <td style={{ ...td, color: upDown(twm?.t1.mean) }}>{signPct(twm?.t1.mean)}</td>
                    <td style={td}>{fin(twm?.t1.upPct) ? `${twm!.t1.upPct}%` : '—'}</td>
                    <td style={{ ...td, fontWeight: 700, color: fin(us) && us >= 1.3 ? RED : TEXT }}>{fin(us) ? `${us.toFixed(2)}x` : '—'}</td>
                    <td style={{ ...td, color: upDown(usm?.t1.mean) }}>{signPct(usm?.t1.mean)}</td>
                    <td style={{ ...td, color: upDown(sox?.t1.mean) }}>{signPct(sox?.t1.mean)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: '.74rem', color: SUB, marginTop: 10, lineHeight: 1.7 }}>
          時點對齊：以事件公布時間為準，取公布前最後一個收盤為基準。例如美國 CPI 於台股收盤後公布，台股的 T+1 是隔天。
          政治事件（選舉、會晤）樣本少，僅供參考；加權指數未還原息、0050 為還原價。
        </div>
      </Section>

      <Section title="訂閱到手機行事曆" note="iPhone、Android、Mac、Outlook 都可訂閱，事件更新會自動同步。">
        <Subscribe />
      </Section>

      <div style={{ fontSize: '.74rem', color: SUB, lineHeight: 1.8, padding: '0 4px' }}>
        <div>資料來源：Fed 官網（FOMC）、FRED（CPI / PPI / 非農 / PCE 公布日與實際值）、ForexFactory（市場預期）、Yahoo Finance（財報日、股價）、央行與中選會公告（手動維護）。</div>
        <div>市場預期值自本功能上線起逐週累積，較早的事件沒有預期值；ISM 實際值以下一期公布時的前值回填，會延遲一個月。</div>
        <div>資料更新：{new Date(data.generatedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })}
          {data.historyGeneratedAt && `｜歷史反應：${new Date(data.historyGeneratedAt).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })}`}
          {failed.length > 0 && <span style={{ color: RED }}>｜⚠ 暫時無法取得：{failed.map(([k]) => k).join('、')}</span>}
        </div>
      </div>
    </div>
  );
}
