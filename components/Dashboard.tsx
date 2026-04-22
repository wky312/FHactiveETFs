'use client';
import { useState, useCallback } from 'react';
import { Holding } from '@/lib/types';
import HoldingsTab from './HoldingsTab';
import CompareTab from './CompareTab';
import CountryTab from './CountryTab';

const RED    = '#C00000';
const GREY   = '#4D4D4F';
const GREY_D = '#2D2D2F';
const GOLD   = '#B08F6E';

type Tab = 'holdings' | 'compare' | 'country';

interface LoadedData { date: string; holdings: Holding[] }

function todayStr() { return new Date().toISOString().slice(0, 10); }
function prevDay()   {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}
function toApiDate(s: string) { return s.replace(/-/g, '/'); }

/* ── Shared sub-components ── */
function DateInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: '.82rem', color: '#777', marginBottom: 5 }}>{label}</label>
      <input
        type="date" value={value} onChange={e => onChange(e.target.value)}
        style={{ padding: '7px 12px', border: '1px solid #CCC', borderRadius: 5, fontSize: '.88rem', color: GREY_D }}
      />
    </div>
  );
}

function ActionButton({ onClick, loading, label }: { onClick: () => void; loading: boolean; label: string }) {
  return (
    <button
      onClick={onClick} disabled={loading}
      style={{
        padding: '8px 22px', background: loading ? '#999' : RED,
        color: '#fff', border: 'none', borderRadius: 5,
        cursor: loading ? 'not-allowed' : 'pointer', fontSize: '.9rem', fontWeight: 600,
      }}
    >
      {loading ? '載入中…' : label}
    </button>
  );
}

function ErrorMsg({ msg }: { msg: string }) {
  return msg ? <p style={{ color: RED, marginBottom: 12, fontSize: '.9rem' }}>⚠ {msg}</p> : null;
}

