'use client';
import { useState, useCallback, useRef, useEffect } from 'react';

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
  nHoldings: number; nEval: number; nWin: number; nLoss: number;
  winRate: number | null; weightedReturn: number | null;
  avgWin: number | null; avgLoss: number | null; payoff: number | null;
}
interface MarketComparison { startDate: string; endDate: string; funds: FundRow[]; }

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
  const cardRef = useRef<HTMLDivElement>(null);

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

  const saveImage = useCallback(async () => {
    const el = cardRef.current;
    if (!el) return;
    try {
      await document.fonts.ready;
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
      const name = `主動ETF選股勝率總覽_${data?.startDate ?? ''}_${data?.endDate ?? ''}.jpg`;
      if (typeof navigator !== 'undefined' && navigator.canShare) {
        try {
          const blob = await new Promise<Blob>((r) => canvas.toBlob(b => r(b!), 'image/jpeg', 0.92));
          const file = new File([blob], name, { type: 'image/jpeg' });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ title: '主動式ETF 選股勝率總覽', files: [file] });
            return;
          }
        } catch { /* 取消 → 下載 */ }
      }
      const link = document.createElement('a');
      link.download = name; link.href = canvas.toDataURL('image/jpeg', 0.92); link.click();
    } catch (e) { console.error('截圖失敗', e); }
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
          <button onClick={saveImage}
            style={{ padding: '7px 14px', background: '#fff', color: SUB, border: `1px solid ${BORDER}`, borderRadius: 6, cursor: 'pointer', fontSize: '.8rem', fontWeight: 500, fontFamily: SANS }}>
            儲存 / 分享圖
          </button>
        )}
      </div>
      <p style={{ fontSize: '.74rem', color: SUB, margin: '0 0 14px' }}>
        全 19 檔台股主動式 ETF 在<strong style={{ color: TEXT }}>同一區間</strong>的「現有持股表現」比較：勝率＝期間上漲的持股比例、加權報酬＝依持股權重加權。資料源：全市場 Supabase（每日更新）。
      </p>

      {error && (
        <div style={{ padding: '14px 16px', background: '#fff0f0', border: '1px solid #fca5a5', borderRadius: 8, color: RED, fontSize: '.85rem', marginBottom: 16 }}>
          {error}
        </div>
      )}
      {loading && (
        <p style={{ color: SUB, textAlign: 'center', padding: '32px 0', fontSize: '.88rem' }}>結算 19 檔中…</p>
      )}

      {data && !loading && (
        <div ref={cardRef} style={{ background: '#fff', padding: '4px 2px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: '1rem' }}>主動式ETF 選股勝率總覽</span>
            <span style={{ fontSize: '.76rem', color: SUB, fontFamily: MONO }}>區間 {data.startDate} ～ {data.endDate}（依加權報酬排序）</span>
          </div>
          <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '60vh', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead>
                <tr>
                  <th style={{ ...TH, textAlign: 'left' }}>#</th>
                  <th style={{ ...TH, textAlign: 'left' }}>ETF</th>
                  <th style={{ ...TH, textAlign: 'left' }}>發行</th>
                  <th style={{ ...TH, textAlign: 'right' }}>持股數</th>
                  <th style={{ ...TH, textAlign: 'right' }}>勝率</th>
                  <th style={{ ...TH, textAlign: 'right' }}>加權報酬</th>
                  <th style={{ ...TH, textAlign: 'right' }}>贏家平均</th>
                  <th style={{ ...TH, textAlign: 'right' }}>輸家平均</th>
                  <th style={{ ...TH, textAlign: 'right' }}>賺賠比</th>
                </tr>
              </thead>
              <tbody>
                {data.funds.map((f, i) => {
                  const hi = f.ticker === HIGHLIGHT;
                  return (
                    <tr key={f.ticker} style={{ background: hi ? '#FFF7F2' : i % 2 === 0 ? '#fff' : '#FAFAF9', borderBottom: `1px solid ${BORDER}`, borderLeft: hi ? `3px solid ${GOLD}` : '3px solid transparent' }}>
                      <td style={{ ...TD, color: SUB }}>{i + 1}</td>
                      <td style={{ ...TD, fontFamily: SANS }}>
                        <span style={{ fontFamily: MONO, fontWeight: 700, color: hi ? RED : TEXT }}>{f.ticker}</span>
                        <span style={{ color: TEXT, marginLeft: 6 }}>{f.name}</span>
                      </td>
                      <td style={{ ...TD, fontFamily: SANS, color: SUB }}>{f.issuer}</td>
                      <td style={{ ...TD, textAlign: 'right', color: SUB }}>{f.nEval}</td>
                      <td style={{ ...TD, textAlign: 'right', fontWeight: 700, color: f.winRate == null ? SUB : f.winRate >= 50 ? RED : GREEN }}>{f.winRate == null ? '—' : `${f.winRate.toFixed(0)}%`}</td>
                      <td style={{ ...TD, textAlign: 'right', fontWeight: 700, color: plColor(f.weightedReturn) }}>{fmtPct(f.weightedReturn)}</td>
                      <td style={{ ...TD, textAlign: 'right', color: plColor(f.avgWin) }}>{fmtPct(f.avgWin)}</td>
                      <td style={{ ...TD, textAlign: 'right', color: plColor(f.avgLoss) }}>{fmtPct(f.avgLoss)}</td>
                      <td style={{ ...TD, textAlign: 'right', color: TEXT }}>{f.payoff == null ? '—' : f.payoff.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12, fontSize: '.7rem', color: SUB, lineHeight: 1.8 }}>
            <b>口徑：</b>每檔取自身最新持股，計算這些持股在 {data.startDate}～{data.endDate} 的收盤漲跌；<b>勝率</b>＝上漲檔數 ÷ 可評估檔數，<b>加權報酬</b>＝依持股權重(prate)加權。量的是「<u>現有持股的期間表現</u>」，非進場成本，期間內才買進者亦以全期間計（公平同區間比較）。報酬未還原息。<br />
            <b>資料來源：</b>全市場主動式 ETF 每日持股（CMoney）＋ TWSE／TPEx 收盤，存於共用 Supabase。<span style={{ color: GOLD }}>橘線＝復華未來50（本站主角）</span>。
          </div>
        </div>
      )}
    </div>
  );
}
