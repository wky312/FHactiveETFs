'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import { captureAndShare } from '@/lib/captureImage';
import { OVERSEAS_FUNDS } from '@/lib/overseasFunds';

/* ── tokens（沿用 OverseasAttributionTab 風格，紅漲/正貢獻、綠跌/負貢獻）── */
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#E8E3DF';
const CARD   = '#FFFFFF';
const UP     = '#C00000';
const DOWN   = '#1A6B45';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";
const PIN_TICKER = '00409A'; // 使用者主力觀測標的，卡片一律釘選在最前面
const DEFAULT_TICKERS = ['00409A', '00988A', '00411A', '00990A', '00998A']; // 使用者指定的預設觀測清單

interface UsImpactStock {
  stockid: string; name: string; weight: number; sret: number; contribution: number; ticker: string;
}
interface UsImpactFundResult {
  ticker: string; name: string; asOfHoldings: string; marketWeight: number; coverage: number;
  totalContribution: number; gainers: UsImpactStock[]; losers: UsImpactStock[]; warning?: string;
}
interface UsImpactResult {
  sessionDate: string; prevSessionDate: string; funds: UsImpactFundResult[];
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
const wpc = (x: number) => `${(x * 100).toFixed(1)}%`;
const col = (v: number) => (v >= 0 ? UP : DOWN);

const toolBtn: React.CSSProperties = {
  padding: '7px 16px', background: CARD, color: SUB, border: `1px solid ${BORDER}`,
  borderRadius: 6, cursor: 'pointer', fontSize: '.8rem', fontWeight: 500, fontFamily: SANS,
};
const chipBtn = (active: boolean): React.CSSProperties => ({
  padding: '6px 14px', background: active ? UP : CARD, color: active ? '#fff' : SUB,
  border: `1px solid ${active ? UP : BORDER}`, borderRadius: 999, cursor: 'pointer',
  fontSize: '.8rem', fontWeight: 600, fontFamily: SANS,
});

/* 四欄迷你表：代號/名稱 權重 昨夜漲跌 對基金貢獻 ── titleColor 依正/負貢獻區分（紅=正貢獻、綠=負貢獻） */
const MINI_GRID = 'minmax(60px,1fr) 56px 64px 64px';
function MiniTable({ title, titleColor, list, emptyText }:
  { title: string; titleColor: string; list: UsImpactStock[]; emptyText: string }) {
  return (
    <div>
      <h4 style={{ margin: '0 0 6px', fontSize: '.78rem', color: titleColor, fontWeight: 700 }}>{title}</h4>
      <div style={{ display: 'grid', gridTemplateColumns: MINI_GRID, gap: 8,
        fontSize: '.68rem', color: SUB, fontWeight: 600, padding: '0 0 4px', borderBottom: `1px solid ${BORDER}` }}>
        <div>個股</div><div style={{ textAlign: 'right' }}>權重</div>
        <div style={{ textAlign: 'right' }}>昨夜漲跌</div><div style={{ textAlign: 'right' }}>對基金貢獻</div>
      </div>
      {list.length === 0 && <p style={{ color: '#B8B2AC', fontSize: '.8rem', margin: '4px 0 10px' }}>{emptyText}</p>}
      {list.map((s) => (
        <div key={s.stockid} style={{ display: 'grid', gridTemplateColumns: MINI_GRID,
          gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #F0ECE8', fontSize: '.8rem' }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: TEXT }}>
            {s.name || s.stockid}
            <span style={{ display: 'block', fontFamily: MONO, fontSize: '.66rem', color: '#A8A29E' }}>{s.stockid.split(/\s+/)[0]}</span>
          </div>
          <div style={{ fontFamily: MONO, textAlign: 'right', color: TEXT }}>{wpc(s.weight)}</div>
          <div style={{ fontFamily: MONO, textAlign: 'right', color: col(s.sret) }}>{pct(s.sret)}</div>
          <div style={{ fontFamily: MONO, textAlign: 'right', fontWeight: 700, color: col(s.contribution) }}>{pct(s.contribution)}</div>
        </div>
      ))}
    </div>
  );
}

function FundCard({ f, topN, pinned }: { f: UsImpactFundResult; topN: number; pinned: boolean }) {
  return (
    <div style={{ background: CARD, border: `1px solid ${pinned ? UP : BORDER}`, borderRadius: 10,
      padding: '16px 18px', boxShadow: '0 1px 6px rgba(0,0,0,.05)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
        <h3 style={{ margin: 0, fontSize: '.95rem', color: TEXT, fontWeight: 700 }}>
          {pinned && <span style={{ color: UP }}>★ </span>}
          {f.ticker} <span style={{ fontWeight: 500, color: SUB }}>{f.name}</span>
        </h3>
      </div>
      <div style={{ fontFamily: MONO, fontSize: '1.7rem', fontWeight: 700, color: col(f.totalContribution), margin: '6px 0 2px' }}>
        {pct(f.totalContribution)}
      </div>
      <p style={{ margin: '0 0 12px', fontSize: '.74rem', color: SUB, lineHeight: 1.6 }}>
        美股部位估計影響（僅涵蓋美股持股，非全基金報酬）<br />
        美股持股占淨值 <b>{wpc(f.marketWeight)}</b>（已涵蓋報價 {wpc(f.coverage)}）｜持股資料日 {f.asOfHoldings || '—'}
      </p>
      {f.warning && (
        <div style={{ background: '#FFF8E6', border: '1px solid #F2D98A', borderRadius: 6,
          padding: '8px 10px', color: '#8A6A1A', fontSize: '.74rem', marginBottom: 12, lineHeight: 1.5 }}>
          ⚠ {f.warning}
        </div>
      )}
      <div style={{ display: 'grid', gap: 14 }}>
        <MiniTable title={`▲ 正貢獻前 ${topN} 大`} titleColor={UP} list={f.gainers.slice(0, topN)} emptyText="無正貢獻個股" />
        <MiniTable title={`▼ 負貢獻前 ${topN} 大`} titleColor={DOWN} list={f.losers.slice(0, topN)} emptyText="無負貢獻個股" />
      </div>
    </div>
  );
}

export default function UsMarketImpactTab() {
  const sp0 = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const allTickers = OVERSEAS_FUNDS.map((f) => f.ticker);
  const initFunds = sp0?.get('funds')?.split(',').filter((t) => allTickers.includes(t));
  const [selected, setSelected] = useState<string[]>(initFunds?.length ? initFunds : DEFAULT_TICKERS);
  const [topN, setTopN] = useState<number>(sp0?.get('topn') === '10' ? 10 : 5);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [res, setRes] = useState<UsImpactResult | null>(null);
  const [copied, setCopied] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);
  const autoRan = useRef(false);

  const run = useCallback(async () => {
    if (!selected.length) { setErr('請至少勾選一檔 ETF。'); return; }
    setLoading(true); setErr(''); setRes(null);
    const sp = new URLSearchParams(window.location.search);
    sp.set('funds', selected.join(',')); sp.set('topn', String(topN));
    window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`);
    try {
      const r = await fetch(`/api/us-impact?tickers=${selected.join(',')}`, { cache: 'no-store' });
      const json = await r.json();
      if (json.error) { setErr(json.error); return; }
      setRes(json as UsImpactResult);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '查詢失敗');
    } finally { setLoading(false); }
  }, [selected, topN]);

  // 進站自動跑一次（含分享連結帶入的勾選/topN）
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleFund = (t: string) => {
    setSelected((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  };

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true); setTimeout(() => setCopied(false), 1800);
    } catch { /* 剪貼簿不可用時略過 */ }
  }, []);

  const exportXlsx = useCallback(() => {
    if (!res) return;
    const r2 = (x: number) => Number((x * 100).toFixed(2));
    const aoa: (string | number)[][] = [
      [`美股收盤影響（美股交易日 ${res.sessionDate} ← ${res.prevSessionDate}）`],
      [],
    ];
    for (const f of res.funds) {
      aoa.push(
        [`${f.ticker} ${f.name}`, '美股部位估計影響(%)', r2(f.totalContribution), '美股持股占淨值(%)', r2(f.marketWeight), '持股資料日', f.asOfHoldings],
        ['代號', '名稱', '權重(%)', '昨夜漲跌(%)', '對基金貢獻(%)'],
        ...f.gainers.slice(0, topN).map((s) => [s.stockid, s.name, r2(s.weight), r2(s.sret), r2(s.contribution)]),
        ...f.losers.slice(0, topN).map((s) => [s.stockid, s.name, r2(s.weight), r2(s.sret), r2(s.contribution)]),
        [],
      );
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 12 } ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '美股收盤影響');
    XLSX.writeFile(wb, `美股收盤影響_${res.sessionDate}.xlsx`);
  }, [res, topN]);

  const shareImage = useCallback(async () => {
    if (!resultRef.current || !res) return;
    await captureAndShare(resultRef.current, `美股收盤影響_${res.sessionDate}.jpg`, '復華主動式ETF 美股收盤影響');
  }, [res]);

  const orderedFunds = res
    ? [...res.funds].sort((a, b) => (a.ticker === PIN_TICKER ? -1 : b.ticker === PIN_TICKER ? 1 : 0))
    : [];

  return (
    <div style={{ fontFamily: SANS }}>
      <p style={{ fontSize: '.82rem', color: SUB, marginTop: 0, marginBottom: 16, lineHeight: 1.7 }}>
        看最近一個美股交易日的收盤漲跌，對各主動式ETF「美股上市持股部位」的估計影響——只計入持股中
        Bloomberg 後綴判定為美股上市的個股（排除同基金持有的台股、日股、陸股等其他國家部位），
        報酬已換算新台幣（含隔夜美元/台幣匯率變動）。資料：CMoney／復華每日持股 + Yahoo Finance 收盤與匯率。
      </p>

      {/* 控制列 */}
      <div style={{ background: '#FAF8F5', border: `1px solid ${BORDER}`, borderRadius: 10, padding: 16, marginBottom: 18 }}>
        <div style={{ fontSize: '.74rem', color: SUB, fontWeight: 500, marginBottom: 8 }}>觀測ETF（可複選，★ 為主力觀測標的）</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
          {OVERSEAS_FUNDS.map((f) => (
            <label key={f.ticker} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
              background: selected.includes(f.ticker) ? '#FFF0EE' : CARD,
              border: `1px solid ${selected.includes(f.ticker) ? UP : BORDER}`,
              borderRadius: 999, fontSize: '.8rem', color: TEXT, cursor: 'pointer',
            }}>
              <input type="checkbox" checked={selected.includes(f.ticker)} onChange={() => toggleFund(f.ticker)} />
              {f.ticker === PIN_TICKER && <span style={{ color: UP }}>★</span>}
              {f.ticker} {f.name}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '.74rem', color: SUB, fontWeight: 500 }}>每檔顯示前</span>
            <button type="button" onClick={() => setTopN(5)} style={chipBtn(topN === 5)}>5 大</button>
            <button type="button" onClick={() => setTopN(10)} style={chipBtn(topN === 10)}>10 大</button>
          </div>
          <button onClick={run} disabled={loading} style={{
            padding: '9px 24px', background: loading ? '#999' : UP, color: '#fff', border: 'none',
            borderRadius: 6, cursor: loading ? 'wait' : 'pointer', fontSize: '.88rem', fontWeight: 600, fontFamily: SANS,
          }}>{loading ? '計算中…' : '重新整理'}</button>
          {loading && (
            <span style={{ fontSize: '.8rem', color: SUB }}>多檔基金 × 美股報價/匯率，首次查詢可能數十秒…</span>
          )}
        </div>
      </div>

      {err && (
        <div style={{ background: '#FFF5F5', border: '1px solid #FFCDD2', borderRadius: 6,
          padding: '10px 14px', color: UP, fontSize: '.86rem', marginBottom: 16 }}>⚠ {err}</div>
      )}

      {res && res.funds.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginBottom: 12, flexWrap: 'wrap' }}>
            <button onClick={copyLink} style={toolBtn}>{copied ? '✓ 連結已複製' : '複製分享連結'}</button>
            <button onClick={exportXlsx} style={toolBtn}>儲存成表格（Excel）</button>
            <button onClick={shareImage} style={toolBtn}>分享 / 儲存圖片</button>
          </div>

          <div ref={resultRef} style={{ background: '#FFFFFF', padding: 2 }}>
            <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10,
              padding: '12px 18px', marginBottom: 18, fontSize: '.86rem', color: TEXT }}>
              美股交易日 <b style={{ fontFamily: MONO }}>{res.sessionDate || '—'}</b>
              （對前一交易日 <span style={{ fontFamily: MONO }}>{res.prevSessionDate || '—'}</span>）
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: 18 }}>
              {orderedFunds.map((f) => (
                <FundCard key={f.ticker} f={f} topN={topN} pinned={f.ticker === PIN_TICKER} />
              ))}
            </div>

            <p style={{ fontSize: '.72rem', color: '#B8B2AC', margin: '18px 0 0', lineHeight: 1.75 }}>
              「美股部位估計影響」只涵蓋該基金持股中判定為美股上市的部位，<b>不是全基金報酬</b>
              （基金仍有台股、其他海外市場、現金等部位未反映在此數字中）。持股資料多有 1 個交易日左右的公布時差，
              以持股快照當日「最後已知」的美股部位權重估算，此為概略估計，非精算。
            </p>
          </div>
        </>
      )}

      {!res && !err && !loading && (
        <p style={{ color: '#AAA', textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>載入中…</p>
      )}
    </div>
  );
}
