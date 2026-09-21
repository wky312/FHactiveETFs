'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import { captureAndShare } from '@/lib/captureImage';
import { OVERSEAS_FUNDS } from '@/lib/overseasFunds';
import { TW_ACTIVE_FUNDS } from '@/lib/twActiveFunds';

/* ── tokens（沿用台股／美股收盤影響分頁的卡片風格）── */
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#E8E3DF';
const CARD   = '#FFFFFF';
const UP     = '#C00000';
const GOLD   = '#B08F6E';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

type Market = 'tw' | 'os';
/* 預選清單與「台股收盤影響」「美股收盤影響」一致；第一檔為主力觀測標的，卡片釘選在最前面 */
const DEFAULTS: Record<Market, string[]> = {
  tw: ['00991A', '00981A', '00992A', '00403A'],
  os: ['00409A', '00988A', '00411A', '00990A', '00998A'],
};
const POOL = { tw: TW_ACTIVE_FUNDS, os: OVERSEAS_FUNDS };
const MARKET_LABEL: Record<Market, string> = { tw: '台股', os: '海外' };

interface TopHolding { rank: number; key: string; stockid: string; name: string; weight: number }
interface HoldingRank { name: string; weight: number; rank: number }
interface TopFund {
  ticker: string; name: string; asOfHoldings: string; top: TopHolding[]; topWeight: number;
  all?: Record<string, HoldingRank>; warning?: string;
}

const wpc = (x: number) => `${(x * 100).toFixed(2)}%`;
const wpc1 = (x: number) => `${(x * 100).toFixed(1)}%`;

const toolBtn: React.CSSProperties = {
  padding: '7px 16px', background: CARD, color: SUB, border: `1px solid ${BORDER}`,
  borderRadius: 6, cursor: 'pointer', fontSize: '.8rem', fontWeight: 500, fontFamily: SANS,
};
const chipBtn = (active: boolean): React.CSSProperties => ({
  padding: '6px 18px', background: active ? UP : CARD, color: active ? '#fff' : SUB,
  border: `1px solid ${active ? UP : BORDER}`, borderRadius: 999, cursor: 'pointer',
  fontSize: '.84rem', fontWeight: 600, fontFamily: SANS,
});

const GRID = '24px minmax(60px,1fr) 64px';
const HILITE = '#FFE9A8';   // 被指到（或鎖定）的個股，在所有卡片同步亮起的底色
const HILITE_EDGE = '#E0A100';

