'use client';
import { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import type { StockPerformance } from '@/lib/yahooFinance';

/* 「創新高強勢股」獨立分頁（原本是持股清單頁裡的一個模式，2026-08-12 應使用者要求
   拉出來獨立成頁）。內容性質不變：只疊加已公開的持股權重 + 公開市場價格算出的
   YTD 還原權息報酬與是否創高，不含亮點引擎的操作意圖/事件日期/草稿句
   （見 docs/HANDOVER.md 天條 2 的例外說明）。v1 僅支援 00991A（fundId ETF23）。 */

const RED    = '#C00000';
const GREEN  = '#1a7f37';
const GOLD   = '#8A6A3C';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

const FUND_ID = 'ETF23'; // 00991A；v1 僅支援這檔
const ETF_TICKER = '00991A';

const TH: React.CSSProperties = {
  padding: '11px 14px', fontWeight: 600, fontSize: '.78rem', letterSpacing: '.4px',
  background: '#1C1C1E', color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1, cursor: 'default',
};

function localStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function prevTradingDay(from: Date): Date {
  const d = new Date(from);
  do { d.setDate(d.getDate() - 1); } while (d.getDay() === 0 || d.getDay() === 6);
  return d;
}
// 台北時間 17:00 前，當日持股尚未更新 → 用前一交易日；假日一律退回上一個交易日
function defaultDate(): string {
  const now = new Date();
  const twHour = new Date(now.getTime() + 8 * 3600 * 1000).getUTCHours();
  const base = twHour < 17 ? prevTradingDay(now) : now;
  const day = base.getDay();
  return day === 0 || day === 6 ? localStr(prevTradingDay(base)) : localStr(base);
}
function defaultSinceDate(): string {
  return `${new Date().getFullYear()}-01-01`;
}

function fmtPrice(n: number | null): string {
  if (n == null) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function fmtPct(n: number | null): string {
  if (n == null) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}
function plColor(n: number | null): string {
  if (n == null) return SUB;
  return n > 0 ? RED : n < 0 ? GREEN : SUB;
}
function fmtMD(iso: string | null): string {
  if (!iso) return '—';
  const parts = iso.slice(5).split('-');
  return parts.length === 2 ? `${parts[0]}/${parts[1]}` : iso;
}
// priceAsOf 是 ISO 字串 → 顯示台北時間 'YYYY/MM/DD HH:mm'
function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).replace(/\//g, '/');
  } catch { return iso; }
}

function exportExcel(rows: StockPerformance[], date: string) {
  const headers = ['代碼', '名稱', '持股佔比%', '最新價格', '報價時間', 'YTD還原權息%', '是否創高', '距高點%', '前高價格', '前高日期', '創新高價格', '創新高日期'];
  const body = rows.map(r => [
    r.stockid, r.stockname, parseFloat(r.prate.toFixed(2)), r.currentPrice,
    fmtDateTime(r.priceAsOf), r.ytd == null ? '' : parseFloat(r.ytd.toFixed(2)),
    r.isNewHigh ? '創新高' : '未創高',
    r.distFromHighPct == null ? '' : parseFloat(r.distFromHighPct.toFixed(2)),
    r.priorHigh, r.priorHighDate ?? '', r.postHigh, r.postHighDate ?? '',
  ]);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...body]);
  ws['!cols'] = [{ wch: 8 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 12 }, { wch: 9 }, { wch: 9 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '創新高強勢股');
  XLSX.writeFile(wb, `${ETF_TICKER}_創新高強勢股_${date}.xlsx`);
}

