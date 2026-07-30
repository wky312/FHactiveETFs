'use client';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import MarketQuadrant from './MarketQuadrant';
import { captureAndShare } from '@/lib/captureImage';

/* 全 19 檔主動式 ETF「同區間」選股總覽（資料源：共用 Supabase）。
   台股配色：紅(RED)=漲、綠(GREEN)=跌。 */

const RED    = '#C00000';
const GREEN  = '#16a34a';
const GOLD   = '#B08F6E';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

const HIGHLIGHT = '00991A'; // 復華未來50：本站主角，列表中標亮

interface FundRow {
  ticker: string; name: string; issuer: string; holdingDate: string | null;
  nPicks: number; nWin: number; nLoss: number;
  winRate: number | null; weightedReturn: number | null;
  avgWin: number | null; avgLoss: number | null; payoff: number | null;
  investedK: number | null;
}
interface MarketComparison { startDate: string; endDate: string; funds: FundRow[]; }

type SortKey = 'ticker' | 'issuer' | 'nPicks' | 'winRate' | 'weightedReturn' | 'avgWin' | 'avgLoss' | 'payoff' | 'investedK';
const COLUMNS: { key: SortKey | null; label: string; align: 'left' | 'right'; num: boolean }[] = [
  { key: null,             label: '#',         align: 'left',  num: false },
  { key: 'ticker',         label: 'ETF',       align: 'left',  num: false },
  { key: 'issuer',         label: '發行',      align: 'left',  num: false },
  { key: 'nPicks',         label: '加碼檔數',  align: 'right', num: true },
  { key: 'winRate',        label: '進場勝率',  align: 'right', num: true },
  { key: 'weightedReturn', label: '進場報酬',  align: 'right', num: true },
  { key: 'avgWin',         label: '贏家平均',  align: 'right', num: true },
  { key: 'avgLoss',        label: '輸家平均',  align: 'right', num: true },
  { key: 'payoff',         label: '賺賠比',    align: 'right', num: true },
  { key: 'investedK',      label: '投入(仟元)', align: 'right', num: true },
];

const TH: React.CSSProperties = {
  padding: '8px 10px', fontWeight: 600, fontSize: '.72rem',
  background: TEXT, color: '#fff', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1,
};
const TD: React.CSSProperties = { padding: '7px 10px', fontFamily: MONO, fontSize: '.78rem' };