function EmptyHint({ text }: { text: string }) {
  return <p style={{ color: '#999', textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>{text}</p>;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#fff', borderRadius: 8, padding: '18px 20px', boxShadow: '0 2px 8px rgba(0,0,0,.07)' }}>
      <div style={{ borderBottom: `2px solid ${RED}`, paddingBottom: 10, marginBottom: 16, fontWeight: 600, color: GREY_D, fontSize: '1rem' }}>
        {title}
      </div>
      {children}
    </div>
  );
}

/* ── Main Dashboard ── */
export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<Tab>('holdings');

  // Tab 1: Holdings & Country (shared data)
  const [holdDate,    setHoldDate]    = useState(todayStr());
  const [holdData,    setHoldData]    = useState<LoadedData | null>(null);
  const [holdLoading, setHoldLoading] = useState(false);
  const [holdError,   setHoldError]   = useState('');

  // Tab 2: Compare
  const [baseDate,    setBaseDate]    = useState(todayStr());
  const [cmpDate,     setCmpDate]     = useState(prevDay());
  const [baseData,    setBaseData]    = useState<LoadedData | null>(null);
  const [cmpData,     setCmpData]     = useState<LoadedData | null>(null);
  const [cmpLoading,  setCmpLoading]  = useState(false);
  const [cmpError,    setCmpError]    = useState('');

  const fetchData = useCallback(async (dateStr: string): Promise<LoadedData> => {
    const res  = await fetch(`/api/holdings?date=${encodeURIComponent(toApiDate(dateStr))}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? '載入失敗');
    return json as LoadedData;
  }, []);

  const loadHoldings = useCallback(async () => {
    setHoldLoading(true); setHoldError('');
    try   { setHoldData(await fetchData(holdDate)); }
    catch (e) { setHoldError(e instanceof Error ? e.message : '載入失敗'); }
    finally   { setHoldLoading(false); }
  }, [holdDate, fetchData]);

  const loadCompare = useCallback(async () => {
    setCmpLoading(true); setCmpError('');
    try {
      const [b, c] = await Promise.all([fetchData(baseDate), fetchData(cmpDate)]);
      setBaseData(b); setCmpData(c);
    } catch (e) { setCmpError(e instanceof Error ? e.message : '載入失敗'); }
    finally     { setCmpLoading(false); }
  }, [baseDate, cmpDate, fetchData]);

  const TABS: { id: Tab; label: string }[] = [
    { id: 'holdings', label: '當天持股清單' },
    { id: 'compare',  label: '持股比較' },
    { id: 'country',  label: '國家配置' },
  ];

  return (
    <div style={{ minHeight: '100vh', background: '#F5F5F5', fontFamily: "'Segoe UI', Arial, sans-serif" }}>

      {/* Header */}
      <div style={{ background: GREY, borderBottom: `4px solid ${GOLD}`, padding: '18px 28px', color: '#fff' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, letterSpacing: '.5px', margin: 0 }}>
          00998A &nbsp;復華全球金融股票主動式ETF
        </h1>
        <p style={{ fontSize: '.85rem', opacity: .72, marginTop: 5, marginBottom: 0 }}>持股分析報告</p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', background: GREY_D, padding: '0 20px', borderBottom: `2px solid ${RED}` }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            padding: '12px 26px', border: 'none', background: 'transparent', cursor: 'pointer',
            color: activeTab === t.id ? '#fff' : 'rgba(255,255,255,.55)',
            fontWeight: activeTab === t.id ? 600 : 400, fontSize: '.92rem',
            borderBottom: `3px solid ${activeTab === t.id ? GOLD : 'transparent'}`,
            marginBottom: -2, transition: 'all .15s',
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding: 20 }}>

        {/* ① 持股清單 */}
        {activeTab === 'holdings' && (
          <Card title="持股清單">
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap' }}>
              <DateInput label="日期" value={holdDate} onChange={setHoldDate} />
              <ActionButton onClick={loadHoldings} loading={holdLoading} label="載入" />
            </div>
            <ErrorMsg msg={holdError} />
            {holdData
              ? <HoldingsTab holdings={holdData.holdings} date={holdData.date} />
              : !holdLoading && <EmptyHint text="請選擇日期並點擊「載入」" />
            }
          </Card>
        )}

        {/* ② 持股比較 */}
        {activeTab === 'compare' && (
          <Card title="持股比較">
            <div style={{ display: 'flex', gap: 20, alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap' }}>
              <DateInput label="基準日期" value={baseDate} onChange={setBaseDate} />
              <DateInput label="比較日期" value={cmpDate}  onChange={setCmpDate}  />
              <ActionButton onClick={loadCompare} loading={cmpLoading} label="載入比較" />
            </div>
            <ErrorMsg msg={cmpError} />
            {baseData && cmpData
              ? <CompareTab baseDate={baseData.date} cmpDate={cmpData.date} baseHoldings={baseData.holdings} cmpHoldings={cmpData.holdings} />
              : !cmpLoading && <EmptyHint text="請選擇兩個日期並點擊「載入比較」" />
            }
          </Card>
        )}

        {/* ③ 國家配置（共用持股清單的資料） */}
        {activeTab === 'country' && (
          <Card title="國家 / 資產配置">
            {holdData
              ? <>
                  <p style={{ fontSize: '.85rem', color: '#777', marginBottom: 16 }}>資料來源：持股清單 {holdData.date}</p>
                  <CountryTab holdings={holdData.holdings} />
                </>
              : (
                <div style={{ textAlign: 'center', padding: '40px 0' }}>
                  <p style={{ color: '#999', fontSize: '.9rem', marginBottom: 16 }}>
                    請先在「當天持股清單」頁面載入資料
                  </p>
                  <div style={{ display: 'flex', gap: 12, justifyContent: 'center', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <DateInput label="日期" value={holdDate} onChange={setHoldDate} />
                    <ActionButton onClick={async () => { setActiveTab('holdings'); await loadHoldings(); setActiveTab('country'); }} loading={holdLoading} label="載入" />
                  </div>
                  <ErrorMsg msg={holdError} />
                </div>
              )
            }
          </Card>
        )}

      </div>
    </div>
  );
}
