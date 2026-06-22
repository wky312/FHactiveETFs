'use client';
import { useState, useCallback, useRef } from 'react';
import MarketOverviewTab from './MarketOverviewTab';

/* 經理人選股對帳單分頁
   台股配色慣例：紅(RED)=上漲/賺、綠(GREEN)=下跌/賠。
   兩種口徑：現有持股(未實現) ↔ 含已出清(已實現＋未實現，還原真實選股勝率)。 */

const RED    = '#C00000';
const GREEN  = '#16a34a';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

interface PositionPnl {
  stockid: string;
  stockname: string;
  held: boolean;
  lots: number;
  prate: number;
  mvalue: number;
  grossInvested: number;
  avgCost: number | null;
  currentPrice: number | null;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  returnUnreal: number | null;
  returnAll: number | null;
  contribution: number | null;
}
interface ScorecardAgg {
  scope: 'current' | 'all';
  n: number; nEval: number; nWin: number; nLoss: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  payoff: number | null;
  meanReturn: number | null;
  weightedReturn: number | null;
  totalPnl: number;
}
interface Scorecard {
  fundId: string;
  asOf: string;
  positions: PositionPnl[];
  current: ScorecardAgg;
  all: ScorecardAgg;
}

const TH: React.CSSProperties = {
  padding: '8px 12px', fontWeight: 600, fontSize: '.74rem',
  background: TEXT, color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1,
};
const TD: React.CSSProperties = { padding: '7px 12px', fontFamily: MONO, fontSize: '.8rem' };