function FundCard({ f, pinned, active, onHover, onPick }: {
  f: TopFund; pinned: boolean; active: string | null;
  onHover: (key: string | null) => void; onPick: (key: string) => void;
}) {
  const maxW = f.top[0]?.weight || 1;
  return (
    <div style={{ background: CARD, border: `1px solid ${pinned ? UP : BORDER}`, borderRadius: 10,
      padding: '16px 18px', boxShadow: '0 1px 6px rgba(0,0,0,.05)' }}>
      <h3 style={{ margin: 0, fontSize: '.95rem', color: TEXT, fontWeight: 700 }}>
        {pinned && <span style={{ color: UP }}>★ </span>}
        {f.ticker} <span style={{ fontWeight: 500, color: SUB }}>{f.name}</span>
      </h3>
      <div style={{ fontFamily: MONO, fontSize: '1.7rem', fontWeight: 700, color: TEXT, margin: '6px 0 2px' }}>
        {f.top.length ? wpc1(f.topWeight) : '—'}
      </div>
      <p style={{ margin: '0 0 12px', fontSize: '.74rem', color: SUB, lineHeight: 1.6 }}>
        前十大持股合計占淨值｜持股資料日 {f.asOfHoldings || '—'}
      </p>
      {f.warning && (
        <div style={{ background: '#FFF8E6', border: '1px solid #F2D98A', borderRadius: 6,
          padding: '8px 10px', color: '#8A6A1A', fontSize: '.74rem', marginBottom: 12, lineHeight: 1.5 }}>
          ⚠ {f.warning}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8,
        fontSize: '.68rem', color: SUB, fontWeight: 600, padding: '0 0 4px', borderBottom: `1px solid ${BORDER}` }}>
        <div>#</div><div>個股</div><div style={{ textAlign: 'right' }}>權重</div>
      </div>
      {f.top.map((s) => {
        const on = active === s.key;
        return (
        <div key={s.stockid} onMouseEnter={() => onHover(s.key)} onMouseLeave={() => onHover(null)}
          onClick={() => onPick(s.key)}
          style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8, alignItems: 'center', cursor: 'pointer',
          padding: '6px 4px', margin: '0 -4px', borderBottom: '1px solid #F0ECE8', fontSize: '.8rem',
          boxShadow: on ? `inset 3px 0 0 ${HILITE_EDGE}` : undefined,
          opacity: active && !on ? 0.45 : 1, transition: 'opacity .12s',
          background: on ? HILITE : `linear-gradient(to right, #F5EFE8 ${(s.weight / maxW) * 100}%, transparent 0)` }}>
          <div style={{ fontFamily: MONO, fontSize: '.7rem', color: '#A8A29E' }}>{s.rank}</div>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: TEXT }}>
            {s.name || s.stockid}
            <span style={{ display: 'block', fontFamily: MONO, fontSize: '.66rem', color: '#A8A29E' }}>
              {s.stockid.split(/\s+/)[0]}
            </span>
          </div>
          <div style={{ fontFamily: MONO, textAlign: 'right', fontWeight: 700, color: TEXT }}>{wpc(s.weight)}</div>
        </div>
        );
      })}
      {f.top.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8, padding: '8px 0 0', fontSize: '.8rem', fontWeight: 700 }}>
          <div /><div style={{ color: GOLD }}>合計</div>
          <div style={{ fontFamily: MONO, textAlign: 'right', color: TEXT }}>{wpc(f.topWeight)}</div>
        </div>
      )}
    </div>
  );
}

