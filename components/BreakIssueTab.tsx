'use client';
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { captureAndShare } from '@/lib/captureImage';
import type { BreakIssueRow, BreakIssuePayload, BreakIssueStatus } from '@/lib/breakIssue';

/* ── 復華設計 token（與 Dashboard 一致）── */
const RED    = '#C00000';   // 台股慣例：漲 / 站上發行價 = 紅
const GREEN  = '#1A6B45';   // 跌 / 仍破發 = 綠
const GOLD   = '#B08F6E';
const CARD   = '#FFFFFF';
const HEADER = '#F7F4F0';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#E8E3DF';
const GRID   = '#EFEAE4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

const SHARE_TITLE = '主動式ETF掛牌破發追蹤';

/* ── helpers ── */
const fmtPct = (v: number | null) => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
const dnum = (s: string) => Date.parse(s + 'T00:00:00Z');
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quarterOf = (iso: string) => {
  const [y, m] = iso.split('-').map(Number);
  return `${y}Q${Math.floor((m - 1) / 3) + 1}`;
};
const STATUS_LABEL: Record<BreakIssueStatus, string> = {
  above: '已站回發行價之上', below: '目前仍在發行價下方', never: '從未跌破發行價',
};
const colorFor = (s: BreakIssueStatus) => s === 'above' ? RED : s === 'below' ? GREEN : GOLD;

/* ── 可存圖的區塊卡片 ── */
function Section({
  title, note, onShare, onExcel, children,
}: {
  title: string; note?: string;
  onShare: (el: HTMLElement) => void;
  onExcel?: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const btn: React.CSSProperties = {
    padding: '6px 14px', background: '#fff', color: RED, border: `1.4px solid ${RED}`,
    borderRadius: 6, cursor: 'pointer', fontSize: '.8rem', fontWeight: 600, fontFamily: SANS,
  };
  return (
    <div ref={ref} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 3px rgba(28,28,30,.05)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        padding: '12px 18px', background: HEADER, borderBottom: `1px solid ${BORDER}`, flexWrap: 'wrap',
      }}>
        <div>
          <div style={{ fontSize: '.98rem', fontWeight: 700, color: TEXT, fontFamily: SANS }}>{title}</div>
          {note && <div style={{ fontSize: '.76rem', color: SUB, marginTop: 2, fontFamily: SANS }}>{note}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {onExcel && <button style={btn} onClick={onExcel}>↓ 匯出 Excel</button>}
          <button style={btn} onClick={() => ref.current && onShare(ref.current)}>儲存 / 分享</button>
        </div>
      </div>
      <div style={{ padding: 18 }}>{children}</div>
    </div>
  );
}

