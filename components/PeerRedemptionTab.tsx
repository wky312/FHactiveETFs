'use client';
import { useState, useCallback, useRef } from 'react';
import { ScaleDay } from '@/lib/fhtrustScale';
import { EzmoneyDay } from '@/lib/ezmoneyScale';
import { CapitalDay } from '@/lib/capitalScale';

const RED    = '#C00000';
const GREEN  = '#1A6B45';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

// Configured ETFs
const FHTRUST_ETFS = [
  { ticker: '00991A', name: '復華',    fundId: 'ETF23' },
];
const EZMONEY_ETFS = [
  { ticker: '00981A', name: '統一981', fundCode: '49YTW' },
  { ticker: '00403A', name: '統一403', fundCode: '63YTW' },
];
const CAPITAL_ETFS = [
  { ticker: '00982A', name: '群益982', fundId: '399' },
  { ticker: '00992A', name: '群益992', fundId: '500' },
];
const ALL_TICKERS = [
  ...FHTRUST_ETFS.map(e => e.ticker),
  ...EZMONEY_ETFS.map(e => e.ticker),
  ...CAPITAL_ETFS.map(e => e.ticker),
];

const TH: React.CSSProperties = {
  padding: '9px 12px', fontWeight: 600, fontSize: '.75rem',
  background: TEXT, color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1, letterSpacing: '.3px',
};

function localStr(d: Date) {
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}
function prevWeekday(d: Date) {
  const r = new Date(d);
  do { r.setDate(r.getDate() - 1); } while (r.getDay() === 0 || r.getDay() === 6);
  return r;
}

function fmtSub(v: number | null) {
  if (v === null) return '—';
  const s = Math.abs(v).toFixed(2);
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : '0';
}
function fmtAum(v: number | null) {
  if (v === null) return '—';
  if (v >= 10000) return `${(v/10000).toFixed(2)} 兆`;
  return `${v.toFixed(2)} 億`;
}
function subColor(v: number | null) {
  if (v === null || v === 0) return SUB;
  return v > 0 ? RED : GREEN;
}

// Unified row type
interface DayRow {
  date: string;
  data: Record<string, { netSub: number; aum: number } | null>;
}

