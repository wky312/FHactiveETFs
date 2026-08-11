'use client';
import { useState, useMemo, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { Holding } from '@/lib/types';
import type { StockPerformance } from '@/lib/yahooFinance';

const RED    = '#C00000';
const GREEN  = '#1a7f37';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

const NEWHIGH_FUND_ID = 'ETF23'; // 00991A；v1 僅支援這檔

type SortKey = 'stockid' | 'stockname' | 'qshare' | 'mvalue' | 'prate_addaccint' | 'country';

const TH: React.CSSProperties = {
  padding: '11px 14px', fontWeight: 600, fontSize: '.78rem', letterSpacing: '.4px',
  background: '#1C1C1E', color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1,
  cursor: 'pointer', userSelect: 'none',
};

function rowBg(h: Holding, i: number) {
  if (h.country === '期貨')      return '#FDFAF2';
  if (h.country === '現金/其他') return '#F8F8F8';
  return i % 2 === 0 ? '#fff' : '#FAFAF9';
}

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtMvalue(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(3)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

interface StatCard { label: string; value: string; sub: string; valueColor?: string }

function StatCards({ cards }: { cards: StatCard[] }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
      border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden',
      marginBottom: 16, background: '#FAFAF9',
    }}>
      {cards.map((c, i) => (
        <div key={c.label} style={{
          padding: '14px 18px',
          borderRight: i < cards.length - 1 ? `1px solid ${BORDER}` : 'none',
        }}>
          <div style={{ fontSize: '.72rem', color: SUB, fontWeight: 500, marginBottom: 5, fontFamily: SANS }}>{c.label}</div>
          <div style={{ fontSize: '1.55rem', fontWeight: 700, color: c.valueColor ?? TEXT, fontFamily: MONO, lineHeight: 1.1 }}>{c.value}</div>
          <div style={{ fontSize: '.72rem', color: SUB, marginTop: 4, fontFamily: SANS }}>{c.sub}</div>
        </div>
      ))}
    </div>
  );
}