export default function NewHighTab() {
  const [date, setDate] = useState(defaultDate());
  const [rows, setRows]       = useState<StockPerformance[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [minWeight, setMinWeight] = useState(1.0);
  const [maxDist, setMaxDist]     = useState(5.0);
  const [sinceDate, setSinceDate]           = useState<string | null>(null);
  const [draftSinceDate, setDraftSinceDate] = useState(defaultSinceDate());
  const [dateTouched, setDateTouched]       = useState(false);
  const stepBack = useRef(0);

  // 預設基準日＝加權指數(^TWII)今年至今高點日；查不到（或使用者已手動調整過）退回今年1/1
  useEffect(() => {
    let cancelled = false;
    fetch('/api/index-ytd-high')
      .then(async res => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (cancelled || dateTouched) return;
        const d = json.date || defaultSinceDate();
        setSinceDate(d);
        setDraftSinceDate(d);
      })
      .catch(() => {
        if (!cancelled && !dateTouched) { setSinceDate(defaultSinceDate()); setDraftSinceDate(defaultSinceDate()); }
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!sinceDate) return;
    let cancelled = false;
    setLoading(true); setError(''); setRows(null);
    const apiDate = date.replaceAll('-', '/');
    const url = `/api/holdings-newhigh?date=${encodeURIComponent(apiDate)}&fundId=${encodeURIComponent(FUND_ID)}&sinceDate=${encodeURIComponent(sinceDate)}`;
    fetch(url, { cache: 'no-store' })
      .then(async res => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (!cancelled) setRows(json.results as StockPerformance[]);
      })
      .catch(e => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : '查詢失敗';
        // 預設日只跳週末、不認國定假日／颱風假 → 撞到「尚未公布」就往前一個平日找（最多 8 次）
        if (msg.includes('尚未公布') && stepBack.current < 8) {
          stepBack.current += 1;
          setDate(localStr(prevTradingDay(new Date(`${date}T00:00:00`))));
          return;
        }
        setError(msg);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date, sinceDate]);

  const applyDraftDate = () => {
    setDateTouched(true);
    if (draftSinceDate && draftSinceDate !== sinceDate) setSinceDate(draftSinceDate);
  };

  if (loading || !sinceDate) {
    return <div style={{ padding: '32px 0', textAlign: 'center', color: SUB, fontFamily: SANS, fontSize: '.9rem' }}>載入中…</div>;
  }
  if (error) {
    return <div style={{ padding: '32px 0', textAlign: 'center', color: RED, fontFamily: SANS, fontSize: '.9rem' }}>{error}</div>;
  }
  if (!rows) return null;

  const filtered = rows
    .filter(r => r.prate >= minWeight && r.distFromHighPct != null && r.distFromHighPct <= maxDist)
    .sort((a, b) => {
      if (a.isNewHigh !== b.isNewHigh) return a.isNewHigh ? -1 : 1;
      return (a.distFromHighPct ?? 0) - (b.distFromHighPct ?? 0);
    });

  // 報價時間可能逐檔略有差異（各自 quote 抓取時間點不同），取最新一筆代表「最新報價時間」
  const latestQuoteAt = rows.reduce<string | null>((mx, r) => (r.priceAsOf && (!mx || r.priceAsOf > mx) ? r.priceAsOf : mx), null);

  return (
    <>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontFamily: SANS, fontSize: '.78rem', color: SUB }}>
          持股資料日期
          <input type="date" value={date} onChange={e => { if (e.target.value) { stepBack.current = 0; setDate(e.target.value); } }}
            style={{ padding: '4px 8px', border: `1px solid ${BORDER}`, borderRadius: 6, fontFamily: MONO, fontSize: '.82rem', color: TEXT }} />
        </label>
        <button onClick={() => exportExcel(filtered, date)} style={{
          padding: '6px 16px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6,
          cursor: 'pointer', fontSize: '.8rem', color: SUB, fontFamily: SANS, fontWeight: 500, marginLeft: 'auto',
        }}>
          ↓ 匯出 Excel
        </button>
      </div>

      {/* 資料日期/時間標註：使用者明確要求標在表格附近，說明距高點是用哪個價格算的 */}
      <div style={{
        display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12,
        padding: '9px 14px', background: '#FAFAF9', border: `1px solid ${BORDER}`, borderRadius: 8,
        fontSize: '.78rem', color: SUB, fontFamily: SANS,
      }}>
        <span>持股資料日期：<b style={{ color: TEXT, fontFamily: MONO }}>{date.replaceAll('-', '/')}</b></span>
        <span>最新報價時間：<b style={{ color: TEXT, fontFamily: MONO }}>{fmtDateTime(latestQuoteAt)}</b>（台北時間）</span>
        <span style={{ color: '#B0AAA4' }}>｜</span>
        <span>下方「最新價格」與「距高點」都是用這個報價時間點的價格算的，<b style={{ color: TEXT }}>不是最新收盤價</b>；盤中可能落後 15–20 分鐘，收盤後約 1–2 小時更新為當日收盤價。</span>
      </div>

      <div style={{
        display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'center',
        marginBottom: 16, padding: '12px 16px', background: '#FAFAF9',
        border: `1px solid ${BORDER}`, borderRadius: 8,
      }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontFamily: SANS, fontSize: '.78rem', color: SUB }}>
          持股佔比 ≥ <strong style={{ color: TEXT, fontFamily: MONO }}>{minWeight.toFixed(1)}%</strong>
          <input type="range" min={0} max={15} step={0.5} value={minWeight}
            onChange={e => setMinWeight(parseFloat(e.target.value))} style={{ width: 180 }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontFamily: SANS, fontSize: '.78rem', color: SUB }}>
          距高點 ≤ <strong style={{ color: TEXT, fontFamily: MONO }}>{maxDist.toFixed(1)}%</strong>
          <input type="range" min={0} max={50} step={0.5} value={maxDist}
            onChange={e => setMaxDist(parseFloat(e.target.value))} style={{ width: 180 }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontFamily: SANS, fontSize: '.78rem', color: SUB }}>
          高點比較基準（預設加權指數今年高點日）
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="date" value={draftSinceDate} max={date}
              onChange={e => { if (e.target.value) { setDraftSinceDate(e.target.value); setDateTouched(true); } }}
              onKeyDown={e => { if (e.key === 'Enter') applyDraftDate(); }}
              style={{ padding: '4px 8px', border: `1px solid ${BORDER}`, borderRadius: 6, fontFamily: MONO, fontSize: '.82rem', color: TEXT }} />
            <button onClick={applyDraftDate} disabled={draftSinceDate === sinceDate}
              style={{
                padding: '4px 12px', border: `1px solid ${BORDER}`, borderRadius: 6,
                background: draftSinceDate === sinceDate ? '#fff' : TEXT,
                color: draftSinceDate === sinceDate ? SUB : '#fff',
                fontFamily: SANS, fontSize: '.8rem', fontWeight: 600,
                cursor: draftSinceDate === sinceDate ? 'default' : 'pointer',
              }}>
              套用
            </button>
          </div>
        </label>
        <span style={{ fontFamily: SANS, fontSize: '.8rem', color: SUB, marginLeft: 'auto' }}>
          符合 <strong style={{ color: TEXT }}>{filtered.length}</strong> / {rows.length} 檔
        </span>
      </div>
      <div style={{ marginBottom: 12, fontSize: '.76rem', color: SUB, fontFamily: SANS }}>
        前高：{sinceDate.replaceAll('-', '/')} 以前的最高價；創新高：{sinceDate.replaceAll('-', '/')} 以後是否創出比前高更高的價格。
      </div>

      <div className="mt" style={{ overflowX: 'auto', borderRadius: 8, border: `1px solid ${BORDER}` }}>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, minWidth: 1220 }}>
          <thead>
            <tr>
              <th style={{ ...TH, textAlign: 'center', width: 88 }}>代碼</th>
              <th style={{ ...TH, textAlign: 'left' }}>名稱</th>
              <th style={{ ...TH, textAlign: 'right' }}>持股佔比</th>
              <th style={{ ...TH, textAlign: 'right' }}>最新價格</th>
              <th style={{ ...TH, textAlign: 'right' }}>YTD 還原權息</th>
              <th style={{ ...TH, textAlign: 'center' }}>目前狀態</th>
              <th style={{ ...TH, textAlign: 'right' }}>距高點</th>
              <th style={{ ...TH, textAlign: 'right' }}>前高價格</th>
              <th style={{ ...TH, textAlign: 'right' }}>前高日期</th>
              <th style={{ ...TH, textAlign: 'right' }}>創新高價格</th>
              <th style={{ ...TH, textAlign: 'right' }}>創新高日期</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={r.stockid} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAF9', borderBottom: `1px solid ${BORDER}` }}>
                <td style={{ padding: '9px 14px', textAlign: 'center', fontSize: '.82rem', fontFamily: MONO, color: SUB }}>{r.stockid}</td>
                <td style={{ padding: '9px 14px', fontSize: '.88rem', color: TEXT }}>{r.stockname}</td>
                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', color: SUB }}>{r.prate.toFixed(2)}%</td>
                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', color: TEXT, fontWeight: 600 }}>{fmtPrice(r.currentPrice)}</td>
                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', fontWeight: 600, color: plColor(r.ytd) }}>{fmtPct(r.ytd)}</td>
                <td style={{ padding: '9px 14px', textAlign: 'center' }}>
                  {r.isNewHigh
                    ? <span style={{
                        display: 'inline-block', padding: '3px 10px', borderRadius: 999,
                        background: '#FBEFE2', color: GOLD, fontSize: '.76rem', fontWeight: 700, fontFamily: SANS,
                      }}>🔥 創新高（{fmtMD(r.postHighDate)}）</span>
                    : <span style={{ fontSize: '.78rem', color: SUB, fontFamily: SANS }}>未創新高</span>}
                </td>
                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem' }}>
                  {r.isNewHigh ? (
                    <span style={{ color: SUB }}>—</span>
                  ) : (
                    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                      <span style={{ color: TEXT }}>-{r.distFromHighPct?.toFixed(2)}%</span>
                      <div style={{ width: 72, height: 4, borderRadius: 999, background: BORDER, position: 'relative', overflow: 'hidden' }}>
                        <div style={{
                          position: 'absolute', right: 0, top: 0, bottom: 0,
                          width: `${Math.min(100, ((r.distFromHighPct ?? 0) / 50) * 100)}%`,
                          background: GOLD, borderRadius: 999,
                        }} />
                      </div>
                    </div>
                  )}
                </td>
                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', color: TEXT }}>{fmtPrice(r.priorHigh)}</td>
                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>{fmtMD(r.priorHighDate)}</td>
                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', color: r.isNewHigh ? RED : SUB }}>
                  {r.isNewHigh ? fmtPrice(r.postHigh) : '—'}
                </td>
                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>
                  {r.isNewHigh ? fmtMD(r.postHighDate) : '—'}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={11} style={{ padding: '24px', textAlign: 'center', color: SUB, fontFamily: SANS, fontSize: '.85rem' }}>
                無符合篩選條件的持股
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 10, fontSize: '.74rem', color: SUB, fontFamily: SANS }}>
        YTD 還原權息固定以去年 12/31 為基準；「前高」「創新高」則以上方「高點比較基準」日期切分前後兩段各自找最高價。皆採 Yahoo Finance 還原收盤價（adjClose），避免除息造成的價格跳空被誤判。此功能目前僅支援 00991A。
      </div>
    </>
  );
}