const norm = (d: string) => d.replace(/\//g, '-'); // → YYYY-MM-DD

function mergeDays(
  fhData: Map<string, ScaleDay[]>,
  ezData: Map<string, EzmoneyDay[]>,
  capData: Map<string, CapitalDay[]>,
): DayRow[] {
  const dateSet = new Set<string>();
  fhData.forEach(days  => days.forEach(d => dateSet.add(norm(d.date))));
  ezData.forEach(days  => days.forEach(d => dateSet.add(norm(d.date))));
  capData.forEach(days => days.forEach(d => dateSet.add(norm(d.date))));

  const rows: DayRow[] = [];
  for (const date of Array.from(dateSet).sort()) {
    const data: DayRow['data'] = {};
    for (const { ticker, fundId } of FHTRUST_ETFS) {
      const d = (fhData.get(fundId) ?? []).find(x => norm(x.date) === date);
      data[ticker] = d ? { netSub: d.netSub, aum: d.aum } : null;
    }
    for (const { ticker, fundCode } of EZMONEY_ETFS) {
      const d = (ezData.get(fundCode) ?? []).find(x => norm(x.date) === date);
      data[ticker] = d ? { netSub: d.netSub, aum: d.aum } : null;
    }
    for (const { ticker, fundId } of CAPITAL_ETFS) {
      const d = (capData.get(fundId) ?? []).find(x => norm(x.date) === date);
      data[ticker] = d ? { netSub: d.netSub, aum: d.aum } : null;
    }
    rows.push({ date, data });
  }
  return rows.reverse();
}

export default function PeerRedemptionTab() {
  const today    = new Date();
  const defEnd   = localStr(prevWeekday(today));
  const defStart = localStr(new Date(new Date(defEnd.replace(/\//g,'-')).setDate(new Date(defEnd.replace(/\//g,'-')).getDate() - 13)));

  const [startDate, setStartDate] = useState(defStart.replace(/\//g, '-'));
  const [endDate,   setEndDate]   = useState(defEnd.replace(/\//g, '-'));
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');
  const [rows,      setRows]      = useState<DayRow[] | null>(null);
  const subsRef = useRef<HTMLDivElement>(null);
  const aumRef  = useRef<HTMLDivElement>(null);

  const saveImage = useCallback(async (ref: React.RefObject<HTMLDivElement | null>, filename: string) => {
    const el = ref.current;
    if (!el) return;
    try {
      await document.fonts.ready;
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
      const jpgName = filename.replace(/\.png$/, '.jpg');
      if (typeof navigator !== 'undefined' && navigator.canShare) {
        try {
          const blob = await new Promise<Blob>(res => canvas.toBlob(b => res(b!), 'image/jpeg', 0.92));
          const file = new File([blob], jpgName, { type: 'image/jpeg' });
          if (navigator.canShare({ files: [file] })) { await navigator.share({ title: '同業申贖觀測', files: [file] }); return; }
        } catch {}
      }
      const link = document.createElement('a');
      link.download = jpgName;
      link.href = canvas.toDataURL('image/jpeg', 0.92);
      link.click();
    } catch {}
  }, []);

  const toApi = (s: string) => s.replace(/-/g, '/');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setRows(null);
    try {
      const sd = toApi(startDate);
      const ed = toApi(endDate);
      // Capital uses YYYY-MM-DD
      const sdDash = startDate;
      const edDash = endDate;

      // Fetch all sources in parallel
      const [fhMap, ezMap, capMap] = await Promise.all([
        // 復華 (fhtrust)
        Promise.all(FHTRUST_ETFS.map(async ({ fundId }) => {
          const r = await fetch(`/api/etf-scale?startDate=${encodeURIComponent(sd)}&endDate=${encodeURIComponent(ed)}&fundId=${encodeURIComponent(fundId)}`);
          return { fundId, data: r.ok ? (await r.json() as ScaleDay[]) : [] };
        })).then(arr => new Map(arr.map(({ fundId, data }) => [fundId, data]))),
        // 統一 (ezmoney)
        Promise.all(EZMONEY_ETFS.map(async ({ fundCode }) => {
          const r = await fetch(`/api/ezmoney-scale?fundCode=${encodeURIComponent(fundCode)}&startDate=${encodeURIComponent(sd)}&endDate=${encodeURIComponent(ed)}`);
          return { fundCode, data: r.ok ? (await r.json() as EzmoneyDay[]) : [] };
        })).then(arr => new Map(arr.map(({ fundCode, data }) => [fundCode, data]))),
        // 群益 (capital)
        Promise.all(CAPITAL_ETFS.map(async ({ fundId }) => {
          const r = await fetch(`/api/capital-scale?fundId=${encodeURIComponent(fundId)}&startDate=${encodeURIComponent(sdDash)}&endDate=${encodeURIComponent(edDash)}`);
          return { fundId, data: r.ok ? (await r.json() as CapitalDay[]) : [] };
        })).then(arr => new Map(arr.map(({ fundId, data }) => [fundId, data]))),
      ]);

      setRows(mergeDays(fhMap, ezMap, capMap));
    } catch (e) {
      setError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  // Quick range
  const setRange = (days: number) => {
    const end   = prevWeekday(today);
    const start = new Date(end);
    start.setDate(start.getDate() - (days - 1));
    setEndDate(localStr(end).replace(/\//g,'-'));
    setStartDate(localStr(start).replace(/\//g,'-'));
  };

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 10, flexWrap: 'wrap' }}>
        {(['開始日期', '結束日期'] as const).map((label, i) => (
          <div key={label}>
            <label style={{ display: 'block', fontSize: '.78rem', color: SUB, marginBottom: 4, fontWeight: 500 }}>{label}</label>
            <input type="date"
              value={i === 0 ? startDate : endDate}
              onChange={e => i === 0 ? setStartDate(e.target.value) : setEndDate(e.target.value)}
              style={{ padding: '7px 12px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.87rem', fontFamily: MONO }} />
          </div>
        ))}
        <button onClick={load} disabled={loading}
          style={{ padding: '8px 22px', background: loading ? '#999' : RED, color: '#fff', border: 'none', borderRadius: 6, cursor: loading ? 'not-allowed' : 'pointer', fontSize: '.88rem', fontWeight: 600 }}>
          {loading ? '載入中…' : '載入'}
        </button>
        {loading && <span style={{ fontSize: '.8rem', color: SUB, alignSelf: 'center' }}>查詢中，統一逐日請求約需 10–20 秒…</span>}
      </div>

      {/* Quick range */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {[{ label: '近10日', days: 10 }, { label: '近20日', days: 20 }, { label: '近30日', days: 30 }].map(p => (
          <button key={p.days} onClick={() => setRange(p.days)}
            style={{ padding: '4px 12px', border: `1px solid ${BORDER}`, borderRadius: 20, background: '#fff', color: SUB, cursor: 'pointer', fontSize: '.78rem' }}>
            {p.label}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ padding: '12px 16px', background: '#fff0f0', border: '1px solid #fca5a5', borderRadius: 8, color: RED, fontSize: '.85rem', marginBottom: 14 }}>
          {error}
        </div>
      )}

      {!rows && !loading && (
        <p style={{ color: '#AAA', textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>請選擇日期區間並點擊「載入」</p>
      )}

      {rows && rows.length === 0 && (
        <p style={{ color: '#AAA', textAlign: 'center', padding: '30px 0', fontSize: '.9rem' }}>查無資料</p>
      )}

      {rows && rows.length > 0 && (
        <>
          {/* 申贖金額表 */}
          <div ref={subsRef} style={{ background: '#fff', marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: '.78rem', color: SUB }}>單位：億元　正值 = 淨申購（紅）　負值 = 淨贖回（綠）</span>
            <button onClick={() => saveImage(subsRef, `同業淨申贖_${endDate}.png`)}
              style={{ padding: '4px 12px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, cursor: 'pointer', fontSize: '.78rem', color: SUB }}>
              儲存 / 分享
            </button>
          </div>
          <div style={{ overflowX: 'auto', borderRadius: 8, border: `1px solid ${BORDER}` }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
              <thead>
                <tr>
                  <th style={{ ...TH, textAlign: 'left', minWidth: 100 }}>日期</th>
                  {ALL_TICKERS.map(t => (
                    <th key={t} style={{ ...TH, textAlign: 'right', minWidth: 100 }}>{t}<br /><span style={{ fontWeight: 400, fontSize: '.7rem', opacity: .8 }}>淨申贖(億)</span></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, ri) => (
                  <tr key={row.date} style={{ background: ri % 2 === 0 ? '#fff' : '#FAFAF9', borderBottom: `1px solid ${BORDER}` }}>
                    <td style={{ padding: '7px 12px', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>{row.date}</td>
                    {ALL_TICKERS.map(t => {
                      const d = row.data[t];
                      return (
                        <td key={t} style={{ padding: '7px 12px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', fontWeight: 600, color: subColor(d?.netSub ?? null) }}>
                          {d ? fmtSub(d.netSub) : <span style={{ color: '#CCC' }}>—</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>

          {/* 基金規模表 */}
          <div ref={aumRef} style={{ background: '#fff' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: '.78rem', color: SUB }}>基金規模</span>
            <button onClick={() => saveImage(aumRef, `同業基金規模_${endDate}.png`)}
              style={{ padding: '4px 12px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, cursor: 'pointer', fontSize: '.78rem', color: SUB }}>
              儲存 / 分享
            </button>
          </div>
          <div style={{ overflowX: 'auto', borderRadius: 8, border: `1px solid ${BORDER}` }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
              <thead>
                <tr>
                  <th style={{ ...TH, textAlign: 'left', minWidth: 100 }}>日期</th>
                  {ALL_TICKERS.map(t => (
                    <th key={t} style={{ ...TH, textAlign: 'right', minWidth: 100 }}>{t}<br /><span style={{ fontWeight: 400, fontSize: '.7rem', opacity: .8 }}>規模</span></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, ri) => (
                  <tr key={row.date} style={{ background: ri % 2 === 0 ? '#fff' : '#FAFAF9', borderBottom: `1px solid ${BORDER}` }}>
                    <td style={{ padding: '7px 12px', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>{row.date}</td>
                    {ALL_TICKERS.map(t => {
                      const d = row.data[t];
                      return (
                        <td key={t} style={{ padding: '7px 12px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', color: SUB }}>
                          {d ? fmtAum(d.aum) : <span style={{ color: '#CCC' }}>—</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>
        </>
      )}
    </div>
  );
}