function fmtPrice(n: number | null): string {
  return n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n: number | null, d = 1): string {
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`;
}
function fmtMoney(n: number): string {
  const s = n < 0 ? '-' : '+';
  const a = Math.abs(n);
  if (a >= 1e8) return `${s}${(a / 1e8).toFixed(2)} 億`;
  if (a >= 1e4) return `${s}${(a / 1e4).toFixed(0)} 萬`;
  return `${s}${a.toFixed(0)}`;
}
// 漲跌色（台股：紅漲綠跌）
function plColor(n: number | null): string {
  if (n == null) return SUB;
  return n > 0 ? RED : n < 0 ? GREEN : SUB;
}

interface Props {
  selectedEtf: { fundId: string; ticker: string; name: string };
}

export default function ScorecardTab({ selectedEtf }: Props) {
  const [data,    setData]    = useState<Scorecard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [scope,   setScope]   = useState<'current' | 'all'>('current');
  // 沿用全域所選復華 ETF，或改查統一 00981A（資料源 = CMoney／口袋證券）
  const [fundOverride, setFundOverride] = useState<'' | '00981A'>('');
  const fund = fundOverride === '00981A'
    ? { fundId: '00981A', ticker: '00981A', name: '主動統一台股增長' }
    : selectedEtf;

  const cardRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<'single' | 'market'>('single');

  const run = useCallback(async () => {
    setLoading(true); setError(''); setData(null);
    try {
      const res  = await fetch(`/api/scorecard?fundId=${encodeURIComponent(fund.fundId)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json as Scorecard);
    } catch (e) {
      setError(e instanceof Error ? e.message : '查詢失敗');
    } finally {
      setLoading(false);
    }
  }, [fund.fundId]);

  // 截圖分享（手機走 Web Share 直接傳 LINE；否則下載 JPG），比照 Dashboard.saveImage
  const saveImage = useCallback(async () => {
    const el = cardRef.current;
    if (!el) return;
    try {
      await document.fonts.ready;
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
      const name = `${fund.ticker}_選股對帳單_${data?.asOf?.replace(/\//g, '') ?? ''}.jpg`;
      if (typeof navigator !== 'undefined' && navigator.canShare) {
        try {
          const blob = await new Promise<Blob>((r) => canvas.toBlob(b => r(b!), 'image/jpeg', 0.92));
          const file = new File([blob], name, { type: 'image/jpeg' });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ title: `${fund.ticker} 選股對帳單`, files: [file] });
            return;
          }
        } catch { /* 取消或不支援 → 下載 */ }
      }
      const link = document.createElement('a');
      link.download = name;
      link.href = canvas.toDataURL('image/jpeg', 0.92);
      link.click();
    } catch (e) { console.error('截圖失敗', e); }
  }, [fund.ticker, data]);

  const agg = data ? (scope === 'current' ? data.current : data.all) : null;
  // 表格列：現有持股口徑只列目前持有、依貢獻排序；含已出清口徑列全部、依累計損益排序
  const rows = data
    ? (scope === 'current'
        ? data.positions.filter(p => p.held).slice().sort((a, b) => (b.contribution ?? -Infinity) - (a.contribution ?? -Infinity))
        : data.positions)
    : [];

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>

      {/* 模式切換：單檔對帳單 ↔ 全 19 檔總覽 */}
      <div style={{ display: 'inline-flex', border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
        {([['single', '單檔對帳單'], ['market', '全 19 檔總覽']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setMode(k)}
            style={{
              padding: '8px 18px', border: 'none', cursor: 'pointer', fontFamily: SANS,
              fontSize: '.85rem', fontWeight: mode === k ? 700 : 500,
              background: mode === k ? TEXT : '#fff', color: mode === k ? '#fff' : SUB,
            }}>
            {label}
          </button>
        ))}
      </div>

      {mode === 'market' ? <MarketOverviewTab /> : (
      <>

      {/* 控制列 */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 8, flexWrap: 'wrap' }}>
        <div>
          <label style={{ display: 'block', fontSize: '.78rem', color: SUB, marginBottom: 4, fontWeight: 500 }}>ETF</label>
          <select
            value={fundOverride}
            onChange={e => { setFundOverride(e.target.value as '' | '00981A'); setData(null); setError(''); }}
            style={{ padding: '7px 12px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.87rem', color: TEXT, background: '#fff', fontFamily: SANS }}>
            <option value="">{selectedEtf.ticker}（復華）</option>
            <option value="00981A">00981A 統一台股增長</option>
          </select>
        </div>
        <button onClick={run} disabled={loading}
          style={{ padding: '8px 22px', background: loading ? '#999' : RED, color: '#fff', border: 'none', borderRadius: 6,
            cursor: loading ? 'not-allowed' : 'pointer', fontSize: '.88rem', fontWeight: 600, fontFamily: SANS }}>
          {loading ? '結算中…' : '產生對帳單'}
        </button>
        {data && !loading && (
          <button onClick={saveImage}
            style={{ padding: '8px 16px', background: '#fff', color: SUB, border: `1px solid ${BORDER}`, borderRadius: 6,
              cursor: 'pointer', fontSize: '.82rem', fontWeight: 500, fontFamily: SANS }}>
            儲存 / 分享圖
          </button>
        )}
        {loading && (
          <span style={{ fontSize: '.8rem', color: SUB, alignSelf: 'center' }}>
            逐檔結算 {fund.ticker} 持股成本，約需 30–60 秒…
          </span>
        )}
      </div>
      <p style={{ fontSize: '.74rem', color: SUB, margin: '0 0 16px' }}>
        把經理人持有過的每一檔股票的預估持倉成本與現價對帳，算出這份名單的「選股勝率」與賺賠結構。
      </p>

      {error && (
        <div style={{ padding: '14px 16px', background: '#fff0f0', border: '1px solid #fca5a5', borderRadius: 8, color: RED, fontSize: '.85rem', marginBottom: 16 }}>
          {error}
        </div>
      )}

      {!data && !loading && !error && (
        <p style={{ color: '#AAA', textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>
          點擊「產生對帳單」開始結算
        </p>
      )}

      {data && data.positions.length === 0 && !loading && (
        <div style={{ padding: '24px', textAlign: 'center', color: SUB, fontSize: '.88rem' }}>
          查無 {fund.ticker} 的持股資料。
        </div>
      )}

      {data && agg && data.positions.length > 0 && (
        <>
          {/* 口徑切換 */}
          <div style={{ display: 'inline-flex', border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
            {([['current', '現有持股（未實現）'], ['all', '計入已出清（真實勝率）']] as const).map(([k, label]) => (
              <button key={k} onClick={() => setScope(k)}
                style={{
                  padding: '7px 16px', border: 'none', cursor: 'pointer', fontFamily: SANS,
                  fontSize: '.82rem', fontWeight: scope === k ? 700 : 500,
                  background: scope === k ? RED : '#fff', color: scope === k ? '#fff' : SUB,
                }}>
                {label}
              </button>
            ))}
          </div>

          <div ref={cardRef} style={{ background: '#fff', padding: '4px 2px' }}>

            {/* 標題（截圖用） */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
              <div>
                <span style={{ fontFamily: MONO, fontSize: '1.05rem', fontWeight: 700, color: RED }}>{fund.ticker}</span>
                <span style={{ fontWeight: 700, marginLeft: 8 }}>
                  {fund.name} · 選股對帳單
                  <span style={{ fontSize: '.78rem', color: SUB, fontWeight: 500, marginLeft: 8 }}>
                    {scope === 'current' ? '現有持股' : '含已出清'}
                  </span>
                </span>
              </div>
              <span style={{ fontSize: '.76rem', color: SUB, fontFamily: MONO }}>結算日 {data.asOf}</span>
            </div>

            {/* 統計卡 */}
            {(() => {
              const wr = agg.winRate;
              const cards = [
                { label: '選股勝率', value: wr == null ? '—' : `${wr.toFixed(0)}%`,
                  sub: `${agg.nWin} 賺 / ${agg.nLoss} 賠（共 ${agg.nEval} 檔）`,
                  color: wr == null ? SUB : wr >= 50 ? RED : GREEN },
                scope === 'current'
                  ? { label: '加權平均報酬', value: fmtPct(agg.weightedReturn), sub: '依現有持股權重加權', color: plColor(agg.weightedReturn) }
                  : { label: '整體資金加權報酬', value: fmtPct(agg.weightedReturn), sub: `累計損益 ${fmtMoney(agg.totalPnl)}`, color: plColor(agg.weightedReturn) },
                { label: '賺賠比', value: agg.payoff == null ? '—' : `${agg.payoff.toFixed(2)}`,
                  sub: '贏家平均 ÷ 輸家平均', color: TEXT },
                { label: '贏家平均 / 輸家平均', value: `${fmtPct(agg.avgWin)} / ${fmtPct(agg.avgLoss)}`,
                  sub: `${scope === 'current' ? '持股' : '曾持有'} ${agg.n} 檔`, color: TEXT },
              ];
              return (
                <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cards.length},1fr)`, border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden', marginBottom: 18, background: '#FAFAF9' }}>
                  {cards.map((c, i, arr) => (
                    <div key={c.label} style={{ padding: '14px 16px', borderRight: i < arr.length - 1 ? `1px solid ${BORDER}` : 'none' }}>
                      <div style={{ fontSize: '.72rem', color: SUB, fontWeight: 500, marginBottom: 4 }}>{c.label}</div>
                      <div style={{ fontSize: '1.3rem', fontWeight: 700, color: c.color, fontFamily: MONO, lineHeight: 1.2 }}>{c.value}</div>
                      <div style={{ fontSize: '.7rem', color: SUB, marginTop: 4 }}>{c.sub}</div>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* 持股對帳表 */}
            <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '56vh', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 680 }}>
                <thead>
                  <tr>
                    <th style={{ ...TH, textAlign: 'left' }}>#</th>
                    <th style={{ ...TH, textAlign: 'left' }}>代碼</th>
                    <th style={{ ...TH, textAlign: 'left' }}>名稱</th>
                    {scope === 'all'
                      ? <th style={{ ...TH, textAlign: 'center' }}>狀態</th>
                      : <th style={{ ...TH, textAlign: 'right' }}>權重 %</th>}
                    <th style={{ ...TH, textAlign: 'right' }}>估計成本</th>
                    <th style={{ ...TH, textAlign: 'right' }}>現價</th>
                    <th style={{ ...TH, textAlign: 'right' }}>報酬 %</th>
                    {scope === 'all'
                      ? <th style={{ ...TH, textAlign: 'right' }}>累計損益</th>
                      : <th style={{ ...TH, textAlign: 'right' }}>對淨值貢獻 %</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p, i) => {
                    const ret = scope === 'current' ? p.returnUnreal : p.returnAll;
                    return (
                      <tr key={p.stockid} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAF9', borderBottom: `1px solid ${BORDER}` }}>
                        <td style={{ ...TD, color: SUB }}>{i + 1}</td>
                        <td style={{ ...TD, color: TEXT, fontWeight: 600 }}>{p.stockid}</td>
                        <td style={{ ...TD, fontFamily: SANS, color: TEXT }}>{p.stockname}</td>
                        {scope === 'all'
                          ? <td style={{ ...TD, textAlign: 'center', fontFamily: SANS, fontSize: '.74rem', color: p.held ? RED : SUB }}>{p.held ? '持有' : '已出清'}</td>
                          : <td style={{ ...TD, textAlign: 'right', color: SUB }}>{p.prate.toFixed(2)}</td>}
                        <td style={{ ...TD, textAlign: 'right', color: TEXT }}>{fmtPrice(p.avgCost)}</td>
                        <td style={{ ...TD, textAlign: 'right', color: TEXT }}>{fmtPrice(p.currentPrice)}</td>
                        <td style={{ ...TD, textAlign: 'right', fontWeight: 700, color: plColor(ret) }}>{fmtPct(ret)}</td>
                        {scope === 'all'
                          ? <td style={{ ...TD, textAlign: 'right', fontWeight: 600, color: plColor(p.totalPnl) }}>{p.grossInvested > 0 ? fmtMoney(p.totalPnl) : '—'}</td>
                          : <td style={{ ...TD, textAlign: 'right', fontWeight: 600, color: plColor(p.contribution) }}>{fmtPct(p.contribution, 2)}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 12, fontSize: '.7rem', color: SUB, lineHeight: 1.8 }}>
              {scope === 'current' ? (
                <><b>口徑：現有持股（未實現）。</b>勝率＝現價高於估計成本的檔數 ÷ 可評估檔數；對淨值貢獻＝權重 × 報酬。<u>已出清個股不納入</u>，僅反映目前持倉。<br /></>
              ) : (
                <><b>口徑：計入已出清（已實現＋未實現）。</b>把所有曾持有的股票都算進來，還原真實選股勝率——賠錢停損出清的也會被計入，避免存活者偏誤。報酬＝累計損益 ÷ 累計投入成本。<br /></>
              )}
              <b>估計成本</b>＝移動平均成本法之推估；基準價＝台股當日真實成交均價、海外股取中間價（高+低)/2。報酬以原始收盤計（<u>未還原息</u>，對除息個股略低估）。成本與報酬皆為推估，非實際成交。<br />
              <b>資料來源：</b>{fund.fundId === '00981A' ? 'CMoney／口袋證券逐日持股' : '復華投信 ETF 每日持股'} ＋ Yahoo Finance 日 K ＋ TWSE／TPEx 成交均價
            </div>
          </div>
        </>
      )}
      </>
      )}
    </div>
  );
}