function CrossBar({ funds, active, locked, onClear }: {
  funds: TopFund[]; active: string | null; locked: string | null; onClear: () => void;
}) {
  // 頁面頂端的 .site-header 本身是 sticky，比對列要貼在它下面，不然捲動後會被蓋住（手機版標頭高度不同，所以量測）
  const [topOffset, setTopOffset] = useState(0);
  useEffect(() => {
    const measure = () => setTopOffset(Math.round(document.querySelector('.site-header')?.getBoundingClientRect().height ?? 0));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  const base: React.CSSProperties = {
    position: 'sticky', top: topOffset, zIndex: 20, background: '#FFFDF5', border: `1px solid ${active ? HILITE_EDGE : BORDER}`,
    borderRadius: 10, padding: '10px 16px', marginBottom: 14, fontSize: '.82rem', color: TEXT,
    lineHeight: 1.8, boxShadow: '0 2px 8px rgba(0,0,0,.06)', minHeight: 44,
  };
  if (!active) {
    return <div style={{ ...base, color: SUB }}>滑鼠指到（或點一下鎖定）任一檔持股，就會在所有卡片亮起同一檔，並在這裡列出各基金的權重。</div>;
  }
  const rows = funds.map((f) => ({ f, h: f.all?.[active] }));
  const name = rows.find((r) => r.h)?.h?.name ?? active;
  const held = rows.filter((r) => r.h).sort((a, b) => b.h!.weight - a.h!.weight);
  const notHeld = rows.filter((r) => !r.h);
  return (
    <div style={base}>
      <b>{name}</b> <span style={{ fontFamily: MONO, color: SUB, fontSize: '.74rem' }}>{active.replace(/\.(TW|TWO)$/, '')}</span>
      {locked === active && (
        <button type="button" onClick={onClear} style={{ marginLeft: 10, padding: '1px 10px', fontSize: '.72rem',
          border: `1px solid ${BORDER}`, borderRadius: 999, background: CARD, color: SUB, cursor: 'pointer' }}>已鎖定 ✕</button>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 18px' }}>
        {held.map(({ f, h }) => (
          <span key={f.ticker}>
            <span style={{ color: SUB }}>{f.ticker} {f.name}</span>{' '}
            <b style={{ fontFamily: MONO }}>{wpc(h!.weight)}</b>
            <span style={{ color: '#A8A29E', fontSize: '.72rem' }}>（第 {h!.rank} 大）</span>
          </span>
        ))}
        {notHeld.map(({ f }) => (
          <span key={f.ticker} style={{ color: '#B8B2AC' }}>{f.ticker} 未持有</span>
        ))}
      </div>
    </div>
  );
}

export default function TopHoldingsTab() {
  const sp0 = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const initMarket: Market = sp0?.get('mkt') === 'os' ? 'os' : 'tw';
  const initFunds = sp0?.get('funds')?.split(',').filter((t) => POOL[initMarket].some((f) => f.ticker === t));
  const [market, setMarket] = useState<Market>(initMarket);
  const [selected, setSelected] = useState<string[]>(initFunds?.length ? initFunds : DEFAULTS[initMarket]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [res, setRes] = useState<{ market: Market; funds: TopFund[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);
  const autoRan = useRef(false);
  const reqId = useRef(0);
  const [hover, setHover] = useState<string | null>(null);   // 滑鼠目前指到的個股 key
  const [locked, setLocked] = useState<string | null>(null); // 點擊鎖定的個股 key（手機/平板沒有 hover 就靠它）
  const active = hover ?? locked;
  const pick = (key: string) => setLocked((cur) => (cur === key ? null : key));

  const run = useCallback(async (m: Market, sel: string[]) => {
    if (!sel.length) { setErr('請至少勾選一檔 ETF。'); return; }
    const id = ++reqId.current;
    setLoading(true); setErr(''); setRes(null); setHover(null); setLocked(null);
    const sp = new URLSearchParams(window.location.search);
    sp.set('tab', 'top10'); sp.set('mkt', m); sp.set('funds', sel.join(','));
    window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`);
    try {
      const r = await fetch(`/api/top-holdings?market=${m}&tickers=${sel.join(',')}`, { cache: 'no-store' });
      const json = await r.json();
      if (id !== reqId.current) return; // 已被更新的請求取代（快速切換台股/海外）
      if (json.error) { setErr(json.error); return; }
      setRes({ market: m, funds: json.funds as TopFund[] });
    } catch (e) {
      if (id === reqId.current) setErr(e instanceof Error ? e.message : '查詢失敗');
    } finally { if (id === reqId.current) setLoading(false); }
  }, []);

  // 進站自動跑一次（含分享連結帶入的市場/勾選）
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    run(market, selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchMarket = (m: Market) => {
    if (m === market) return;
    setMarket(m);
    setSelected(DEFAULTS[m]);
    run(m, DEFAULTS[m]);
  };
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
    const aoa: (string | number)[][] = [[`前十大持股（${MARKET_LABEL[res.market]}）`], []];
    for (const f of res.funds) {
      aoa.push(
        [`${f.ticker} ${f.name}`, '前十大合計占淨值(%)', r2(f.topWeight), '持股資料日', f.asOfHoldings],
        ['排名', '代號', '名稱', '權重(%)'],
        ...f.top.map((s) => [s.rank, s.stockid, s.name, r2(s.weight)]),
        [],
      );
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 24 }, { wch: 16 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '前十大持股');
    XLSX.writeFile(wb, `前十大持股_${MARKET_LABEL[res.market]}.xlsx`);
  }, [res]);

  const shareImage = useCallback(async () => {
    if (!resultRef.current || !res) return;
    await captureAndShare(resultRef.current, `前十大持股_${MARKET_LABEL[res.market]}.jpg`, `主動式ETF 前十大持股（${MARKET_LABEL[res.market]}）`);
  }, [res]);

  const pin = DEFAULTS[res?.market ?? market][0];
  const ordered = res ? [...res.funds].sort((a, b) => (a.ticker === pin ? -1 : b.ticker === pin ? 1 : 0)) : [];
  const withTop = ordered.filter((f) => f.top.length);

  return (
    <div style={{ fontFamily: SANS }}>
      <p style={{ fontSize: '.82rem', color: SUB, marginTop: 0, marginBottom: 16, lineHeight: 1.7 }}>
        各主動式ETF 最新一筆持股快照的<b>前十大持股</b>（整檔基金、不限市場，已排除現金／期貨列），
        並加總前十大占淨值的權重。資料：CMoney／復華每日持股。
      </p>

      {/* 控制列 */}
      <div style={{ background: '#FAF8F5', border: `1px solid ${BORDER}`, borderRadius: 10, padding: 16, marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span style={{ fontSize: '.74rem', color: SUB, fontWeight: 500 }}>市場</span>
          <button type="button" onClick={() => switchMarket('tw')} style={chipBtn(market === 'tw')}>台股</button>
          <button type="button" onClick={() => switchMarket('os')} style={chipBtn(market === 'os')}>海外</button>
        </div>
        <div style={{ fontSize: '.74rem', color: SUB, fontWeight: 500, marginBottom: 8 }}>觀測ETF（可複選，★ 為主力觀測標的）</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
          {POOL[market].map((f) => (
            <label key={f.ticker} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
              background: selected.includes(f.ticker) ? '#FFF0EE' : CARD,
              border: `1px solid ${selected.includes(f.ticker) ? UP : BORDER}`,
              borderRadius: 999, fontSize: '.8rem', color: TEXT, cursor: 'pointer',
            }}>
              <input type="checkbox" checked={selected.includes(f.ticker)} onChange={() => toggleFund(f.ticker)} />
              {f.ticker === DEFAULTS[market][0] && <span style={{ color: UP }}>★</span>}
              {f.ticker} {f.name}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={() => run(market, selected)} disabled={loading} style={{
            padding: '9px 24px', background: loading ? '#999' : UP, color: '#fff', border: 'none',
            borderRadius: 6, cursor: loading ? 'wait' : 'pointer', fontSize: '.88rem', fontWeight: 600, fontFamily: SANS,
          }}>{loading ? '讀取中…' : '重新整理'}</button>
          {loading && <span style={{ fontSize: '.8rem', color: SUB }}>讀取各基金持股中…</span>}
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

          {/* 交叉比對列：貼在視窗頂端，指到/鎖定某檔個股時顯示它在各基金的權重與名次（含沒進前十大者） */}
          <CrossBar funds={ordered} active={active} locked={locked} onClear={() => setLocked(null)} />

          <div ref={resultRef} style={{ background: '#FFFFFF', padding: 2 }}>
            {/* 摘要：各基金前十大合計權重一覽（由高到低） */}
            {withTop.length > 0 && (
              <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10,
                padding: '12px 18px', marginBottom: 18, fontSize: '.84rem', color: TEXT, lineHeight: 1.9 }}>
                <b>前十大合計占淨值（{MARKET_LABEL[res.market]}）</b>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 18px' }}>
                  {[...withTop].sort((a, b) => b.topWeight - a.topWeight).map((f) => (
                    <span key={f.ticker}>
                      <span style={{ color: SUB }}>{f.ticker} {f.name}</span>{' '}
                      <b style={{ fontFamily: MONO }}>{wpc1(f.topWeight)}</b>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 18 }}>
              {ordered.map((f) => (
                <FundCard key={f.ticker} f={f} pinned={f.ticker === pin} active={active} onHover={setHover} onPick={pick} />
              ))}
            </div>

            <p style={{ fontSize: '.72rem', color: '#B8B2AC', margin: '18px 0 0', lineHeight: 1.75 }}>
              權重為占基金淨值比例（含應計利息），同一檔個股若在持股表以不同代號寫法出現會合併加總。
              各投信持股公布時間不一，「持股資料日」為各基金最新一筆快照，可能有 1 個交易日左右的時差。
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
