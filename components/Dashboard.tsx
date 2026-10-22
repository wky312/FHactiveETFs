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
import DailyChangeTab from './DailyChangeTab';
import PeerPerformanceTab from './PeerPerformanceTab';
import StockTrajectoryTab from './StockTrajectoryTab';
import ScorecardTab from './ScorecardTab';
import CumulativeReturnTab from './CumulativeReturnTab';
import StockAttributionTab from './StockAttributionTab';
import MarketImpactTab from './MarketImpactTab';
import TopHoldingsTab from './TopHoldingsTab';
import RiskTab from './RiskTab';
import TurnoverTab from './TurnoverTab';
import ConsensusTab from './ConsensusTab';
import SectorExposureTab from './SectorExposureTab';
import SectorHeatmapTab from './SectorHeatmapTab';
import UnitWatchTab from './UnitWatchTab';
import BeneficiaryTab from './BeneficiaryTab';
import MarketCapRankingTab from './MarketCapRankingTab';
import NewHighTab from './NewHighTab';
import Top300YtdTab from './Top300YtdTab';
import Top350EtfTab from './Top350EtfTab';
import BreakIssueTab from './BreakIssueTab';
import MarketCalendarTab from './MarketCalendarTab';
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

type Tab = 'holdings' | 'compare' | 'summary' | 'country' | 'performance' | 'trajectory' | 'scorecard' | 'marketscorecard' | 'pred0050' | 'scale' | 'peer' | 'dailychange' | 'peerperf' | 'cumret' | 'stockattr' | 'impact' | 'top10' | 'risk' | 'turnover' | 'consensus' | 'sector' | 'sectorheatmap' | 'unitwatch' | 'beneficiary' | 'mktcap150' | 'newhigh150' | 'top300ytd' | 'top350etf' | 'breakissue' | 'calendar';

/* 舊分頁 id → 合併後的新 id（讓分享出去的舊連結不會直接壞掉，掉回首頁）。
   對應的子範圍（台股/美股、國內/海外）由各自的合併元件自己讀 URL 上的舊 tab 值還原，見
   MarketImpactTab.tsx / StockAttributionTab.tsx。 */
