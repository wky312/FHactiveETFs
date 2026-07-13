'use client';
import { useState, useCallback, useRef, useEffect, forwardRef } from 'react';
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
import StockTrajectoryTab from './StockTrajectoryTab';
import ScorecardTab from './ScorecardTab';
import CumulativeReturnTab from './CumulativeReturnTab';
import AttributionTab from './AttributionTab';
import RiskTab from './RiskTab';
import TurnoverTab from './TurnoverTab';
import ConsensusTab from './ConsensusTab';
import SectorExposureTab from './SectorExposureTab';
import { captureAndShare } from '@/lib/captureImage';

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

type Tab = 'holdings' | 'compare' | 'summary' | 'country' | 'performance' | 'trajectory' | 'scorecard' | 'marketscorecard' | 'pred0050' | 'scale' | 'peer' | 'peerperf' | 'cumret' | 'attribution' | 'risk' | 'turnover' | 'consensus' | 'sector';

/* 頂部導覽分組（13 個分頁收進 4 個下拉選單；不改各分頁邏輯，只改呈現） */
const NAV_GROUPS: { label: string; items: { id: Tab; label: string }[] }[] = [
  { label: '持股分析', items: [
    { id: 'summary',  label: '當日摘要' },
    { id: 'holdings', label: '當天持股清單' },
    { id: 'compare',  label: '持股比較' },
    { id: 'country',  label: '國家配置' },
    { id: 'scale',    label: '規模變化' },
  ] },
  { label: '個股與績效', items: [
    { id: 'performance', label: '股價表現' },
    { id: 'trajectory',  label: '個股軌跡' },
    { id: 'cumret',      label: '累積報酬走勢' },
    { id: 'risk',        label: '風險指標' },
    { id: 'attribution', label: '績效個股歸因' },
  ] },
  { label: '選股與預測', items: [
    { id: 'scorecard',       label: '選股對帳單' },
    { id: 'marketscorecard', label: '全市場總覽（19檔）' },
    { id: 'pred0050',        label: '0050 季調預測' },
  ] },
  { label: '同業觀測', items: [
    { id: 'peer',      label: '同業申贖觀測' },
    { id: 'peerperf',  label: '同業績效觀測' },
    { id: 'turnover',  label: '經理人換手率' },
    { id: 'consensus', label: '共識持股' },
    { id: 'sector',    label: '族群曝險' },
  ] },
];