/* ══════════ 圖一：掛牌日 × 至今報酬 散佈圖 ══════════ */
function ScatterChart({ rows }: { rows: BreakIssueRow[] }) {
  const W = 900, H = 440, m = { l: 46, r: 16, t: 16, b: 40 };
  const x0 = m.l, x1 = W - m.r, y0 = H - m.b, y1 = m.t;
  const dmin = dnum('2025-04-20'), dmax = dnum('2026-10-05');
  const vmin = -30, vmax = 220;
  const sx = (d: number) => x0 + (d - dmin) / (dmax - dmin) * (x1 - x0);
  const sy = (v: number) => y0 + (v - vmin) / (vmax - vmin) * (y1 - y0);
  const months = ['2025-05', '2025-07', '2025-09', '2025-11', '2026-01', '2026-03', '2026-05', '2026-07', '2026-09'];

  return (
    <>
    <svg viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', width: '100%', height: 'auto', fontFamily: MONO }}>
      {/* 2026/5–6 掛牌梯次陰影帶 */}
      <rect x={sx(dnum('2026-05-24'))} y={y1} width={sx(dnum('2026-06-18')) - sx(dnum('2026-05-24'))} height={y0 - y1} fill={GOLD} opacity={0.12} />
      <text x={(sx(dnum('2026-05-24')) + sx(dnum('2026-06-18'))) / 2} y={y1 + 12} textAnchor="middle" fontSize={9.5} fill={GOLD}>2026/5–6 掛牌</text>
      {/* y grid */}
      {Array.from({ length: 7 }, (_, i) => -20 + i * 40).map(v => (
        <g key={v}>
          <line x1={x0} y1={sy(v)} x2={x1} y2={sy(v)} stroke={v === 0 ? SUB : GRID} strokeWidth={v === 0 ? 1.3 : 1} />
          <text x={x0 - 7} y={sy(v) + 3.5} textAnchor="end" fontSize={10} fill={SUB}>{v}</text>
        </g>
      ))}
      {/* x axis */}
      <line x1={x0} y1={y0} x2={x1} y2={y0} stroke={SUB} strokeWidth={1} />
      {months.map(ms => (
        <g key={ms}>
          <line x1={sx(dnum(ms + '-01'))} y1={y0} x2={sx(dnum(ms + '-01'))} y2={y0 + 4} stroke={SUB} />
          <text x={sx(dnum(ms + '-01'))} y={y0 + 16} textAnchor="middle" fontSize={9.5} fill={SUB}>{ms.replace('-', '/')}</text>
        </g>
      ))}
      <text x={x0 - 34} y={y1 - 3} fontSize={10} fill={SUB}>至今報酬 %</text>
      {/* points */}
      {rows.map(r => {
        if (r.retNow == null) return null;
        const cx = sx(dnum(r.listDate));
        const cy = sy(Math.max(vmin + 2, Math.min(vmax - 2, r.retNow)));
        const col = colorFor(r.status);
        const tip = `${r.ticker} ${r.name}\n掛牌 ${r.listDate}（${r.issuer}投信）\n至今 ${fmtPct(r.retNow)}｜${STATUS_LABEL[r.status]}` +
          (r.firstBreakDate ? `\n首次破發 ${r.firstBreakDate}` : '') +
          (r.reclaimDate ? `\n站回發行價 隔 ${r.reclaimGap} 天` : '');
        const common = { opacity: r.fresh ? 0.45 : 1 };
        return (
          <g key={r.ticker}>
            <title>{tip}</title>
            {r.status === 'above'
              ? <circle cx={cx} cy={cy} r={4.6} fill={col} {...common} />
              : r.status === 'below'
                ? <path d={`M ${cx} ${cy + 5.2} L ${cx - 5} ${cy - 3.6} L ${cx + 5} ${cy - 3.6} Z`} fill={col} {...common} />
                : <path d={`M ${cx} ${cy - 5.4} L ${cx + 5.4} ${cy} L ${cx} ${cy + 5.4} L ${cx - 5.4} ${cy} Z`} fill="none" stroke={col} strokeWidth={1.6} {...common} />}
          </g>
        );
      })}
    </svg>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 10, fontSize: '.78rem', color: SUB, fontFamily: SANS }}>
      <span><span style={{ display: 'inline-block', width: 12, height: 12, background: RED, borderRadius: 999, marginRight: 6, verticalAlign: 'middle' }} />已站回發行價之上</span>
      <span><span style={{ display: 'inline-block', width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: `10px solid ${GREEN}`, marginRight: 6, verticalAlign: 'middle' }} />仍在發行價下方</span>
      <span><span style={{ display: 'inline-block', width: 9, height: 9, border: `1.6px solid ${GOLD}`, transform: 'rotate(45deg)', marginRight: 8, verticalAlign: 'middle' }} />從未跌破發行價</span>
      <span style={{ color: SUB }}>淡色 = 掛牌未滿 20 個交易日</span>
    </div>
    </>
  );
}