function exportExcel(holdings: Holding[], date: string, ticker: string) {
  const headers = ['代碼', '名稱', '持股數量', '市值(NTD)', '佔比%', '國家'];
  const rows = holdings.map(h => [
    h.stockid,
    h.stockname,
    h.qshare,
    h.mvalue,
    parseFloat(h.prate_addaccint.toFixed(3)),
    h.country,
  ]);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = [
    { wch: 10 }, { wch: 20 }, { wch: 14 }, { wch: 16 }, { wch: 10 }, { wch: 12 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '持股清單');
  XLSX.writeFile(wb, `${ticker}_持股清單_${date}.xlsx`);
}

// 漲跌色（台股：紅漲綠跌）
function plColor(n: number | null): string {
  if (n == null) return SUB;
  return n > 0 ? RED : n < 0 ? GREEN : SUB;
}

function fmtPct(n: number | null): string {
  if (n == null) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function fmtPrice(n: number | null): string {
  if (n == null) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// priorHighDate / postHighDate 是 ISO YYYY-MM-DD，顯示成 MM/DD
function fmtMD(iso: string | null): string {
  if (!iso) return '—';
  const parts = iso.slice(5).split('-');
  return parts.length === 2 ? `${parts[0]}/${parts[1]}` : iso;
}

function defaultSinceDate(): string {
  return `${new Date().getFullYear()}-01-01`;
}

// 「創新高強勢股」：持股佔比夠大、且在使用者選定的比較基準日之後創出比基準日以前更高價格
// （即「突破前高」）的持股，供行銷篩選話題股用。資料來自 /api/holdings-newhigh（重用
// fetchStockPerformance 的 YTD 還原權息報酬計算，口徑跟「個股與績效」分頁一致）。
// 比較基準日可自訂（預設今年 1/1）：分別找出「基準日以前的前高」與「基準日以後的最高價」，
// 後者若高於前者即視為突破——這個判定一旦成立就不會因為單日拉回而消失，比逐日比對更穩定。
function NewHighPanel({ date, fundId }: { date: string; fundId: string }) {
  const [rows, setRows]       = useState<StockPerformance[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [minWeight, setMinWeight] = useState(1.0);
  const [maxDist, setMaxDist]     = useState(5.0);
  // sinceDate＝實際觸發查詢的基準日（null＝預設值還沒決定好，先不查）；
  // draftSinceDate＝日期輸入框正在編輯的值。兩者分離是因為 <input type="date"> 每次微調
  // （點選日/月/年欄位）都會觸發 onChange，若直接綁到會觸發 fetch 的 state，使用者調日期
  // 時會一直重新查詢、很難定住想要的日期——改成要按「套用」才會真正觸發查詢。
  const [sinceDate, setSinceDate]           = useState<string | null>(null);
  const [draftSinceDate, setDraftSinceDate] = useState(defaultSinceDate());
  const [dateTouched, setDateTouched]       = useState(false);

  const supported = fundId === NEWHIGH_FUND_ID;

  // 預設基準日＝加權指數（^TWII）今年至今高點的日期；拿不到（或使用者搶先手動調整過）就退回今年 1/1。
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
    if (!supported || !sinceDate) return;
    let cancelled = false;
    setLoading(true); setError(''); setRows(null);
    const url = `/api/holdings-newhigh?date=${encodeURIComponent(date)}&fundId=${encodeURIComponent(fundId)}&sinceDate=${encodeURIComponent(sinceDate)}`;
    fetch(url)
      .then(async res => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (!cancelled) setRows(json.results as StockPerformance[]);
      })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : '查詢失敗'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date, fundId, sinceDate, supported]);

  const applyDraftDate = () => {
    setDateTouched(true);
    if (draftSinceDate && draftSinceDate !== sinceDate) setSinceDate(draftSinceDate);
  };

  if (!supported) {
    return (
      <div style={{ padding: '32px 0', textAlign: 'center', color: SUB, fontFamily: SANS, fontSize: '.9rem' }}>
        此功能目前僅支援 00991A
      </div>
    );
  }

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
      if (a.isNewHigh !== b.isNewHigh) return a.isNewHigh ? -1 : 1; // 已突破的排前面
      return (a.distFromHighPct ?? 0) - (b.distFromHighPct ?? 0);
    });

  return (
    <>
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
            <input type="date" value={draftSinceDate} max={date.replaceAll('/', '-')}
              onChange={e => { if (e.target.value) { setDraftSinceDate(e.target.value); setDateTouched(true); } }}
              onKeyDown={e => { if (e.key === 'Enter') applyDraftDate(); }}
              style={{
                padding: '4px 8px', border: `1px solid ${BORDER}`, borderRadius: 6,
                fontFamily: MONO, fontSize: '.82rem', color: TEXT,
              }} />
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

      <div style={{ overflowX: 'auto', borderRadius: 8, border: `1px solid ${BORDER}` }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1080 }}>
          <thead>
            <tr>
              <th style={{ ...TH, textAlign: 'center', width: 88, cursor: 'default' }}>代碼</th>
              <th style={{ ...TH, textAlign: 'left', cursor: 'default' }}>名稱</th>
              <th style={{ ...TH, textAlign: 'right', cursor: 'default' }}>持股佔比</th>
              <th style={{ ...TH, textAlign: 'right', cursor: 'default' }}>YTD 還原權息</th>
              <th style={{ ...TH, textAlign: 'center', cursor: 'default' }}>目前狀態</th>
              <th style={{ ...TH, textAlign: 'right', cursor: 'default' }}>距高點</th>
              <th style={{ ...TH, textAlign: 'right', cursor: 'default' }}>前高價格</th>
              <th style={{ ...TH, textAlign: 'right', cursor: 'default' }}>前高日期</th>
              <th style={{ ...TH, textAlign: 'right', cursor: 'default' }}>創新高價格</th>
              <th style={{ ...TH, textAlign: 'right', cursor: 'default' }}>創新高日期</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={r.stockid} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAF9', borderBottom: `1px solid ${BORDER}` }}>
                <td style={{ padding: '9px 14px', textAlign: 'center', fontSize: '.82rem', fontFamily: MONO, color: SUB }}>{r.stockid}</td>
                <td style={{ padding: '9px 14px', fontSize: '.88rem', color: TEXT }}>{r.stockname}</td>
                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', color: SUB }}>{r.prate.toFixed(2)}%</td>
                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', fontWeight: 600, color: plColor(r.ytd) }}>{fmtPct(r.ytd)}</td>
                <td style={{ padding: '9px 14px', textAlign: 'center' }}>
                  {r.isNewHigh
                    ? <span style={{
                        display: 'inline-block', padding: '3px 10px', borderRadius: 999,
                        background: '#FBEFE2', color: '#8A6A3C', fontSize: '.76rem', fontWeight: 700, fontFamily: SANS,
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
                          background: '#8A6A3C', borderRadius: 999,
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
              <tr><td colSpan={10} style={{ padding: '24px', textAlign: 'center', color: SUB, fontFamily: SANS, fontSize: '.85rem' }}>
                無符合篩選條件的持股
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 10, fontSize: '.74rem', color: SUB, fontFamily: SANS }}>
YTD 還原權息固定以去年 12/31 為基準；「前高」「創新高」則以上方「高點比較基準」日期切分前後兩段各自找最高價。三者皆採 Yahoo Finance 還原收盤價（adjClose），避免除息造成的價格跳空被誤判。
      </div>
    </>
  );
}