function fmtPct(n: number | null, d = 1): string {
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`;
}
function plColor(n: number | null): string {
  if (n == null) return SUB;
  return n > 0 ? RED : n < 0 ? GREEN : SUB;
}
// 台灣時間 today（YYYY-MM-DD）
function todayTW(): Date {
  return new Date(Date.now() + 8 * 3600 * 1000);
}
function iso(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function monthsAgo(n: number): string {
  const d = todayTW(); d.setUTCMonth(d.getUTCMonth() - n); return iso(d);
}
function ytdStart(): string {
  return `${todayTW().getUTCFullYear()}-01-01`;
}

const PRESETS: { key: string; label: string; from: () => string }[] = [
  { key: 'm1',  label: '近 1 月', from: () => monthsAgo(1) },
  { key: 'm3',  label: '近 3 月', from: () => monthsAgo(3) },
  { key: 'm6',  label: '近 6 月', from: () => monthsAgo(6) },
  { key: 'ytd', label: '今年以來', from: () => ytdStart() },
];

export default function MarketOverviewTab() {
  const [data,    setData]    = useState<MarketComparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [preset,  setPreset]  = useState('ytd');
  const [customFrom, setCustomFrom] = useState(monthsAgo(3));
  const [sortKey, setSortKey] = useState<SortKey | null>(null);   // null = 不排序(伺服器原序：依進場報酬)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [view, setView] = useState<'table' | 'quadrant'>('table');
  const cardRef = useRef<HTMLDivElement>(null);

  // 同一欄重複點：第1次→預設方向、第2次→反向、第3次→取消排序
  const onSort = useCallback((k: SortKey, num: boolean) => {
    const first = num ? 'desc' : 'asc';            // 數值欄高→低，文字欄 A→Z
    const second = num ? 'asc' : 'desc';
    if (sortKey !== k) { setSortKey(k); setSortDir(first); return; }
    if (sortDir === first) { setSortDir(second); return; }
    setSortKey(null);                              // 取消排序
  }, [sortKey, sortDir]);

  const sortedFunds = useMemo(() => {
    if (!data) return [];
    if (!sortKey) return data.funds;               // 取消排序 → 維持伺服器原序
    const arr = [...data.funds];
    arr.sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;                    // 無資料一律墊底
      if (vb == null) return -1;
      const cmp = typeof va === 'string'
        ? String(va).localeCompare(String(vb))
        : (va as number) - (vb as number);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [data, sortKey, sortDir]);

  const run = useCallback(async (from: string) => {
    setLoading(true); setError(''); setData(null);
    try {
      const res  = await fetch(`/api/market-scorecard?from=${encodeURIComponent(from)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json as MarketComparison);
    } catch (e) {
      setError(e instanceof Error ? e.message : '查詢失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  // 首次進入自動載入今年以來（延後一個 tick，避免在 effect body 同步 setState）
  useEffect(() => {
    const t = setTimeout(() => run(ytdStart()), 0);
    return () => clearTimeout(t);
  }, [run]);

  // 共用 captureAndShare：截圖前攤平長清單與寬表格，避免存圖被切
  const saveImage = useCallback(async () => {
    const el = cardRef.current;
    if (!el) return;
    await captureAndShare(
      el,
      `主動ETF選股勝率總覽_${data?.startDate ?? ''}_${data?.endDate ?? ''}.jpg`,
      '主動式ETF 選股勝率總覽',
    );
  }, [data]);

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>

      {/* 區間選擇 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        {PRESETS.map(p => (
          <button key={p.key} onClick={() => { setPreset(p.key); run(p.from()); }}
            style={{
              padding: '7px 14px', borderRadius: 999, border: `1px solid ${preset === p.key ? RED : BORDER}`,
              background: preset === p.key ? RED : '#fff', color: preset === p.key ? '#fff' : SUB,
              cursor: 'pointer', fontSize: '.82rem', fontWeight: preset === p.key ? 700 : 500, fontFamily: SANS,
            }}>{p.label}</button>
        ))}
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginLeft: 4 }}>
          <input type="date" value={customFrom} max={iso(todayTW())}
            onChange={e => setCustomFrom(e.target.value)}
            style={{ padding: '6px 10px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.82rem', color: TEXT, background: '#fff', fontFamily: MONO }} />
          <button onClick={() => { setPreset('custom'); run(customFrom); }}
            style={{ padding: '7px 14px', borderRadius: 6, border: 'none', background: preset === 'custom' ? RED : '#555', color: '#fff', cursor: 'pointer', fontSize: '.82rem', fontWeight: 600, fontFamily: SANS }}>
            自訂起日
          </button>
        </span>
        {data && !loading && (
          <span style={{ display: 'inline-flex', border: `1px solid ${BORDER}`, borderRadius: 999, overflow: 'hidden', marginLeft: 'auto' }}>
            {([['table', '表格'], ['quadrant', '四象限圖']] as const).map(([k, label]) => (
              <button key={k} onClick={() => setView(k)}
                style={{ padding: '7px 14px', border: 'none', cursor: 'pointer', fontFamily: SANS, fontSize: '.8rem',
                  fontWeight: view === k ? 700 : 500, background: view === k ? TEXT : '#fff', color: view === k ? '#fff' : SUB }}>
                {label}
              </button>
            ))}
          </span>
        )}
        {data && !loading && view === 'table' && (
          <button onClick={saveImage}
            style={{ padding: '7px 14px', background: '#fff', color: SUB, border: `1px solid ${BORDER}`, borderRadius: 6, cursor: 'pointer', fontSize: '.8rem', fontWeight: 500, fontFamily: SANS }}>
            儲存 / 分享圖
          </button>
        )}
      </div>
      <p style={{ fontSize: '.74rem', color: SUB, margin: '0 0 14px' }}>
        全 19 檔台股主動式 ETF 在<strong style={{ color: TEXT }}>同一區間</strong>的「<strong style={{ color: TEXT }}>這段期間進場決策</strong>」比較：只看區間內<strong style={{ color: TEXT }}>實際加碼/新進</strong>的部位，用當日成交均價算「進場成本(VWAP)」，再跟現價比 → 賺/賠。<strong style={{ color: TEXT }}>不是</strong>現有持股的收盤漲跌。資料源：全市場 Supabase（每日更新）。
      </p>

      {error && (
        <div style={{ padding: '14px 16px', background: '#fff0f0', border: '1px solid #fca5a5', borderRadius: 8, color: RED, fontSize: '.85rem', marginBottom: 16 }}>
          {error}
        </div>
      )}
      {loading && (
        <p style={{ color: SUB, textAlign: 'center', padding: '32px 0', fontSize: '.88rem' }}>結算 19 檔中…</p>
      )}

      {data && !loading && view === 'quadrant' && (
        <MarketQuadrant funds={data.funds} startDate={data.startDate} endDate={data.endDate} />
      )}

      {data && !loading && view === 'table' && (
        <div ref={cardRef} style={{ background: '#fff', padding: '4px 2px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: '1rem' }}>主動式ETF 選股勝率總覽</span>
            <span style={{ fontSize: '.76rem', color: SUB, fontFamily: MONO }}>區間 {data.startDate} ～ {data.endDate}（點欄位標題可排序）</span>
          </div>
          <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '60vh', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead>
                <tr>
                  {COLUMNS.map(c => {
                    const active = c.key != null && c.key === sortKey;
                    const arrow = !c.key ? '' : active ? (sortDir === 'asc' ? '▲' : '▼') : '↕';
                    return (
                      <th key={c.label}
                        onClick={c.key ? () => onSort(c.key!, c.num) : undefined}
                        style={{ ...TH, textAlign: c.align, cursor: c.key ? 'pointer' : 'default', userSelect: 'none' }}>
                        {c.label}
                        {arrow && <span style={{ marginLeft: 3, fontSize: '.6rem', opacity: active ? 1 : 0.4 }}>{arrow}</span>}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sortedFunds.map((f, i) => {
                  const hi = f.ticker === HIGHLIGHT;
                  return (
                    <tr key={f.ticker} style={{ background: hi ? '#FFF7F2' : i % 2 === 0 ? '#fff' : '#FAFAF9', borderBottom: `1px solid ${BORDER}`, borderLeft: hi ? `3px solid ${GOLD}` : '3px solid transparent' }}>
                      <td style={{ ...TD, color: SUB }}>{i + 1}</td>
                      <td style={{ ...TD, fontFamily: SANS }}>
                        <span style={{ fontFamily: MONO, fontWeight: 700, color: hi ? RED : TEXT }}>{f.ticker}</span>
                        <span style={{ color: TEXT, marginLeft: 6 }}>{f.name}</span>
                      </td>
                      <td style={{ ...TD, fontFamily: SANS, color: SUB }}>{f.issuer}</td>
                      <td style={{ ...TD, textAlign: 'right', color: SUB }}>{f.nPicks}</td>
                      <td style={{ ...TD, textAlign: 'right', fontWeight: 700, color: f.winRate == null ? SUB : f.winRate >= 50 ? RED : GREEN }}>{f.winRate == null ? '—' : `${f.winRate.toFixed(0)}%`}</td>
                      <td style={{ ...TD, textAlign: 'right', fontWeight: 700, color: plColor(f.weightedReturn) }}>{fmtPct(f.weightedReturn)}</td>
                      <td style={{ ...TD, textAlign: 'right', color: plColor(f.avgWin) }}>{fmtPct(f.avgWin)}</td>
                      <td style={{ ...TD, textAlign: 'right', color: plColor(f.avgLoss) }}>{fmtPct(f.avgLoss)}</td>
                      <td style={{ ...TD, textAlign: 'right', color: TEXT }}>{f.payoff == null ? '—' : f.payoff.toFixed(2)}</td>
                      <td style={{ ...TD, textAlign: 'right', color: SUB }}>{f.investedK == null ? '—' : Math.round(f.investedK).toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12, fontSize: '.7rem', color: SUB, lineHeight: 1.8 }}>
            <b>口徑（進場成本）：</b>用每日持股快照差分，取 {data.startDate}～{data.endDate} 內每天<b>加碼/新進的股數 × 當日成交均價</b>，加總算「<u>本期進場 VWAP</u>」，再跟現價(最新收盤)比 → 賺/賠。<b>加碼檔數</b>＝本區間有買進的個股數，<b>進場勝率</b>＝其中賺錢的比例，<b>進場報酬</b>＝依「本期投入金額」加權。<br />
            評的是「<u>這段期間的進場決策</u>」：某股就算整體持倉均價被歷史便宜成本稀釋，只要本期加碼買貴了現價、仍算賠（與「現有持股漲跌」不同）。只進場前就持有、本期沒加碼者不列入。報酬未還原息。<br />
            <b>資料來源：</b>全市場主動式 ETF 每日持股（CMoney）＋ TWSE／TPEx 收盤/成交均價，存於共用 Supabase。<span style={{ color: GOLD }}>橘線＝復華未來50（本站主角）</span>。
          </div>
        </div>
      )}
    </div>
  );
}
