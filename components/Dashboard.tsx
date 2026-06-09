'use client';
import { useState, useCallback, useRef, forwardRef } from 'react';
import { Holding } from '@/lib/types';
import { StockPerformance } from '@/lib/yahooFinance';
import { ETF_LIST, EtfConfig, DEFAULT_ETF } from '@/lib/etfList';
import HoldingsTab from './HoldingsTab';
import CompareTab from './CompareTab';
import DailySummaryTab from './DailySummaryTab';
import CountryTab from './CountryTab';
import PerformanceTab from './PerformanceTab';
import Prediction0050Tab from './Prediction0050Tab';
import ScaleTab from './ScaleTab';
import PeerRedemptionTab from './PeerRedemptionTab';
import PeerPerformanceTab from './PeerPerformanceTab';

/* ── Design tokens ── */
const RED    = '#C00000';
const GOLD   = '#B08F6E';
const BG     = '#F0EDE8';
const CARD   = '#FFFFFF';
const HEADER = '#F7F4F0';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#E8E3DF';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

type Tab = 'holdings' | 'compare' | 'summary' | 'country' | 'performance' | 'pred0050' | 'scale' | 'peer' | 'peerperf';
interface LoadedData { date: string; holdings: Holding[] }
interface PerfData { date: string; results: StockPerformance[] }

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
function defaultDate(): string {
  const now = new Date();
  // Taiwan time = UTC+8
  const twHour = new Date(now.getTime() + 8 * 3600 * 1000).getUTCHours();
  // Before 17:00 Taiwan time, holdings data hasn't updated yet → use previous trading day
  const base = twHour < 17 ? prevTradingDay(now) : now;
  const day = base.getDay();
  if (day === 0 || day === 6) return localStr(prevTradingDay(base));
  return localStr(base);
}
function prevDay(): string {
  return localStr(prevTradingDay(new Date(defaultDate())));
}
function toApiDate(s: string) { return s.replace(/-/g, '/'); }

/* ── Shared UI ── */
function DateInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: '.78rem', color: SUB, marginBottom: 4, fontWeight: 500 }}>
        {label}
      </label>
      <input
        type="date" value={value} onChange={e => onChange(e.target.value)}
        style={{
          padding: '7px 12px', border: `1px solid ${BORDER}`, borderRadius: 6,
          fontSize: '.87rem', color: TEXT, background: CARD,
          fontFamily: MONO,
        }}
      />
    </div>
  );
}

function ActionButton({ onClick, loading, label }: { onClick: () => void; loading: boolean; label: string }) {
  return (
    <button
      onClick={onClick} disabled={loading}
      style={{
        padding: '8px 22px',
        background: loading ? '#999' : RED,
        color: '#fff', border: 'none', borderRadius: 6,
        cursor: loading ? 'not-allowed' : 'pointer',
        fontSize: '.88rem', fontWeight: 600, letterSpacing: '.3px',
        fontFamily: SANS,
      }}
    >
      {loading ? '載入中…' : label}
    </button>
  );
}