/* ══════════ 圖二：破發後收復發行價所需交易日 ══════════ */
function RecoveryBars({ rows }: { rows: BreakIssueRow[] }) {
  const broke = rows.filter(r => r.firstBreakDate && !r.fresh);
  const buckets = [
    { k: '隔 1 個交易日', fn: (r: BreakIssueRow) => r.reclaimHeld && r.reclaimGap === 1 },
    { k: '隔 2 個交易日', fn: (r: BreakIssueRow) => r.reclaimHeld && r.reclaimGap === 2 },
    { k: '隔 3 個交易日', fn: (r: BreakIssueRow) => r.reclaimHeld && r.reclaimGap === 3 },
    { k: '隔 4–7 個交易日', fn: (r: BreakIssueRow) => r.reclaimHeld && (r.reclaimGap ?? 0) >= 4 && (r.reclaimGap ?? 0) <= 7 },
    { k: '隔 8 個交易日以上', fn: (r: BreakIssueRow) => r.reclaimHeld && (r.reclaimGap ?? 0) >= 8 },
    { k: '短暫收復又跌破', fail: true, fn: (r: BreakIssueRow) => !r.reclaimHeld && !!r.reclaimDate },
    { k: '至今從未收復', fail: true, fn: (r: BreakIssueRow) => !r.reclaimHeld && !r.reclaimDate },
  ].map(b => { const items = broke.filter(b.fn); return { ...b, n: items.length, items: items.map(x => x.ticker) }; });

  const W = 900, H = 300, m = { l: 150, r: 60, t: 8, b: 26 };
  const x0 = m.l, x1 = W - m.r, y1 = m.t, y0 = H - m.b;
  const maxN = Math.max(1, ...buckets.map(b => b.n));
  const sx = (n: number) => x0 + n / maxN * (x1 - x0);
  const bh = 24, gap = (y0 - y1 - buckets.length * bh) / (buckets.length - 1);
  const held = broke.filter(r => r.reclaimHeld).length;

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', width: '100%', height: 'auto', fontFamily: MONO }}>
        {Array.from({ length: maxN + 1 }, (_, i) => i).filter(i => i % 2 === 0).map(i => (
          <g key={i}>
            <line x1={sx(i)} y1={y1} x2={sx(i)} y2={y0} stroke={GRID} />
            <text x={sx(i)} y={y0 + 15} textAnchor="middle" fontSize={9.5} fill={SUB}>{i}</text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const y = y1 + i * (bh + gap);
          const col = b.fail ? GREEN : GOLD;
          const w = Math.max(2, sx(b.n) - x0);
          return (
            <g key={b.k}>
              <title>{`${b.k}：${b.n} 檔\n${b.items.join('、') || '—'}`}</title>
              <rect x={x0} y={y} width={w} height={bh} rx={4} fill={col} />
              <text x={x0 - 10} y={y + bh / 2 + 4} textAnchor="end" fontSize={12} fill={b.fail ? GREEN : TEXT} fontFamily={SANS}>{b.k}</text>
              <text x={x0 + w + 7} y={y + bh / 2 + 4} fontSize={12} fontWeight={600} fill={b.fail ? GREEN : TEXT}>{b.n}</text>
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: '.78rem', color: SUB, fontFamily: SANS }}>
        <span><span style={{ display: 'inline-block', width: 18, height: 10, background: GOLD, borderRadius: 2, marginRight: 5, verticalAlign: 'middle' }} />已站回並守住（{held} 檔）</span>
        <span><span style={{ display: 'inline-block', width: 18, height: 10, background: GREEN, borderRadius: 2, marginRight: 5, verticalAlign: 'middle' }} />未持穩 / 從未收復（{broke.length - held} 檔）</span>
      </div>
    </>
  );
}

/* ══════════ 圖三：各掛牌梯次（季）後續表現 ══════════ */
function CohortBars({ rows }: { rows: BreakIssueRow[] }) {
  const order = ['2025Q2', '2025Q3', '2025Q4', '2026Q1', '2026Q2', '2026Q3'];
  const groups = order.map(q => {
    const g = rows.filter(r => quarterOf(r.listDate) === q);
    const rets = g.map(r => r.retNow).filter((v): v is number => v != null);
    return {
      q, n: g.length,
      med: rets.length ? median(rets) : NaN,
      below: g.filter(r => r.status === 'below' && !r.fresh).length,
    };
  }).filter(g => g.n > 0);

  const W = 900, H = 320, m = { l: 46, r: 16, t: 22, b: 46 };
  const x0 = m.l, x1 = W - m.r, y0 = H - m.b, y1 = m.t;
  const vals = groups.map(g => g.med).filter(v => !Number.isNaN(v));
  const vmax = Math.ceil(Math.max(20, ...vals) * 1.12 / 20) * 20;
  const vmin = Math.floor(Math.min(-10, ...vals) * 1.12 / 10) * 10;
  const sy = (v: number) => y0 + (v - vmin) / (vmax - vmin) * (y1 - y0);
  const bw = (x1 - x0) / groups.length * 0.5;
  const ticks = Array.from(new Set([vmin, Math.round(vmax / 2 / 20) * 20, 0, vmax])).filter(v => v >= vmin && v <= vmax).sort((a, b) => a - b);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', width: '100%', height: 'auto', fontFamily: MONO }}>
      {ticks.map((v, i) => (
        <g key={i}>
          <line x1={x0} y1={sy(v)} x2={x1} y2={sy(v)} stroke={v === 0 ? SUB : GRID} strokeWidth={v === 0 ? 1.3 : 1} />
          <text x={x0 - 7} y={sy(v) + 3.5} textAnchor="end" fontSize={10} fill={SUB}>{v}</text>
        </g>
      ))}
      <text x={x0 - 34} y={y1 - 6} fontSize={10} fill={SUB}>該梯至今報酬中位數 %</text>
      {groups.map((g, i) => {
        const cx = x0 + (i + 0.5) / groups.length * (x1 - x0);
        const top = sy(Math.max(g.med, 0));
        const bot = sy(Math.min(g.med, 0));
        const col = g.med >= 0 ? RED : GREEN;
        return (
          <g key={g.q}>
            <title>{`${g.q}｜掛牌 ${g.n} 檔\n至今報酬中位數 ${fmtPct(g.med)}\n目前仍破發 ${g.below} 檔`}</title>
            <rect x={cx - bw / 2} y={top} width={bw} height={Math.max(1, bot - top)} rx={3} fill={col} />
            <text x={cx} y={g.med >= 0 ? top - 6 : bot + 14} textAnchor="middle" fontSize={11} fontWeight={600} fill={col}>{fmtPct(g.med)}</text>
            <text x={cx} y={y0 + 15} textAnchor="middle" fontSize={10.5} fill={TEXT} fontFamily={SANS}>{g.q}</text>
            <text x={cx} y={y0 + 30} textAnchor="middle" fontSize={9} fill={SUB} fontFamily={SANS}>{g.n} 檔{g.below ? `・破發中 ${g.below}` : ''}</text>
          </g>
        );
      })}
    </svg>
  );
}