interface LoadedData { date: string; holdings: Holding[] }
interface PerfData { date: string; results: StockPerformance[]; benchmarks?: StockPerformance[] }

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
const ALL_TABS = NAV_GROUPS.flatMap(g => g.items.map(it => it.id));

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<Tab>('summary');
  const [selectedEtf, setSelectedEtf] = useState<EtfConfig>(DEFAULT_ETF);

  // 深連結：進站時依網址 ?tab= 還原分頁，切換時寫回網址，方便把特定分頁分享給別人。
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab') as Tab | null;
    if (t && ALL_TABS.includes(t)) setActiveTab(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('tab') !== activeTab) {
      sp.set('tab', activeTab);
      window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`);
    }
  }, [activeTab]);

  // 導覽下拉：開啟中的分組 index、hover 中的項目 key；外部點擊或 Esc 關閉
  const [openGroup, setOpenGroup] = useState<number | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (openGroup === null) return;
    const onDocClick = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpenGroup(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenGroup(null); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [openGroup]);

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

  // 進站自動載入最近交易日的「當日摘要」資料，讓落地頁直接有內容（只跑一次；失敗則靜默，使用者仍可手動載入）
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (autoLoadedRef.current) return;
    autoLoadedRef.current = true;
    loadCompare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEtfChange = useCallback((ticker: string) => {
    const etf = ETF_LIST.find(e => e.ticker === ticker) ?? DEFAULT_ETF;
    setSelectedEtf(etf);
    setHoldData(null); setBaseData(null); setCmpData(null); setPerfData(null);
    setHoldError(''); setCmpError(''); setPerfError('');
  }, []);

  const saveImage = useCallback(async (ref: React.RefObject<HTMLDivElement | null>, filename: string) => {
    if (!ref.current) return;
    // 共用截圖工具：截圖前自動把寬表格攤平成全寬，避免存圖被切欄位
    await captureAndShare(ref.current, filename, '復華主動式ETF 持股資訊');
  }, []);

  const imgName = (label: string) => `${selectedEtf.ticker}_${label}_${holdDate}.png`;

  return (
    <div style={{ minHeight: '100vh', background: BG, fontFamily: SANS }}>

      {/* ── Sticky Header ── */}
      <header className="site-header">
        <div style={{ minWidth: 0 }}>
          <h1 className="site-title">
            <span style={{ color: RED }}>復華</span>主動式ETF 持股資訊
          </h1>
          <p className="site-sub">
            {selectedEtf.ticker}&nbsp;{selectedEtf.name}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
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

      {/* ── Navigation：4 個功能分組下拉選單 ── */}
      <nav ref={navRef} style={{ background: CARD, borderBottom: `1px solid ${BORDER}`, padding: '0 24px', display: 'flex', flexWrap: 'wrap', position: 'relative' }}>
        {NAV_GROUPS.map((g, gi) => {
          const groupActive = g.items.some(it => it.id === activeTab);
          const open = openGroup === gi;
          const alignRight = gi >= 2;   // 右側分組往左展開，避免窄螢幕溢出
          return (
            <div key={g.label} style={{ position: 'relative' }}>
              <button
                onClick={() => setOpenGroup(open ? null : gi)}
                aria-haspopup="true" aria-expanded={open}
                style={{
                  padding: '13px 22px', border: 'none', background: 'transparent', cursor: 'pointer',
                  fontSize: '.9rem', fontWeight: groupActive ? 600 : 400,
                  color: groupActive ? RED : SUB,
                  borderBottom: `2.5px solid ${groupActive ? RED : 'transparent'}`,
                  marginBottom: -1, transition: 'all .15s', fontFamily: SANS,
                  whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6,
                }}
              >
                {g.label}
                <span style={{ fontSize: '.7rem', transition: 'transform .15s', transform: open ? 'rotate(180deg)' : 'none' }}>▾</span>
              </button>
              {open && (
                <div role="menu" style={{
                  position: 'absolute', top: '100%', ...(alignRight ? { right: 0 } : { left: 0 }),
                  minWidth: 180, maxWidth: 'calc(100vw - 32px)',
                  background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8,
                  boxShadow: '0 1px 6px rgba(0,0,0,.07)', padding: 6, zIndex: 200,
                }}>
                  {g.items.map(it => {
                    const sel = activeTab === it.id;
                    const key = `${gi}-${it.id}`;
                    const hov = hoverKey === key;
                    return (
                      <button
                        key={it.id} role="menuitem"
                        onClick={() => { setActiveTab(it.id); setOpenGroup(null); }}
                        onMouseEnter={() => setHoverKey(key)} onMouseLeave={() => setHoverKey(null)}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          padding: '9px 14px', border: 'none', borderRadius: 6, cursor: 'pointer',
                          fontSize: '.88rem', fontFamily: SANS, whiteSpace: 'nowrap',
                          fontWeight: sel ? 600 : 400,
                          color: sel ? RED : TEXT,
                          background: sel ? BG : hov ? HEADER : 'transparent',
                        }}
                      >
                        {it.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
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
              ? <HoldingsTab holdings={holdData.holdings} date={holdData.date} etfTicker={selectedEtf.ticker} />
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
              <DateInput label="比較日期" value={cmpDate}  onChange={setCmpDate} />
              <DateInput label="基準日期" value={baseDate} onChange={setBaseDate} />
              <ActionButton onClick={loadCompare} loading={cmpLoading} label="載入比較" />
            </div>
            <ErrorMsg msg={cmpError} onReset={() => { setCmpError(''); setBaseData(null); setCmpData(null); }} />
            {baseData && cmpData
              ? <CompareTab baseDate={baseData.date} cmpDate={cmpData.date} baseHoldings={baseData.holdings} cmpHoldings={cmpData.holdings} etfTicker={selectedEtf.ticker} />
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
                  etfTicker={selectedEtf.ticker}
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
                  <CountryTab holdings={holdData.holdings} date={holdData.date} etfTicker={selectedEtf.ticker} />
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
              ? <PerformanceTab results={perfData.results} benchmarks={perfData.benchmarks} date={perfData.date} etfTicker={selectedEtf.ticker} fundId={selectedEtf.fundId} />
              : !perfLoading && <EmptyHint text="請選擇日期並點擊「載入」" />
            }
          </Card>
        )}

        {activeTab === 'trajectory' && (
          <Card title="個股持股軌跡">
            <StockTrajectoryTab selectedEtf={selectedEtf} />
          </Card>
        )}

        {activeTab === 'scorecard' && (
          <Card title="經理人選股對帳單">
            <ScorecardTab selectedEtf={selectedEtf} />
          </Card>
        )}

        {activeTab === 'marketscorecard' && (
          <Card title="全市場主動式ETF總覽（19 檔）">
            <ScorecardTab selectedEtf={selectedEtf} initialMode="market" />
          </Card>
        )}

        {activeTab === 'pred0050' && (
          <Card title="0050 季調預測">
            <Prediction0050Tab />
          </Card>
        )}

        {activeTab === 'scale' && (
          <Card title="規模變化">
            <ScaleTab key={selectedEtf.fundId} fundId={selectedEtf.fundId} etfTicker={selectedEtf.ticker} />
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

        {activeTab === 'turnover' && (
          <Card title="經理人換手率">
            <TurnoverTab />
          </Card>
        )}

        {activeTab === 'consensus' && (
          <Card title="共識持股 / 獨家壓注">
            <ConsensusTab />
          </Card>
        )}

        {activeTab === 'sector' && (
          <Card title="族群曝險（全市場主動式 ETF）">
            <SectorExposureTab />
          </Card>
        )}

        {activeTab === 'cumret' && (
          <Card title="累積報酬走勢圖">
            <CumulativeReturnTab />
          </Card>
        )}

        {activeTab === 'risk' && (
          <Card title="風險與風險調整後報酬">
            <RiskTab />
          </Card>
        )}

        {activeTab === 'attribution' && (
          <Card title="績效個股歸因比較">
            <AttributionTab />
          </Card>
        )}
      </main>
    </div>
  );
}