function ErrorMsg({ msg, onReset }: { msg: string; onReset?: () => void }) {
  if (!msg) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14,
      background: '#FFF5F5', border: '1px solid #FFCDD2', borderRadius: 6, padding: '10px 14px' }}>
      <span style={{ color: RED, fontSize: '.88rem', flex: 1 }}>⚠ {msg}</span>
      {onReset && (
        <button onClick={onReset} style={{
          padding: '4px 14px', background: '#fff', border: `1px solid ${BORDER}`,
          borderRadius: 5, cursor: 'pointer', fontSize: '.8rem', color: SUB,
          whiteSpace: 'nowrap', fontFamily: SANS,
        }}>重新選擇日期</button>
      )}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p style={{ color: '#AAA', textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>{text}</p>;
}

const Card = forwardRef<HTMLDivElement, { title: string; children: React.ReactNode; onSave?: () => void }>(
  ({ title, children, onSave }, ref) => (
    <div ref={ref} style={{ background: CARD, borderRadius: 10, padding: '20px 22px', boxShadow: '0 1px 6px rgba(0,0,0,.07)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <h2 style={{
          margin: 0, fontSize: '1rem', fontWeight: 700, color: TEXT,
          borderLeft: `3px solid ${RED}`, paddingLeft: 12, lineHeight: '1.3',
        }}>
          {title}
        </h2>
        {onSave && (
          <button onClick={onSave} style={{
            padding: '5px 14px', background: CARD, color: SUB,
            border: `1px solid ${BORDER}`, borderRadius: 6,
            cursor: 'pointer', fontSize: '.78rem', fontWeight: 500, fontFamily: SANS,
          }}>
            儲存 / 分享
          </button>
        )}
      </div>
      {children}
    </div>
  )
);
Card.displayName = 'Card';

/* ── Main Dashboard ── */
export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<Tab>('summary');
  const [selectedEtf, setSelectedEtf] = useState<EtfConfig>(DEFAULT_ETF);

  const [holdDate,    setHoldDate]    = useState(defaultDate());
  const [holdData,    setHoldData]    = useState<LoadedData | null>(null);
  const [holdLoading, setHoldLoading] = useState(false);
  const [holdError,   setHoldError]   = useState('');

  const [baseDate,   setBaseDate]   = useState(defaultDate());
  const [cmpDate,    setCmpDate]    = useState(prevDay());
  const [baseData,   setBaseData]   = useState<LoadedData | null>(null);
  const [cmpData,    setCmpData]    = useState<LoadedData | null>(null);
  const [cmpLoading, setCmpLoading] = useState(false);
  const [cmpError,   setCmpError]   = useState('');

  const [perfDate,    setPerfDate]    = useState(defaultDate());
  const [perfData,    setPerfData]    = useState<PerfData | null>(null);
  const [perfLoading, setPerfLoading] = useState(false);
  const [perfError,   setPerfError]   = useState('');

  const holdingsRef   = useRef<HTMLDivElement>(null);
  const summaryRef    = useRef<HTMLDivElement>(null);
  const compareRef    = useRef<HTMLDivElement>(null);
  const countryRef    = useRef<HTMLDivElement>(null);
  const performanceRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async (dateStr: string, fundId: string): Promise<LoadedData> => {
    const res  = await fetch(`/api/holdings?date=${encodeURIComponent(toApiDate(dateStr))}&fundId=${encodeURIComponent(fundId)}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? '載入失敗');
    return json as LoadedData;
  }, []);

  const loadHoldings = useCallback(async () => {
    setHoldLoading(true); setHoldError('');
    try   { setHoldData(await fetchData(holdDate, selectedEtf.fundId)); }
    catch (e) { setHoldError(e instanceof Error ? e.message : '載入失敗'); }
    finally   { setHoldLoading(false); }
  }, [holdDate, selectedEtf, fetchData]);

  const loadCompare = useCallback(async () => {
    setCmpLoading(true); setCmpError('');
    try {
      const [b, c] = await Promise.all([fetchData(baseDate, selectedEtf.fundId), fetchData(cmpDate, selectedEtf.fundId)]);
      setBaseData(b); setCmpData(c);
    } catch (e) { setCmpError(e instanceof Error ? e.message : '載入失敗'); }
    finally     { setCmpLoading(false); }
  }, [baseDate, cmpDate, selectedEtf, fetchData]);

  const loadPerformance = useCallback(async () => {
    setPerfLoading(true); setPerfError('');
    try {
      const res  = await fetch(`/api/performance?date=${encodeURIComponent(toApiDate(perfDate))}&fundId=${encodeURIComponent(selectedEtf.fundId)}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? '載入失敗');
      setPerfData(json as PerfData);
    } catch (e) { setPerfError(e instanceof Error ? e.message : '載入失敗'); }
    finally     { setPerfLoading(false); }
  }, [perfDate, selectedEtf]);

  const handleEtfChange = useCallback((ticker: string) => {
    const etf = ETF_LIST.find(e => e.ticker === ticker) ?? DEFAULT_ETF;
    setSelectedEtf(etf);
    setHoldData(null); setBaseData(null); setCmpData(null); setPerfData(null);
    setHoldError(''); setCmpError(''); setPerfError('');
  }, []);

  const saveImage = useCallback(async (ref: React.RefObject<HTMLDivElement | null>, filename: string) => {
    const el = ref.current;
    if (!el) return;
    try {
      await document.fonts.ready;
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
      const jpgName = filename.replace(/\.png$/, '.jpg');

      // 優先用 Web Share API（手機可直接分享到 LINE）
      if (typeof navigator !== 'undefined' && navigator.canShare) {
        try {
          const blob = await new Promise<Blob>((res) => canvas.toBlob(b => res(b!), 'image/jpeg', 0.92));
          const file = new File([blob], jpgName, { type: 'image/jpeg' });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ title: '復華主動式ETF 持股資訊', files: [file] });
            return;
          }
        } catch { /* 使用者取消或不支援，改下載 */ }
      }

      // Fallback：下載 JPG
      const link = document.createElement('a');
      link.download = jpgName;
      link.href = canvas.toDataURL('image/jpeg', 0.92);
      link.click();
    } catch (e) { console.error('截圖失敗', e); }
  }, []);

  const imgName = (label: string) => `${selectedEtf.ticker}_${label}_${holdDate}.png`;

  const TABS: { id: Tab; label: string }[] = [
    { id: 'summary',     label: '當日摘要' },
    { id: 'holdings',    label: '當天持股清單' },
    { id: 'compare',     label: '持股比較' },
    { id: 'country',     label: '國家配置' },
    { id: 'performance', label: '股價表現' },
    { id: 'pred0050',    label: '0050 季調預測' },
    { id: 'scale',       label: '規模變化' },
    { id: 'peer',        label: '同業申贖觀測' },
    { id: 'peerperf',   label: '同業績效觀測' },
  ];

  return (
    <div style={{ minHeight: '100vh', background: BG, fontFamily: SANS }}>

      {/* ── Sticky Header ── */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 100,
        background: HEADER, borderBottom: `3px solid ${RED}`,
        height: 64,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 28px',
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.22rem', fontWeight: 700, letterSpacing: '.3px', color: TEXT, lineHeight: 1.25, fontFamily: SANS }}>
            <span style={{ color: RED }}>復華</span>主動式ETF 持股資訊
          </h1>
          <p style={{ margin: 0, fontSize: '.76rem', color: SUB, marginTop: 2 }}>
            {selectedEtf.ticker}&nbsp;{selectedEtf.name}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '.78rem', color: SUB, fontWeight: 500 }}>基金</span>
          <select
            value={selectedEtf.ticker}
            onChange={e => handleEtfChange(e.target.value)}
            style={{
              padding: '6px 10px', borderRadius: 6, border: `1px solid ${BORDER}`,
              background: CARD, color: TEXT, fontSize: '.85rem',
              cursor: 'pointer', fontFamily: SANS,
            }}
          >
            {ETF_LIST.map(e => (
              <option key={e.ticker} value={e.ticker}>{e.ticker}</option>
            ))}
          </select>
        </div>
      </header>

      {/* ── Navigation ── */}
      <nav style={{ background: CARD, borderBottom: `1px solid ${BORDER}`, padding: '0 24px', display: 'flex', overflowX: 'auto' }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            style={{
              padding: '13px 22px', border: 'none', background: 'transparent', cursor: 'pointer',
              fontSize: '.9rem', fontWeight: activeTab === t.id ? 600 : 400,
              color: activeTab === t.id ? RED : SUB,
              borderBottom: `2.5px solid ${activeTab === t.id ? RED : 'transparent'}`,
              marginBottom: -1, transition: 'all .15s', fontFamily: SANS,
              flexShrink: 0, whiteSpace: 'nowrap',
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* ── Content ── */}
      <main style={{ padding: '20px 24px' }}>

        {activeTab === 'holdings' && (
          <Card
            ref={holdingsRef} title="持股清單"
            onSave={holdData ? () => saveImage(holdingsRef, imgName('持股清單')) : undefined}
          >
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 18, flexWrap: 'wrap' }}>
              <DateInput label="資料日期" value={holdDate} onChange={setHoldDate} />
              <ActionButton onClick={loadHoldings} loading={holdLoading} label="載入" />
            </div>
            <ErrorMsg msg={holdError} onReset={() => { setHoldError(''); setHoldData(null); }} />
            {holdData
              ? <HoldingsTab holdings={holdData.holdings} date={holdData.date} />
              : !holdLoading && <EmptyHint text="請選擇日期並點擊「載入」" />
            }
          </Card>
        )}

        {activeTab === 'compare' && (
          <Card
            ref={compareRef} title="持股比較"
            onSave={baseData && cmpData ? () => saveImage(compareRef, imgName('持股比較')) : undefined}
          >
            <div style={{ display: 'flex', gap: 20, alignItems: 'flex-end', marginBottom: 18, flexWrap: 'wrap' }}>
              <DateInput label="基準日期" value={baseDate} onChange={setBaseDate} />
              <DateInput label="比較日期" value={cmpDate}  onChange={setCmpDate} />
              <ActionButton onClick={loadCompare} loading={cmpLoading} label="載入比較" />
            </div>
            <ErrorMsg msg={cmpError} onReset={() => { setCmpError(''); setBaseData(null); setCmpData(null); }} />
            {baseData && cmpData
              ? <CompareTab baseDate={baseData.date} cmpDate={cmpData.date} baseHoldings={baseData.holdings} cmpHoldings={cmpData.holdings} />
              : !cmpLoading && <EmptyHint text="請選擇兩個日期並點擊「載入比較」" />
            }
          </Card>
        )}

        {activeTab === 'summary' && (
          <Card ref={summaryRef} title="當日摘要" onSave={baseData && cmpData ? () => saveImage(summaryRef, imgName('當日摘要')) : undefined}>
            {baseData && cmpData
              ? <DailySummaryTab
                  baseDate={baseData.date}
                  cmpDate={cmpData.date}
                  baseHoldings={baseData.holdings}
                  cmpHoldings={cmpData.holdings}
                  fundId={selectedEtf.fundId}
                  yfTicker={selectedEtf.yfTicker}
                />
              : (
                <div style={{ textAlign: 'center', padding: '40px 0' }}>
                  <p style={{ color: '#AAA', fontSize: '.9rem', marginBottom: 18 }}>請先在「持股比較」頁面選擇日期並載入資料</p>
                  <div style={{ display: 'flex', gap: 20, justifyContent: 'center', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <DateInput label="基準日期" value={baseDate} onChange={setBaseDate} />
                    <DateInput label="比較日期" value={cmpDate}  onChange={setCmpDate} />
                    <ActionButton onClick={loadCompare} loading={cmpLoading} label="載入比較" />
                  </div>
                  <ErrorMsg msg={cmpError} onReset={() => { setCmpError(''); setBaseData(null); setCmpData(null); }} />
                </div>
              )
            }
          </Card>
        )}

        {activeTab === 'country' && (
          <Card
            ref={countryRef} title="國家 / 資產配置"
            onSave={holdData ? () => saveImage(countryRef, imgName('國家配置')) : undefined}
          >
            {holdData
              ? <>
                  <p style={{ fontSize: '.82rem', color: SUB, marginBottom: 16, marginTop: 0 }}>資料來源：持股清單 {holdData.date}</p>
                  <CountryTab holdings={holdData.holdings} />
                </>
              : (
                <div style={{ textAlign: 'center', padding: '40px 0' }}>
                  <p style={{ color: '#AAA', fontSize: '.9rem', marginBottom: 18 }}>請先在「當天持股清單」頁面載入資料</p>
                  <div style={{ display: 'flex', gap: 12, justifyContent: 'center', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <DateInput label="日期" value={holdDate} onChange={setHoldDate} />
                    <ActionButton
                      onClick={async () => { setActiveTab('holdings'); await loadHoldings(); setActiveTab('country'); }}
                      loading={holdLoading} label="載入"
                    />
                  </div>
                  <ErrorMsg msg={holdError} onReset={() => { setHoldError(''); setHoldData(null); }} />
                </div>
              )
            }
          </Card>
        )}

        {activeTab === 'performance' && (
          <Card
            ref={performanceRef} title="持股股價表現"
            onSave={perfData ? () => saveImage(performanceRef, `${selectedEtf.ticker}_股價表現_${perfDate}.png`) : undefined}
          >
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 18, flexWrap: 'wrap' }}>
              <DateInput label="持股日期" value={perfDate} onChange={setPerfDate} />
              <ActionButton onClick={loadPerformance} loading={perfLoading} label="載入" />
              {perfData && !perfLoading && (
                <button
                  onClick={loadPerformance}
                  style={{
                    padding: '8px 18px', background: '#fff', color: RED,
                    border: `1.5px solid ${RED}`, borderRadius: 6,
                    cursor: 'pointer', fontSize: '.88rem', fontWeight: 600, fontFamily: SANS,
                  }}
                >
                  更新現價
                </button>
              )}
              {perfLoading && (
                <span style={{ fontSize: '.8rem', color: SUB, alignSelf: 'center' }}>
                  查詢 Yahoo Finance 中，約需 15–30 秒…
                </span>
              )}
            </div>
            <ErrorMsg msg={perfError} onReset={() => { setPerfError(''); setPerfData(null); }} />
            {perfData
              ? <PerformanceTab results={perfData.results} date={perfData.date} etfTicker={selectedEtf.ticker} />
              : !perfLoading && <EmptyHint text="請選擇日期並點擊「載入」" />
            }
          </Card>
        )}

        {activeTab === 'pred0050' && (
          <Card title="0050 季調預測">
            <Prediction0050Tab />
          </Card>
        )}

        {activeTab === 'scale' && (
          <Card title="規模變化">
            <ScaleTab key={selectedEtf.fundId} fundId={selectedEtf.fundId} />
          </Card>
        )}

        {activeTab === 'peer' && (
          <Card title="同業申贖觀測">
            <PeerRedemptionTab />
          </Card>
        )}

        {activeTab === 'peerperf' && (
          <Card title="同業績效觀測">
            <PeerPerformanceTab />
          </Card>
        )}
      </main>
    </div>
  );
}
