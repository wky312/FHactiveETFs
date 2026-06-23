'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import { captureAndShare } from '@/lib/captureImage';

/* ── tokens（沿用 Dashboard 風格）── */
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#E8E3DF';
const CARD   = '#FFFFFF';
const UP     = '#C00000';   // 台股慣例：紅＝漲／正貢獻
const DOWN   = '#1A6B45';   // 綠＝跌／負貢獻
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

interface FundOption { ticker: string; name: string; }
interface StockAttr {
  stockid: string; name: string; gap: number; ca: number; cb: number;
  avgA: number; avgB: number; sret: number;
}
interface AttrResult {
  fundA: string; fundB: string; start: string; end: string; days: number; totalReturn: boolean;
  retA_geo: number; retB_geo: number; gap_geo: number; check: number; stocks: StockAttr[];
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
const wpc = (x: number) => `${(x * 100).toFixed(1)}%`;
const col = (v: number) => (v >= 0 ? UP : DOWN);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label style={{ fontSize: '.74rem', color: SUB, fontWeight: 500 }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '8px 11px', border: `1px solid ${BORDER}`, borderRadius: 6,
  fontSize: '.87rem', color: TEXT, background: CARD, fontFamily: MONO, minWidth: 150,
};

const toolBtn: React.CSSProperties = {
  padding: '7px 16px', background: CARD, color: SUB, border: `1px solid ${BORDER}`,
  borderRadius: 6, cursor: 'pointer', fontSize: '.8rem', fontWeight: 500, fontFamily: SANS,
};

/* 六欄表格：代號 名稱 貢獻 A權重 B權重 區間報酬 */
const GRID = '64px minmax(72px,1fr) 92px 88px 88px 96px';

function HeadRow({ clbl, fa, fb }: { clbl: string; fa: string; fb: string }) {
  const c: React.CSSProperties = { fontSize: '.72rem', color: SUB, fontWeight: 600 };
  const r: React.CSSProperties = { ...c, textAlign: 'right' };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 12, alignItems: 'center',
      padding: '0 0 8px', borderBottom: `1px solid ${BORDER}` }}>
      <div style={c}>代號</div><div style={c}>名稱</div><div style={r}>{clbl}</div>
      <div style={r}>{fa} 權重</div><div style={r}>{fb} 權重</div><div style={r}>區間報酬</div>
    </div>
  );
}