/* ══════════ 明細表 ══════════ */
type SortK = 'ticker' | 'name' | 'issuer' | 'listDate' | 'day1Break' | 'first10BreakDay' | 'firstBreakDate' | 'low20' | 'reclaimGap' | 'status' | 'ret3m' | 'ret6m' | 'retNow';

function DetailTable({ rows }: { rows: BreakIssueRow[] }) {
  const [issuer, setIssuer] = useState('');
  const [sortK, setSortK] = useState<SortK>('listDate');
  const [sortDir, setSortDir] = useState(1);

  const issuers = useMemo(() => Array.from(new Set(rows.map(r => r.issuer))).sort((a, b) => a.localeCompare(b, 'zh-Hant')), [rows]);
  const shown = useMemo(() => {
    const f = issuer ? rows.filter(r => r.issuer === issuer) : rows;
    const val = (r: BreakIssueRow): string | number => {
      if (sortK === 'status') return { above: 0, never: 1, below: 2 }[r.status];
      const v = r[sortK];
      return v == null ? (sortDir === 1 ? Infinity : -Infinity) : (typeof v === 'boolean' ? (v ? 1 : 0) : v);
    };
    return [...f].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === 'string' && typeof vb === 'string') return sortDir * va.localeCompare(vb);
      return sortDir * ((va as number) - (vb as number));
    });
  }, [rows, issuer, sortK, sortDir]);

  const broke = shown.filter(r => r.firstBreakDate);
  const belowNow = shown.filter(r => r.status === 'below');

  const th = (k: SortK, label: React.ReactNode) => (
    <th
      onClick={() => { if (k === sortK) setSortDir(d => -d); else { setSortK(k); setSortDir(k === 'ticker' || k === 'name' || k === 'issuer' || k === 'listDate' || k === 'firstBreakDate' ? 1 : -1); } }}
      style={{ padding: '9px 8px', background: HEADER, color: SUB, fontWeight: 500, textAlign: 'right', borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap', cursor: 'pointer', fontFamily: SANS, lineHeight: 1.3, position: 'sticky', top: 0 }}
    >
      {label}{k === sortK && <span style={{ color: RED, marginLeft: 2 }}>{sortDir === 1 ? '▲' : '▼'}</span>}
    </th>
  );
  const td: React.CSSProperties = { padding: '7px 8px', textAlign: 'right', borderBottom: `1px solid ${GRID}`, whiteSpace: 'nowrap', fontFamily: MONO, fontVariantNumeric: 'tabular-nums' };
  const retTd = (v: number | null) => <td style={{ ...td, color: v == null ? SUB : v > 0 ? RED : v < 0 ? GREEN : TEXT }}>{fmtPct(v)}</td>;
  const pill = (s: BreakIssueStatus) => {
    const map = { above: [RED, '#F7E7E4', '已收復'], below: [GREEN, '#E3F0E7', '仍破發'], never: [GOLD, '#F5EDDA', '未曾破發'] } as const;
    const [c, bg, label] = map[s];
    return <span style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: '.7rem', fontFamily: SANS, fontWeight: 500, color: c, background: bg }}>{label}</span>;
  };

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <label style={{ fontSize: '.82rem', color: SUB, fontFamily: SANS }}>發行公司</label>
        <select value={issuer} onChange={e => setIssuer(e.target.value)}
          style={{ font: 'inherit', fontSize: '.84rem', color: TEXT, background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, padding: '5px 10px', fontFamily: SANS }}>
          <option value="">全部（{issuers.length} 家）</option>
          {issuers.map(i => <option key={i} value={i}>{i}投信（{rows.filter(r => r.issuer === i).length}）</option>)}
        </select>
        <span style={{ fontSize: '.78rem', color: SUB, fontFamily: MONO }}>
          {issuer
            ? <>{issuer}投信 <b style={{ color: TEXT }}>{shown.length}</b> 檔・曾破發 <b style={{ color: TEXT }}>{broke.length}</b>・目前仍破發 <b style={{ color: TEXT }}>{belowNow.length}</b></>
            : <>顯示 <b style={{ color: TEXT }}>{shown.length}</b> / {rows.length} 檔</>}
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '.74rem' }}>
          <thead><tr>
            {th('ticker', '代號')}{th('name', '名稱')}{th('issuer', '發行')}{th('listDate', '掛牌日')}
            {th('day1Break', <>首日<br />破發</>)}{th('first10BreakDay', <>前10日破發<br />(第N交易日)</>)}
            {th('firstBreakDate', <>首次<br />破發日</>)}{th('low20', <>初期最低收盤<br />(第N交易日)</>)}
            {th('reclaimGap', '站回發行價')}{th('status', '現況')}{th('ret3m', '3個月')}{th('ret6m', '6個月')}{th('retNow', '至今')}
          </tr></thead>
          <tbody>
            {shown.map(r => (
              <tr key={r.ticker}>
                <td style={{ ...td, textAlign: 'left', fontWeight: 500, color: TEXT, letterSpacing: '.02em' }}>
                  {r.ticker}{r.tpex && <span style={{ color: SUB, fontSize: '.9em' }}> 櫃</span>}{r.issuePrice === 15 && <span style={{ color: SUB, fontSize: '.9em' }}> $15</span>}
                </td>
                <td style={{ ...td, textAlign: 'left', fontFamily: SANS }}>{r.name.replace(/^主動/, '')}</td>
                <td style={{ ...td, textAlign: 'left', fontFamily: SANS, color: SUB }}>{r.issuer}</td>
                <td style={td}>{r.listDate}{r.approxListDate && <span style={{ color: RED }} title="掛牌日採官方公布日，此欄為近似"> †</span>}</td>
                <td style={{ ...td, color: r.day1Break ? RED : SUB, fontWeight: r.day1Break ? 600 : 400 }}>{r.day1Break ? '是' : '否'}</td>
                <td style={td}>{r.first10BreakDay ? `第 ${r.first10BreakDay} 日` : (r.firstBreakDate ? <span style={{ color: SUB }}>晚於第 10 日</span> : <span style={{ color: SUB }}>否</span>)}</td>
                <td style={td}>{r.firstBreakDate ?? <span style={{ color: SUB }}>從未</span>}</td>
                <td style={td}>{r.low20.toFixed(2)} <span style={{ color: SUB, fontSize: '.9em' }}>(第 {r.low20Day} 日)</span></td>
                <td style={td}>{r.reclaimDate
                  ? <>隔 {r.reclaimGap} 天（{r.reclaimDate}）{!r.reclaimHeld && <span style={{ color: SUB, fontSize: '.9em' }}> 後又跌破</span>}</>
                  : (r.firstBreakDate ? <span style={{ color: SUB }}>尚未收復</span> : <span style={{ color: SUB }}>—</span>)}</td>
                <td style={td}>{pill(r.status)}{r.fresh && <span style={{ color: SUB, fontSize: '.82em' }}> ·掛牌{r.tradingDays}日</span>}</td>
                {retTd(r.ret3m)}{retTd(r.ret6m)}{retTd(r.retNow)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* export helper reused by parent */
function toAoa(rows: BreakIssueRow[]): (string | number)[][] {
  const head = ['代號', '名稱', '發行公司', '交易所', '掛牌日', '發行價', '首日破發', '前10日破發第N交易日', '首次破發日',
    '初期最低收盤', '最低收盤第N交易日', '站回發行價日', '站回相隔交易日', '站回後是否守住', '現況',
    '3個月報酬%', '6個月報酬%', '至今報酬%', '交易日數'];
  const body = rows.map(r => [
    r.ticker, r.name, r.issuer, r.tpex ? '上櫃' : '上市', r.listDate, r.issuePrice,
    r.day1Break ? '是' : '否',
    r.first10BreakDay ?? (r.firstBreakDate ? '晚於第10日' : '否'),
    r.firstBreakDate ?? '從未',
    r.low20, r.low20Day,
    r.reclaimDate ?? (r.firstBreakDate ? '尚未收復' : ''),
    r.reclaimGap ?? '',
    r.firstBreakDate ? (r.reclaimHeld ? '是' : '否') : '',
    r.status === 'above' ? '已收復' : r.status === 'below' ? '仍破發' : '未曾破發',
    r.ret3m ?? '', r.ret6m ?? '', r.retNow ?? '', r.tradingDays,
  ]);
  return [head, ...body];
}

/* ══════════ 主組件 ══════════ */
export default function BreakIssueTab() {
  const [data, setData] = useState<BreakIssuePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/break-issue');
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        if (alive) setData(j as BreakIssuePayload);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : '載入失敗');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const share = useCallback((el: HTMLElement, name: string) => {
    captureAndShare(el, `主動式ETF破發_${name}_${data?.asOf ?? ''}.png`, SHARE_TITLE);
  }, [data]);

  const summary = useMemo(() => {
    if (!data) return null;
    const rows = data.rows;
    const everBroke = rows.filter(r => r.firstBreakDate);
    const in10 = rows.filter(r => r.first10BreakDay);
    const reclaimed = rows.filter(r => r.reclaimDate);
    const gaps = reclaimed.map(r => r.reclaimGap!).sort((a, b) => a - b);
    const never = rows.filter(r => r.status === 'never');
    const belowNow = rows.filter(r => r.status === 'below' && !r.fresh);
    const r3 = rows.map(r => r.ret3m).filter((v): v is number => v != null);
    const r6 = rows.map(r => r.ret6m).filter((v): v is number => v != null);
    return {
      total: rows.length,
      everBroke: everBroke.length, in10: in10.length,
      reclaimN: reclaimed.length,
      gapMed: gaps.length ? median(gaps) : NaN,
      gapLe3: gaps.filter(g => g <= 3).length,
      neverCodes: never.map(r => r.ticker),
      belowNow: belowNow.length,
      med3: r3.length ? median(r3) : NaN, n3: r3.length,
      med6: r6.length ? median(r6) : NaN, n6: r6.length,
    };
  }, [data]);

  if (loading) return (
    <div style={{ padding: '48px 0', textAlign: 'center', color: SUB, fontFamily: SANS, fontSize: '.9rem' }}>
      查詢 Yahoo Finance 中，首次載入約需 20–40 秒…
    </div>
  );
  if (error) return (
    <div style={{ padding: '32px 0', textAlign: 'center', color: RED, fontFamily: SANS }}>載入失敗：{error}</div>
  );
  if (!data || !summary) return null;

  const tile = (label: string, num: React.ReactNode, sub: string, tone?: 'up' | 'down' | 'flat') => (
    <div style={{ flex: '1 1 190px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '14px 15px' }}>
      <div style={{ fontSize: '.76rem', color: SUB, lineHeight: 1.4, minHeight: '2.5em', fontFamily: SANS }}>{label}</div>
      <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: '1.55rem', margin: '.3em 0 .15em', color: tone === 'up' ? RED : tone === 'down' ? GREEN : tone === 'flat' ? GOLD : TEXT }}>{num}</div>
      <div style={{ fontFamily: MONO, fontSize: '.68rem', color: SUB, lineHeight: 1.45 }}>{sub}</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, fontFamily: SANS }}>
      <div style={{ fontSize: '.86rem', color: SUB, maxWidth: '70ch', lineHeight: 1.6 }}>
        2025 年 5 月首批以來、{summary.total} 檔台股掛牌交易的主動式 ETF（含 00998A、00411A 於櫃買中心上櫃），
        統計掛牌後是否跌破發行價、多久收復、以及 3／6 個月與至今的還原（含息）報酬。資料截至 {data.asOf}，價格來源 Yahoo Finance。
        {data.errors.length > 0 && <span style={{ color: RED }}>（{data.errors.join('、')} 暫無資料）</span>}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {tile('曾跌破發行價的檔數', `${summary.everBroke} / ${summary.total}`, `${summary.in10} 檔在掛牌前 10 個交易日內`)}
        {tile('破發後站回發行價所需交易日（中位數）', Number.isNaN(summary.gapMed) ? '—' : `${summary.gapMed} 天`, `曾站回者 ${summary.reclaimN} 檔・${summary.gapLe3} 檔在 3 日內`)}
        {tile('從未跌破發行價', `${summary.neverCodes.length} 檔`, summary.neverCodes.join('、'), 'flat')}
        {tile('掛牌後 3 個月報酬（還原，中位數）', Number.isNaN(summary.med3) ? '—' : fmtPct(summary.med3), `6 個月中位數 ${Number.isNaN(summary.med6) ? '—' : fmtPct(summary.med6)}（${summary.n6} 檔）`, summary.med3 >= 0 ? 'up' : 'down')}
        {tile('掛牌逾一個月、目前仍在發行價下方', `${summary.belowNow} 檔`, '多為 2026/5–6 掛牌梯次', 'down')}
      </div>

      <Section
        title="圖一：掛牌日 × 至今報酬"
        note="每點一檔基金。● 已站回發行價之上、▼ 仍在發行價下方、◇ 從未跌破發行價；淡色點為掛牌未滿 20 日。陰影為 2026 年 5–6 月掛牌梯次。滑鼠移至點上看單檔。"
        onShare={el => share(el, '掛牌日對報酬')}
      >
        <ScatterChart rows={data.rows} />
      </Section>

      <Section
        title="圖二：破發後收復發行價所需交易日"
        note="統計曾破發、且掛牌逾一個月者。「短暫收復又跌破」＝曾站回、但於 2026 年 7 月下旬回檔再度跌破且至今未收復。"
        onShare={el => share(el, '收復速度')}
      >
        <RecoveryBars rows={data.rows} />
      </Section>

      <Section
        title="圖三：各掛牌梯次（季）後續表現"
        note="依掛牌季度分組，長條為該梯「至今還原報酬」的中位數，下方標示該梯檔數與目前仍破發檔數。"
        onShare={el => share(el, '掛牌梯次')}
      >
        <CohortBars rows={data.rows} />
      </Section>

      <Section
        title={`逐檔明細（${summary.total} 檔）`}
        note="點欄位標題可排序。「初期最低收盤」為掛牌後前 20 個交易日的最低收盤（未還原）及其為掛牌後第幾個交易日。漲以紅字、跌以綠字。"
        onShare={el => share(el, '逐檔明細')}
        onExcel={() => {
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(toAoa(data.rows)), '破發追蹤');
          XLSX.writeFile(wb, `主動式ETF掛牌破發追蹤_${data.asOf}.xlsx`);
        }}
      >
        <DetailTable rows={data.rows} />
        <div style={{ borderLeft: `3px solid ${RED}`, background: HEADER, borderRadius: '0 10px 10px 0', padding: '14px 18px', marginTop: 16, fontSize: '.8rem', color: SUB, lineHeight: 1.65 }}>
          <div style={{ fontWeight: 700, color: TEXT, marginBottom: 6, fontFamily: SANS }}>口徑與限制</div>
          <ul style={{ margin: 0, paddingLeft: '1.1em' }}>
            <li>「破發」＝收盤價低於發行價。發行價除 00989A、00998A 為 15 元外，均為 10 元。</li>
            <li>00998A（2026/04/15）、00411A（2026/08/26）於櫃買中心上櫃，Yahoo 代號為 <code>.TWO</code>，表中標「櫃」；其餘為證交所上市。</li>
            <li>首批 00980A／00981A／00982A 掛牌日採官方公布日（標 †），Yahoo 另有掛牌前 K 棒已剔除，其「首日破發／第 N 日」為近似值。</li>
            <li>「初期最低收盤」取掛牌後前 20 個交易日、未還原收盤價（除息日可能機械性壓低）。</li>
            <li>「站回發行價」為首次破發後、首次收盤重新 ≥ 發行價之日；部分 2026 年中掛牌者曾短暫站回、7 月下旬又跌破，現況仍列「仍破發」。</li>
            <li>3／6 個月報酬＝掛牌日加 3／6 個曆月後第一個交易日，對掛牌首日的還原（含息）報酬；未滿期者留白。報酬採「先進位」計算，與券商軟體對齊。</li>
            <li>樣本 {summary.total} 檔、期間偏短、無已下市標的（存活者偏誤）。本頁為公開市場數據整理，非投資建議。</li>
          </ul>
        </div>
      </Section>
    </div>
  );
}