const LEGACY_TAB_MAP: Record<string, Tab> = {
  attribution: 'stockattr', oseasattr: 'stockattr',
  usimpact: 'impact', twimpact: 'impact',
};

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
    { id: 'stockattr', label: '個股歸因' },
    { id: 'impact', label: '收盤影響' },
    { id: 'sectorheatmap', label: '產業熱力圖' },
  ] },
  { label: '選股與預測', items: [
    { id: 'scorecard',       label: '選股對帳單' },
    { id: 'marketscorecard', label: '全市場總覽（19檔）' },
    { id: 'pred0050',        label: '0050 季調預測' },
  ] },
  { label: '同業觀測', items: [
    { id: 'peer',      label: '同業申贖觀測' },
    { id: 'dailychange', label: '同業當日加減碼' },
    { id: 'peerperf',  label: '同業績效觀測' },
    { id: 'turnover',  label: '經理人換手率' },
    { id: 'consensus', label: '共識持股' },
    { id: 'top10',     label: '前十大持股' },
    { id: 'sector',    label: '族群曝險' },
    { id: 'beneficiary', label: '受益人數' },
  ] },
  { label: '其他', items: [
    { id: 'unitwatch', label: '單位數注意商品' },
    { id: 'breakissue', label: '掛牌破發追蹤' },
    { id: 'mktcap150', label: '市值前150大漲跌排行' },
    { id: 'newhigh150', label: '創新高強勢股' },
    { id: 'top300ytd', label: '前300大YTD還原權息追蹤' },
    { id: 'top350etf', label: '前350大 × 主動ETF持有' },
  ] },
  { label: '市場行事曆', items: [
    { id: 'calendar', label: '重要行事曆' },
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
/* 預設的「基準日／比較日」。lag = 該檔持股落後幾個交易日（EtfConfig.holdingsLag）：
   海外檔今天查不到今天的持股，基準日要再往前推一個交易日，比較日則是基準日的前一個交易日。 */
function defaultDates(lag = 0): { base: string; cmp: string } {
  const now = new Date();
  // Taiwan time = UTC+8
  const twHour = new Date(now.getTime() + 8 * 3600 * 1000).getUTCHours();
  // Before 17:00 Taiwan time, holdings data hasn't updated yet → use previous trading day
  let base = twHour < 17 ? prevTradingDay(now) : now;
  if (base.getDay() === 0 || base.getDay() === 6) base = prevTradingDay(base);
  for (let i = 0; i < lag; i++) base = prevTradingDay(base);
  return { base: localStr(base), cmp: localStr(prevTradingDay(base)) };
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
      onClick={() => onClick()} disabled={loading}
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

/* 基金切換：放在各分頁卡片標題下方，一眼看得到目前是哪一檔、點一下就換。
   原本是頁首左上角的下拉選單，使用者回饋不直覺（不知道那是切換基金用的）。 */
function FundPicker({ value, onChange }: { value: string; onChange: (ticker: string) => void }) {
  return (
    <div role="radiogroup" aria-label="選擇基金" className="fund-pills">
      {ETF_LIST.map(e => {
        const sel = e.ticker === value;
        return (
          <button
            key={e.ticker} type="button" role="radio" aria-checked={sel}
            onClick={() => { if (!sel) onChange(e.ticker); }}
            className={`fund-pill${sel ? ' is-active' : ''}`}
          >
            <span className="fund-pill-code">{e.ticker}</span>
            <span className="fund-pill-name">{e.short}</span>
          </button>
        );
      })}
    </div>
  );
}

const Card = forwardRef<HTMLDivElement, { title: string; children: React.ReactNode; onSave?: () => void; picker?: React.ReactNode }>(
  ({ title, children, onSave, picker }, ref) => (
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
      {picker}
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

  /* 深連結：進站時依網址 ?tab= / ?etf= 還原「分頁 + 基金」，切換任一個都寫回網址，
     這樣分享出去的連結才分得出是哪一檔基金的哪一頁（只帶 ?tab= 的話對方永遠開到預設的 00991A）。
     刻意在 effect 裡還原而不是用 useState 初始值：初始值在 SSR 讀不到 window，
     client 讀得到就會 hydration mismatch。 */
  // 網址還原出來的基金，給下方「進站自動載入」用——不能在那邊重讀網址：下一個 effect 會先把
  // 網址同步成 state 的初始值（00991A），讀到的就不是使用者連進來的那檔了。
  const initialEtfRef = useRef<EtfConfig>(DEFAULT_ETF);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const t = sp.get('tab') as Tab | null;
    const e = sp.get('etf');
    const etf = e ? ETF_LIST.find(x => x.ticker === e.trim().toUpperCase()) : undefined;
    const mappedT = t && LEGACY_TAB_MAP[t] ? LEGACY_TAB_MAP[t] : t;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 一次性還原網址狀態，不會串連渲染
    if (mappedT && ALL_TABS.includes(mappedT)) setActiveTab(mappedT);
    if (etf) setSelectedEtf(etf);
    initialEtfRef.current = etf ?? DEFAULT_ETF;
  }, []);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('tab') !== activeTab || sp.get('etf') !== selectedEtf.ticker) {
      sp.set('tab', activeTab);
      sp.set('etf', selectedEtf.ticker);
      window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`);
    }
  }, [activeTab, selectedEtf]);

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

  const [holdDate,    setHoldDate]    = useState(() => defaultDates().base);
  const [holdData,    setHoldData]    = useState<LoadedData | null>(null);
  const [holdLoading, setHoldLoading] = useState(false);
  const [holdError,   setHoldError]   = useState('');

  const [baseDate,   setBaseDate]   = useState(() => defaultDates().base);
  const [cmpDate,    setCmpDate]    = useState(() => defaultDates().cmp);
  const [baseData,   setBaseData]   = useState<LoadedData | null>(null);
  const [cmpData,    setCmpData]    = useState<LoadedData | null>(null);
  const [cmpLoading, setCmpLoading] = useState(false);
  const [cmpError,   setCmpError]   = useState('');

  const [perfDate,    setPerfDate]    = useState(() => defaultDates().base);
  const [perfData,    setPerfData]    = useState<PerfData | null>(null);
  const [perfLoading, setPerfLoading] = useState(false);
  const [perfError,   setPerfError]   = useState('');

  const holdingsRef   = useRef<HTMLDivElement>(null);
  const summaryRef    = useRef<HTMLDivElement>(null);
  const compareRef    = useRef<HTMLDivElement>(null);
  const countryRef    = useRef<HTMLDivElement>(null);
  /* 國家配置分頁下方那份持股清單自己的 ref——與「當天持股清單」分頁的 holdingsRef 分開，
     這樣兩張卡片可以各自存成一張圖（國家配置一張、持股清單一張）。 */
  const countryHoldingsRef = useRef<HTMLDivElement>(null);
  const performanceRef = useRef<HTMLDivElement>(null);
  const newHighRef    = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async (dateStr: string, fundId: string, force = false): Promise<LoadedData> => {
    const qs = `date=${encodeURIComponent(toApiDate(dateStr))}&fundId=${encodeURIComponent(fundId)}${force ? '&force=1' : ''}`;
    const res  = await fetch(`/api/holdings?${qs}`, force ? { cache: 'no-store' } : undefined);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? '載入失敗');
    return json as LoadedData;
  }, []);

  /* 載入函式可指定 etf：切換基金的當下 selectedEtf 這個 state 還沒更新，要直接帶新的那檔進來。
     每次載入遞增序號、回來時序號不符就丟掉——連點不同基金時，慢回來的舊請求不會蓋掉新的。 */
  const holdSeq = useRef(0), cmpSeq = useRef(0), perfSeq = useRef(0);

  const loadHoldings = useCallback(async (force = false, etf: EtfConfig = selectedEtf, date: string = holdDate) => {
    const seq = ++holdSeq.current;
    setHoldLoading(true); setHoldError('');
    try {
      const d = await fetchData(date, etf.fundId, force);
      if (seq === holdSeq.current) setHoldData(d);
    } catch (e) { if (seq === holdSeq.current) setHoldError(e instanceof Error ? e.message : '載入失敗'); }
    finally     { if (seq === holdSeq.current) setHoldLoading(false); }
  }, [holdDate, selectedEtf, fetchData]);

  const loadCompare = useCallback(async (force = false, etf: EtfConfig = selectedEtf,
                                        base: string = baseDate, cmp: string = cmpDate) => {
    const seq = ++cmpSeq.current;
    setCmpLoading(true); setCmpError('');
    try {
      const [b, c] = await Promise.all([
        fetchData(base, etf.fundId, force),
        fetchData(cmp, etf.fundId, force),
      ]);
      if (seq === cmpSeq.current) { setBaseData(b); setCmpData(c); }
    } catch (e) { if (seq === cmpSeq.current) setCmpError(e instanceof Error ? e.message : '載入失敗'); }
    finally     { if (seq === cmpSeq.current) setCmpLoading(false); }
  }, [baseDate, cmpDate, selectedEtf, fetchData]);

  const loadPerformance = useCallback(async (etf: EtfConfig = selectedEtf) => {
    const seq = ++perfSeq.current;
    setPerfLoading(true); setPerfError('');
    try {
      const res  = await fetch(`/api/performance?date=${encodeURIComponent(toApiDate(perfDate))}&fundId=${encodeURIComponent(etf.fundId)}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? '載入失敗');
      if (seq === perfSeq.current) setPerfData(json as PerfData);
    } catch (e) { if (seq === perfSeq.current) setPerfError(e instanceof Error ? e.message : '載入失敗'); }
    finally     { if (seq === perfSeq.current) setPerfLoading(false); }
  }, [perfDate, selectedEtf]);

  /* 依分頁重新載入「那一頁要的資料」。基金選單搬進各分頁後，切換基金就該直接看到新基金的內容，
     不再清空後要使用者自己找「載入」按鈕。股價表現要打 Yahoo 15–30 秒，不自動跑，維持手動。 */
  const reloadFor = useCallback((tab: Tab, etf: EtfConfig, d: { base: string; cmp: string }) => {
    if (tab === 'summary' || tab === 'compare') loadCompare(false, etf, d.base, d.cmp);
    else if (tab === 'holdings' || tab === 'country') loadHoldings(false, etf, d.base);
  }, [loadCompare, loadHoldings]);

  /* 換基金時日期一律重設成那檔的預設值（國內/海外可查到的最新日不同）；回傳新日期給呼叫端直接用，
     因為 setState 要到下一輪 render 才生效。 */
  const resetDatesFor = useCallback((etf: EtfConfig) => {
    const d = defaultDates(etf.holdingsLag);
    setHoldDate(d.base); setBaseDate(d.base); setCmpDate(d.cmp); setPerfDate(d.base);
    return d;
  }, []);

  // 進站自動載入：等網址上的 ?tab= / ?etf= 還原完，用還原後的基金載入（原本固定先載 00991A，
  // 用 ?etf=00998A 進站會拿到 00991A 的資料、卻標成 00998A）。只跑一次；失敗則靜默，使用者仍可手動載入。
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (autoLoadedRef.current) return;
    autoLoadedRef.current = true;
    const etf = initialEtfRef.current;
    const d = resetDatesFor(etf);
    loadCompare(false, etf, d.base, d.cmp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEtfChange = useCallback((ticker: string) => {
    const etf = ETF_LIST.find(e => e.ticker === ticker) ?? DEFAULT_ETF;
    setSelectedEtf(etf);
    setHoldData(null); setBaseData(null); setCmpData(null); setPerfData(null);
    setHoldError(''); setCmpError(''); setPerfError('');
    reloadFor(activeTab, etf, resetDatesFor(etf));
  }, [activeTab, reloadFor, resetDatesFor]);

  const fundPicker = <FundPicker value={selectedEtf.ticker} onChange={handleEtfChange} />;

  const saveImage = useCallback(async (ref: React.RefObject<HTMLDivElement | null>, filename: string) => {
    if (!ref.current) return;
    // 共用截圖工具：截圖前自動把寬表格攤平成全寬，避免存圖被切欄位
    await captureAndShare(ref.current, filename, '復華主動式ETF 持股資訊');
  }, []);

  const imgName = (label: string) => `${selectedEtf.ticker}_${label}_${holdDate}.png`;

  return (
    <div style={{ minHeight: '100vh', background: BG, fontFamily: SANS }}>

      {/* ── Sticky Header ──
           基金選單已搬進各分頁卡片（FundPicker），頁首只留標題。 */}
      <header className="site-header">
        <div style={{ minWidth: 0 }}>
          <h1 className="site-title">
            <span style={{ color: RED }}>復華</span>主動式ETF 持股資訊
          </h1>
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
            ref={holdingsRef} title="持股清單" picker={fundPicker}
            onSave={holdData ? () => saveImage(holdingsRef, imgName('持股清單')) : undefined}
          >
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 18, flexWrap: 'wrap' }}>
              <DateInput label="資料日期" value={holdDate} onChange={setHoldDate} />
              <ActionButton onClick={() => loadHoldings()} loading={holdLoading} label="載入" />
              <ActionButton onClick={() => loadHoldings(true)} loading={holdLoading} label="強制查詢最新資料" />
            </div>
            <ErrorMsg msg={holdError} onReset={() => { setHoldError(''); setHoldData(null); }} />
            {holdData
              ? <HoldingsTab holdings={holdData.holdings} date={holdData.date} etfTicker={selectedEtf.ticker} fundId={selectedEtf.fundId} />
              : !holdLoading && <EmptyHint text="請選擇日期並點擊「載入」" />
            }
          </Card>
        )}

        {activeTab === 'compare' && (
          <Card
            ref={compareRef} title="持股比較" picker={fundPicker}
            onSave={baseData && cmpData ? () => saveImage(compareRef, imgName('持股比較')) : undefined}
          >
            <div style={{ display: 'flex', gap: 20, alignItems: 'flex-end', marginBottom: 18, flexWrap: 'wrap' }}>
              <DateInput label="比較日期" value={cmpDate}  onChange={setCmpDate} />
              <DateInput label="基準日期" value={baseDate} onChange={setBaseDate} />
              <ActionButton onClick={() => loadCompare()} loading={cmpLoading} label="載入比較" />
              <ActionButton onClick={() => loadCompare(true)} loading={cmpLoading} label="強制查詢最新資料" />
            </div>
            <ErrorMsg msg={cmpError} onReset={() => { setCmpError(''); setBaseData(null); setCmpData(null); }} />
            {baseData && cmpData
              ? <CompareTab baseDate={baseData.date} cmpDate={cmpData.date} baseHoldings={baseData.holdings} cmpHoldings={cmpData.holdings} etfTicker={selectedEtf.ticker} />
              : !cmpLoading && <EmptyHint text="請選擇兩個日期並點擊「載入比較」" />
            }
          </Card>
        )}

        {activeTab === 'summary' && (
          <Card ref={summaryRef} title="當日摘要" picker={fundPicker} onSave={baseData && cmpData ? () => saveImage(summaryRef, imgName('當日摘要')) : undefined}>
            {baseData && cmpData
              ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
                    <ActionButton onClick={() => loadCompare(true)} loading={cmpLoading} label="強制查詢最新資料" />
                  </div>
                  <DailySummaryTab
                    baseDate={baseData.date}
                    cmpDate={cmpData.date}
                    baseHoldings={baseData.holdings}
                    cmpHoldings={cmpData.holdings}
                    fundId={selectedEtf.fundId}
                    yfTicker={selectedEtf.yfTicker}
                    etfTicker={selectedEtf.ticker}
                  />
                </>
              )
              : (
                <div style={{ textAlign: 'center', padding: '40px 0' }}>
                  <p style={{ color: '#AAA', fontSize: '.9rem', marginBottom: 18 }}>請先在「持股比較」頁面選擇日期並載入資料</p>
                  <div style={{ display: 'flex', gap: 20, justifyContent: 'center', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <DateInput label="基準日期" value={baseDate} onChange={setBaseDate} />
                    <DateInput label="比較日期" value={cmpDate}  onChange={setCmpDate} />
                    <ActionButton onClick={() => loadCompare()} loading={cmpLoading} label="載入比較" />
                    <ActionButton onClick={() => loadCompare(true)} loading={cmpLoading} label="強制查詢最新資料" />
                  </div>
                  <ErrorMsg msg={cmpError} onReset={() => { setCmpError(''); setBaseData(null); setCmpData(null); }} />
                </div>
              )
            }
          </Card>
        )}

        {activeTab === 'country' && (holdData ? (
          /* 兩張獨立的卡片：一頁看完國家配置＋持股清單，但「儲存 / 分享」各存各的圖。 */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <Card
              ref={countryRef} title="國家 / 資產配置" picker={fundPicker}
              onSave={() => saveImage(countryRef, imgName('國家配置'))}
            >
              <p style={{ fontSize: '.82rem', color: SUB, marginBottom: 16, marginTop: 0 }}>資料來源：持股清單 {holdData.date}</p>
              <CountryTab holdings={holdData.holdings} date={holdData.date} etfTicker={selectedEtf.ticker} />
            </Card>
            <Card
              ref={countryHoldingsRef} title="持股清單"
              onSave={() => saveImage(countryHoldingsRef, imgName('持股清單'))}
            >
              <HoldingsTab holdings={holdData.holdings} date={holdData.date} etfTicker={selectedEtf.ticker} fundId={selectedEtf.fundId} />
            </Card>
          </div>
        ) : (
          <Card ref={countryRef} title="國家 / 資產配置" picker={fundPicker}>
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
          </Card>
        ))}

        {activeTab === 'performance' && (
          <Card
            ref={performanceRef} title="持股股價表現" picker={fundPicker}
            onSave={perfData ? () => saveImage(performanceRef, `${selectedEtf.ticker}_股價表現_${perfDate}.png`) : undefined}
          >
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 18, flexWrap: 'wrap' }}>
              <DateInput label="持股日期" value={perfDate} onChange={setPerfDate} />
              <ActionButton onClick={() => loadPerformance()} loading={perfLoading} label="載入" />
              {perfData && !perfLoading && (
                <button
                  onClick={() => loadPerformance()}
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
          <Card title="個股持股軌跡" picker={fundPicker}>
            <StockTrajectoryTab selectedEtf={selectedEtf} />
          </Card>
        )}

        {activeTab === 'scorecard' && (
          <Card title="經理人選股對帳單" picker={fundPicker}>
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
          <Card title="規模變化" picker={fundPicker}>
            <ScaleTab key={selectedEtf.fundId} fundId={selectedEtf.fundId} etfTicker={selectedEtf.ticker} />
          </Card>
        )}

        {activeTab === 'peer' && (
          <Card title="同業申贖觀測">
            <PeerRedemptionTab />
          </Card>
        )}

        {activeTab === 'dailychange' && (
          <Card title="同業當日加減碼">
            <DailyChangeTab />
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

        {activeTab === 'sectorheatmap' && (
          <Card title="產業熱力圖">
            <SectorHeatmapTab />
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

        {activeTab === 'stockattr' && (
          <Card title="個股歸因比較">
            <StockAttributionTab />
          </Card>
        )}

        {activeTab === 'impact' && (
          <Card title="收盤影響">
            <MarketImpactTab />
          </Card>
        )}

        {activeTab === 'top10' && (
          <Card title="前十大持股">
            <TopHoldingsTab />
          </Card>
        )}

        {activeTab === 'unitwatch' && (
          <Card title="單位數注意商品">
            <UnitWatchTab />
          </Card>
        )}

        {activeTab === 'breakissue' && (
          <Card title="主動式ETF 掛牌破發追蹤與觀察">
            <BreakIssueTab />
          </Card>
        )}

        {activeTab === 'beneficiary' && (
          <Card title="受益人數（集保股權分散表）">
            <BeneficiaryTab />
          </Card>
        )}

        {activeTab === 'mktcap150' && (
          <Card title="市值前150大漲跌排行">
            <MarketCapRankingTab />
          </Card>
        )}

        {activeTab === 'newhigh150' && (
          <Card
            ref={newHighRef} title="創新高強勢股"
            onSave={() => saveImage(newHighRef, `00991A_創新高強勢股_${localStr(new Date())}.png`)}
          >
            <NewHighTab />
          </Card>
        )}

        {activeTab === 'top300ytd' && (
          <Card title="前300大YTD還原權息追蹤">
            <Top300YtdTab />
          </Card>
        )}

        {activeTab === 'top350etf' && (
          <Card title="市值前350大 × 主動ETF持有">
            <Top350EtfTab />
          </Card>
        )}

        {activeTab === 'calendar' && (
          <Card title="市場重要行事曆">
            <MarketCalendarTab />
          </Card>
        )}
      </main>
    </div>
  );
}