function TableCard({ title, list, valOf, clbl, fa, fb }:
  { title: string; list: StockAttr[]; valOf: (s: StockAttr) => number; clbl: string; fa: string; fb: string }) {
  return (
    <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '16px 18px',
      boxShadow: '0 1px 6px rgba(0,0,0,.05)' }}>
      <h3 style={{ margin: '0 0 12px', fontSize: '.95rem', color: TEXT, fontWeight: 700 }}>{title}</h3>
      {/* 手機放不下 6 欄 → 包一層橫向捲動（存圖時 captureImage 會自動攤平成全寬） */}
      <div style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: 480 }}>
          <HeadRow clbl={clbl} fa={fa} fb={fb} />
          {list.length === 0 && <p style={{ color: '#AAA', padding: '14px 0', fontSize: '.85rem' }}>無</p>}
          {list.map(s => {
            const v = valOf(s);
            return (
              <div key={s.stockid} style={{ display: 'grid', gridTemplateColumns: GRID, gap: 12,
                alignItems: 'center', padding: '9px 0', borderBottom: '1px solid #F0ECE8', fontSize: '.85rem' }}>
                <div style={{ fontFamily: MONO, color: SUB }}>{s.stockid}</div>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: TEXT }}>{s.name}</div>
                <div style={{ fontFamily: MONO, textAlign: 'right', fontWeight: 700, color: col(v) }}>{pct(v)}</div>
                <div style={{ fontFamily: MONO, textAlign: 'right', color: TEXT }}>{wpc(s.avgA)}</div>
                <div style={{ fontFamily: MONO, textAlign: 'right', color: TEXT }}>{wpc(s.avgB)}</div>
                <div style={{ fontFamily: MONO, textAlign: 'right', color: col(s.sret) }}>{pct(s.sret)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function AttributionTab() {
  const [funds, setFunds] = useState<FundOption[]>([]);
  const [a, setA] = useState('00981A');
  const [b, setB] = useState('00991A');
  const [start, setStart] = useState('2026-03-31');
  const [end, setEnd] = useState('');
  const [total, setTotal] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [res, setRes] = useState<AttrResult | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/attribution?funds=1')
      .then(r => r.json())
      .then((f: FundOption[]) => {
        if (Array.isArray(f)) {
          setFunds(f);
          if (!f.find(x => x.ticker === a)) setA(f[0]?.ticker ?? a);
          if (!f.find(x => x.ticker === b)) setB(f[1]?.ticker ?? b);
        }
      })
      .catch(() => { /* 下拉載入失敗時仍可手動輸入既有預設 */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(async () => {
    setLoading(true); setErr(''); setRes(null);
    try {
      const q = new URLSearchParams({ a, b, start, end, total: total ? '1' : '0' });
      const r = await fetch(`/api/attribution?${q}`, { cache: 'no-store' });
      const json = await r.json();
      if (json.error) { setErr(json.error); return; }
      setRes(json as AttrResult);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '查詢失敗');
    } finally { setLoading(false); }
  }, [a, b, start, end, total]);

  /* 儲存成表格（Excel）：摘要 + 全個股歸因明細 */
  const exportXlsx = useCallback(() => {
    if (!res) return;
    const r4 = (x: number) => Number((x * 100).toFixed(4));
    const r2 = (x: number) => Number((x * 100).toFixed(2));
    const aoa: (string | number)[][] = [
      [`${res.fundA} vs ${res.fundB} 績效個股歸因（${res.totalReturn ? '含息' : '純價差'}）`],
      ['期間', `${res.start} → ${res.end}`, `${res.days} 交易日`],
      [`${res.fundA} 區間報酬(%)`, r2(res.retA_geo), `${res.fundB} 區間報酬(%)`, r2(res.retB_geo), '差距(%)', r2(res.gap_geo)],
      [],
      ['代號', '名稱', `差距貢獻 ${res.fundA}−${res.fundB}(%)`, `貢獻${res.fundA}(%)`, `貢獻${res.fundB}(%)`,
        `${res.fundA}權重(%)`, `${res.fundB}權重(%)`, '區間報酬(%)'],
      ...[...res.stocks].sort((x, y) => y.gap - x.gap).map(s =>
        [s.stockid, s.name, r4(s.gap), r4(s.ca), r4(s.cb), r2(s.avgA), r2(s.avgB), r2(s.sret)]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 8 }, { wch: 12 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '個股歸因');
    XLSX.writeFile(wb, `績效個股歸因_${res.fundA}-${res.fundB}_${res.start}_${res.end}.xlsx`);
  }, [res]);

  /* 分享 / 儲存圖片：共用截圖工具（截圖前攤平寬表格，避免被切欄位） */
  const shareImage = useCallback(async () => {
    if (!resultRef.current || !res) return;
    await captureAndShare(
      resultRef.current,
      `績效個股歸因_${res.fundA}-${res.fundB}_${res.start}_${res.end}.jpg`,
      '復華主動式ETF 績效個股歸因',
    );
  }, [res]);

  const opts = funds.length
    ? funds.map(f => <option key={f.ticker} value={f.ticker}>{f.ticker} {f.name}</option>)
    : <option value={a}>{a}</option>;

  // 全部以「基金 A」為分析對象（他）。差距：領先=gap>0、落後=gap<0；貢獻：最多/最差=ca 高/低。各取 10。
  const lead    = res ? res.stocks.filter(s => s.gap > 0).sort((x, y) => y.gap - x.gap).slice(0, 10) : [];
  const lag     = res ? res.stocks.filter(s => s.gap < 0).sort((x, y) => x.gap - y.gap).slice(0, 10) : [];
  const bestA   = res ? [...res.stocks].sort((x, y) => y.ca - x.ca).slice(0, 10) : [];
  const worstA  = res ? [...res.stocks].sort((x, y) => x.ca - y.ca).slice(0, 10) : [];

  return (
    <div style={{ fontFamily: SANS }}>
      <p style={{ fontSize: '.82rem', color: SUB, marginTop: 0, marginBottom: 16, lineHeight: 1.7 }}>
        挑兩檔台股主動式 ETF，看一段期間的報酬差距「來自哪些個股」。
        資料：CMoney 持股 + TWSE/TPEx 均價 + FinMind 股息（來源：active-etf-tracker 資料庫，共 19 檔台股主動式股票 ETF）。
      </p>

      {/* 控制列 */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end',
        background: '#FAF8F5', border: `1px solid ${BORDER}`, borderRadius: 10, padding: 16, marginBottom: 18 }}>
        <Field label="基金 A">
          <select value={a} onChange={e => setA(e.target.value)} style={{ ...inputStyle, fontFamily: SANS }}>{opts}</select>
        </Field>
        <Field label="基金 B">
          <select value={b} onChange={e => setB(e.target.value)} style={{ ...inputStyle, fontFamily: SANS }}>{opts}</select>
        </Field>
        <Field label="起始日"><input type="date" value={start} onChange={e => setStart(e.target.value)} style={inputStyle} /></Field>
        <Field label="結束日（留空＝最新）"><input type="date" value={end} onChange={e => setEnd(e.target.value)} style={inputStyle} /></Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: '.83rem', color: TEXT, paddingBottom: 8 }}>
          <input type="checkbox" checked={total} onChange={e => setTotal(e.target.checked)} />含息（還原現金股利）
        </label>
        <button onClick={run} disabled={loading} style={{
          padding: '9px 24px', background: loading ? '#999' : UP, color: '#fff', border: 'none',
          borderRadius: 6, cursor: loading ? 'wait' : 'pointer', fontSize: '.88rem', fontWeight: 600,
          fontFamily: SANS, marginBottom: 1,
        }}>{loading ? '計算中…' : '比較'}</button>
      </div>

      {err && (
        <div style={{ background: '#FFF5F5', border: '1px solid #FFCDD2', borderRadius: 6,
          padding: '10px 14px', color: UP, fontSize: '.86rem', marginBottom: 16 }}>⚠ {err}</div>
      )}

      {res && (
        <>
          {/* 工具列：儲存表格 / 分享圖片 */}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginBottom: 12, flexWrap: 'wrap' }}>
            <button onClick={exportXlsx} style={toolBtn}>儲存成表格（Excel）</button>
            <button onClick={shareImage} style={toolBtn}>分享 / 儲存圖片</button>
          </div>

          <div ref={resultRef} style={{ background: '#FFFFFF', padding: 2 }}>
          {/* 摘要 */}
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10,
            padding: '14px 18px', marginBottom: 18, fontSize: '.88rem', lineHeight: 1.9, color: TEXT }}>
            期間 <b style={{ fontFamily: MONO }}>{res.start} → {res.end}</b>（{res.days} 個交易日，{res.totalReturn ? '含息' : '純價差'}）<br />
            {res.fundA} 區間報酬 <b style={{ fontFamily: MONO, color: col(res.retA_geo) }}>{pct(res.retA_geo)}</b>　|
            {res.fundB} 區間報酬 <b style={{ fontFamily: MONO, color: col(res.retB_geo) }}>{pct(res.retB_geo)}</b>　|
            差距 {res.fundA}−{res.fundB} <b style={{ fontFamily: MONO, color: col(res.gap_geo) }}>{pct(res.gap_geo)}</b>
          </div>

          {/* ① 差距歸因（以基金 A 為對象，相對 B） */}
          <h2 style={{ fontSize: '1rem', color: TEXT, margin: '20px 0 2px' }}>① {res.fundA} 相對 {res.fundB} 的差距：誰拉開、誰拖累</h2>
          <p style={{ fontSize: '.8rem', color: SUB, margin: '0 0 12px', lineHeight: 1.6 }}>
            差距貢獻 =（{res.fundA}權重 − {res.fundB}權重）× 個股報酬，逐日加總。正值＝讓 {res.fundA} 領先、負值＝讓 {res.fundA} 落後。
            「區間報酬」為該股 {res.start}→{res.end} 的漲跌幅。（想看 {res.fundB} 的視角，把 A、B 對調即可）
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 18, marginBottom: 8 }}>
            <TableCard title={`讓 ${res.fundA} 領先的個股（前 10）`} list={lead} valOf={s => s.gap} clbl="差距貢獻" fa={res.fundA} fb={res.fundB} />
            <TableCard title={`讓 ${res.fundA} 落後的個股（前 10）`} list={lag} valOf={s => s.gap} clbl="差距貢獻" fa={res.fundA} fb={res.fundB} />
          </div>

          {/* ② 基金 A 自身報酬貢獻：最多 / 最差 */}
          <h2 style={{ fontSize: '1rem', color: TEXT, margin: '24px 0 2px' }}>② {res.fundA} 個股報酬貢獻：最多 / 最差</h2>
          <p style={{ fontSize: '.8rem', color: SUB, margin: '0 0 12px', lineHeight: 1.6 }}>
            報酬貢獻 = {res.fundA} 權重 × 個股報酬，逐日加總（與另一檔無關）。正值＝替 {res.fundA} 賺、負值＝拖累。
            「區間報酬」為該股 {res.start}→{res.end} 的漲跌幅。
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 18 }}>
            <TableCard title={`${res.fundA} 報酬貢獻最多的個股（前 10）`} list={bestA} valOf={s => s.ca} clbl="報酬貢獻" fa={res.fundA} fb={res.fundB} />
            <TableCard title={`${res.fundA} 報酬貢獻最差的個股（前 10）`} list={worstA} valOf={s => s.ca} clbl="報酬貢獻" fa={res.fundA} fb={res.fundB} />
          </div>
          </div>
        </>
      )}

      {!res && !err && !loading && (
        <p style={{ color: '#AAA', textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>
          選兩檔基金與日期區間，點「比較」
        </p>
      )}
    </div>
  );
}