export default function HoldingsTab({ holdings, date, etfTicker, fundId }: { holdings: Holding[]; date: string; etfTicker: string; fundId: string }) {
  const [mode, setMode] = useState<'list' | 'newhigh'>('list');
  const [sortKey, setSortKey] = useState<SortKey>('prate_addaccint');
  const [sortAsc, setSortAsc] = useState(false);

  const stocks  = holdings.filter(h => h.stockid.trim() !== '');
  const byPrate = [...stocks].sort((a, b) => b.prate_addaccint - a.prate_addaccint);
  const top     = byPrate[0];
  const top10   = byPrate.slice(0, 10).reduce((s, h) => s + h.prate_addaccint, 0);
  const totalMv = holdings.reduce((s, h) => s + h.mvalue, 0);
  const mktCount = new Set(
    stocks.filter(h => h.country !== '期貨' && h.country !== '現金/其他').map(h => h.country)
  ).size;

  const sortedHoldings = useMemo(() => {
    return [...holdings].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'string' && typeof bv === 'string')
        return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
  }, [holdings, sortKey, sortAsc]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc(p => !p);
    else { setSortKey(key); setSortAsc(false); }
  };

  const thLabel = (key: SortKey, label: string) =>
    sortKey === key ? `${label} ${sortAsc ? '↑' : '↓'}` : label;

  const statCards: StatCard[] = [
    {
      label: '最大持倉',
      value: `${top?.prate_addaccint.toFixed(3) ?? '—'}%`,
      sub:   top ? `${top.stockid} · ${top.stockname.slice(0, 12)}` : '',
      valueColor: RED,
    },
    {
      label: '持股檔數',
      value: String(stocks.length),
      sub:   `跨 ${mktCount} 個市場`,
    },
    {
      label: '總市值 (NTD)',
      value: fmtMvalue(totalMv),
      sub:   '以台幣計算',
    },
    {
      label: '前十大合計',
      value: `${top10.toFixed(1)}%`,
      sub:   '集中度指標',
    },
  ];

  return (
    <>
      {/* 模式切換：持股明細 ↔ 創新高強勢股 */}
      <div style={{ display: 'inline-flex', border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
        {([['list', '持股明細'], ['newhigh', '創新高強勢股']] as const).map(([k, label]) => (
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

      {mode === 'newhigh' ? (
        <NewHighPanel date={date} fundId={fundId} />
      ) : (
      <>
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: '.82rem', color: SUB, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <span>資料日期：<strong style={{ color: TEXT, fontFamily: MONO }}>{date}</strong></span>
          <span style={{ color: BORDER }}>|</span>
          <span>共 <strong style={{ color: TEXT }}>{holdings.length}</strong> 筆　點擊欄位標題可排序</span>
        </div>
        <button
          onClick={() => exportExcel(sortedHoldings, date, etfTicker)}
          style={{
            padding: '6px 16px', background: '#fff', border: `1px solid ${BORDER}`,
            borderRadius: 6, cursor: 'pointer', fontSize: '.8rem', color: SUB,
            fontFamily: SANS, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          ↓ 匯出 Excel
        </button>
      </div>

      <StatCards cards={statCards} />

      <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '60vh', borderRadius: 8, border: `1px solid ${BORDER}` }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead>
            <tr>
              <th onClick={() => toggleSort('stockid')}         style={{ ...TH, textAlign: 'center', width: 88, position: 'sticky', left: 0, zIndex: 2 }}>{thLabel('stockid', '代碼')}</th>
              <th onClick={() => toggleSort('stockname')}       style={{ ...TH, textAlign: 'left', position: 'sticky', left: 88, zIndex: 2 }}>{thLabel('stockname', '名稱')}</th>
              <th onClick={() => toggleSort('qshare')}          style={{ ...TH, textAlign: 'right' }}>{thLabel('qshare', '持股數量')}</th>
              <th onClick={() => toggleSort('mvalue')}          style={{ ...TH, textAlign: 'right' }}>{thLabel('mvalue', '市值 (NTD)')}</th>
              <th onClick={() => toggleSort('prate_addaccint')} style={{ ...TH, textAlign: 'right' }}>{thLabel('prate_addaccint', '佔比 %')}</th>
              <th onClick={() => toggleSort('country')}         style={{ ...TH, textAlign: 'center' }}>{thLabel('country', '國家')}</th>
            </tr>
          </thead>
          <tbody>
            {sortedHoldings.map((h, i) => {
              const bg = rowBg(h, i);
              return (
              <tr key={`${h.stockid}-${i}`} style={{ background: bg, borderBottom: `1px solid ${BORDER}` }}>
                <td style={{ padding: '9px 14px', textAlign: 'center', fontSize: '.82rem', fontFamily: MONO, color: SUB, position: 'sticky', left: 0, zIndex: 1, background: bg }}>{h.stockid || '—'}</td>
                <td style={{ padding: '9px 14px', fontSize: '.88rem', color: TEXT, maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', position: 'sticky', left: 88, zIndex: 1, background: bg }}>{h.stockname}</td>
                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', color: TEXT }}>{fmt(h.qshare)}</td>
                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', color: TEXT }}>{fmt(h.mvalue)}</td>
                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', color: TEXT, fontWeight: 500 }}>{h.prate_addaccint.toFixed(3)}%</td>
                <td style={{ padding: '9px 14px', textAlign: 'center', fontSize: '.8rem', color: SUB }}>{h.country}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </>
      )}
    </>
  );
}
