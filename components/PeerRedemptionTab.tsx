'use client';
import { useState, useCallback, useRef, useMemo } from 'react';
import * as XLSX from 'xlsx';

// 各申贖來源的回傳列形狀一致，統一用這個型別。
interface ScaleDay { date: string; netSub: number; aum: number }

const RED    = '#C00000';
const GREEN  = '#1A6B45';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

// 申贖資料來源：每檔 ETF 對應一個投信爬蟲與其 key（fundId / fundCode / stkId）。
// source 為 undefined 代表該家投信申贖爬蟲尚未接通 → 該欄一律顯示「—」。
type RedemptionSource = 'fhtrust' | 'ezmoney' | 'capital' | 'fubon' | 'tsit' | 'ctbc' | 'allianz'
                      | 'yuanta' | 'cmoney' | 'nomura' | 'cathay' | 'kgi';
interface RedemptionEtf {
  ticker: string;
  name: string;
  source?: RedemptionSource;
  key?: string;
}
// dbGroup = `peer_redemption` 表裡的 group 值。兩個台股分頁共用同一批入庫資料
// （daily_summary.py 一律寫 group='tw_active'），只是前端呈現的欄位範圍不同。
interface RedemptionGroup { id: string; label: string; dbGroup: string; etfs: RedemptionEtf[] }

const REDEMPTION_GROUPS: RedemptionGroup[] = [
  {
    id: 'tw_active',
    label: '台股主動式ETF（主要6檔）',
    dbGroup: 'tw_active',
    // 最早接通的六檔核心觀測群，維持原本的順序與口徑，不隨百億群組異動。
    etfs: [
      { ticker: '00991A', name: '復華',    source: 'fhtrust', key: 'ETF23' },
      { ticker: '00981A', name: '統一981', source: 'ezmoney', key: '49YTW' },
      { ticker: '00403A', name: '統一403', source: 'ezmoney', key: '63YTW' },
      { ticker: '00982A', name: '群益982', source: 'capital', key: '399' },
      { ticker: '00992A', name: '群益992', source: 'capital', key: '500' },
      { ticker: '00405A', name: '富邦405', source: 'fubon',   key: '00405A' },
    ],
  },
  {
    id: 'tw_active_100',
    label: '台股主動式ETF（百億以上＋擦邊3檔）',
    dbGroup: 'tw_active',
    // 依 2026-07-27 規模由大到小排。最後三檔（00985A 97.1億 / 00993A 96.5億 /
    // 00984A 94.3億）未達百億，是使用者指定要一起觀察的擦邊標的。
    etfs: [
      { ticker: '00981A', name: '統一981', source: 'ezmoney', key: '49YTW' },
      { ticker: '00403A', name: '統一403', source: 'ezmoney', key: '63YTW' },
      { ticker: '00991A', name: '復華',    source: 'fhtrust', key: 'ETF23' },
      { ticker: '00982A', name: '群益982', source: 'capital', key: '399' },
      { ticker: '00992A', name: '群益992', source: 'capital', key: '500' },
      { ticker: '00407A', name: '凱基407', source: 'kgi',     key: 'J024'   },  // 凱基投信 fundID
      { ticker: '00400A', name: '國泰400', source: 'cathay',  key: 'EA'     },  // 國泰 FundCode（申贖為推算值）
      { ticker: '00405A', name: '富邦405', source: 'fubon',   key: '00405A' },
      { ticker: '00980A', name: '野村980', source: 'nomura',  key: '00980A' },
      { ticker: '00406A', name: '中信406', source: 'ctbc',    key: 'E0038'  },  // 中信投信 FID
      { ticker: '00999A', name: '野村999', source: 'nomura',  key: '00999A' },
      { ticker: '00985A', name: '野村985', source: 'nomura',  key: '00985A' },
      { ticker: '00993A', name: '安聯993', source: 'allianz', key: 'E0002'  },  // 安聯投信 FundNo
      { ticker: '00984A', name: '安聯984', source: 'allianz', key: 'E0001'  },
    ],
  },
  {
    id: 'overseas',
    label: '海外主動式ETF',
    dbGroup: 'overseas',
    // 依 2026-07-27 規模由大到小排；前三檔（00988A 564億 / 00990A 384億 / 00997A 143億）為百億以上。
    // ⚠ 海外基金的 PCF 是交易日 +1～+2 交易日才公告（統一/群益 +2、元大 +1），所以最新一列
    //    永遠有幾欄是空的——那是「還沒公告」不是抓不到。
    etfs: [
      { ticker: '00988A', name: '統一全球創新', source: 'ezmoney', key: '61YTW'  },  // 統一 ezmoney
      { ticker: '00990A', name: '元大AI新經濟', source: 'yuanta',  key: '00990A' },  // 元大投信
      { ticker: '00997A', name: '群益美國增長', source: 'capital', key: '502'    },  // 群益 fundNo（海外 → 公告 +2）
      { ticker: '00402A', name: '安聯美國科技', source: 'allianz', key: 'E0003'  },  // 安聯投信 FundNo
      { ticker: '00998A', name: '復華全球金融', source: 'cmoney',  key: '00998A' },  // 復華無官方申贖 → CMoney 推算
      { ticker: '00983A', name: '中信ARK創新',  source: 'ctbc',    key: 'E0034'  },  // 中信投信 FID
      { ticker: '00986A', name: '台新全球龍頭', source: 'tsit',    key: '00986A' },  // 台新投信（HTML）
    ],
  },
];

type PeerSortKey = 'date' | string;

const TH: React.CSSProperties = {
  padding: '9px 12px', fontWeight: 600, fontSize: '.75rem',
  background: TEXT, color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1, letterSpacing: '.3px',
  cursor: 'pointer', userSelect: 'none',
};

function localStr(d: Date) {
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}
function prevWeekday(d: Date) {
  const r = new Date(d);
  do { r.setDate(r.getDate() - 1); } while (r.getDay() === 0 || r.getDay() === 6);
  return r;
}
// Day after a YYYY-MM-DD string, returned as YYYY-MM-DD.
function nextDay(dash: string): string {
  const d = new Date(`${dash}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return localStr(d).replace(/\//g, '-');
}
// Is there at least one weekday (Mon–Fri) within [startDash, endDash]?
function hasWeekdayInRange(startDash: string, endDash: string): boolean {
  const d = new Date(`${startDash}T00:00:00`);
  const end = new Date(`${endDash}T00:00:00`);
  while (d <= end) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) return true;
    d.setDate(d.getDate() + 1);
  }
  return false;
}
// Merge persisted DB rows with live gap-fill rows; DB wins on any date collision.
function mergeRowsPreferDb(dbRows: DayRow[], liveRows: DayRow[]): DayRow[] {
  const byDate = new Map<string, DayRow>();
  for (const r of liveRows) byDate.set(r.date, r);
  for (const r of dbRows)   byDate.set(r.date, r);
  return Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
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

// 把各來源回傳的 ScaleDay 陣列（依 ticker 分組）合併成依日期排列的 DayRow[]。
function mergeDays(perTicker: Map<string, ScaleDay[]>, tickers: string[]): DayRow[] {
  const dateSet = new Set<string>();
  perTicker.forEach(days => days.forEach(d => dateSet.add(norm(d.date))));

  const rows: DayRow[] = [];
  for (const date of Array.from(dateSet).sort()) {
    const data: DayRow['data'] = {};
    for (const ticker of tickers) {
      const d = (perTicker.get(ticker) ?? []).find(x => norm(x.date) === date);
      data[ticker] = d ? { netSub: d.netSub, aum: d.aum } : null;
    }
    rows.push({ date, data });
  }
  return rows.reverse();
}

function exportExcel(rows: DayRow[], tickers: string[], groupLabel: string, startDate: string, endDate: string) {
  const headers = ['日期', ...tickers];
  const subsData = rows.map(r => [r.date, ...tickers.map(t => r.data[t] != null ? parseFloat((r.data[t]!.netSub).toFixed(2)) : '')]);
  const aumData  = rows.map(r => [r.date, ...tickers.map(t => r.data[t] != null ? parseFloat((r.data[t]!.aum).toFixed(2))    : '')]);
  const colWidths = [{ wch: 12 }, ...tickers.map(() => ({ wch: 12 }))];
  const subsWs = XLSX.utils.aoa_to_sheet([headers, ...subsData]);
  subsWs['!cols'] = colWidths;
  const aumWs  = XLSX.utils.aoa_to_sheet([headers, ...aumData]);
  aumWs['!cols']  = colWidths;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, subsWs, '淨申贖(億)');
  XLSX.utils.book_append_sheet(wb, aumWs,  '基金規模(億)');
  XLSX.writeFile(wb, `同業申贖觀測_${groupLabel}_${startDate}_${endDate}.xlsx`);
}

export default function PeerRedemptionTab() {
  const today    = new Date();
  const defEnd   = localStr(prevWeekday(today));
  const defStart = localStr(new Date(new Date(defEnd.replace(/\//g,'-')).setDate(new Date(defEnd.replace(/\//g,'-')).getDate() - 13)));

  const [group,        setGroup]        = useState('tw_active');
  const [startDate,    setStartDate]    = useState(defStart.replace(/\//g, '-'));
  const [endDate,      setEndDate]      = useState(defEnd.replace(/\//g, '-'));
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState('');
  const [rows,         setRows]         = useState<DayRow[] | null>(null);
  const [dataSource,   setDataSource]   = useState<'db' | 'live' | 'mixed' | null>(null);
  const [subsSortKey,  setSubsSortKey]  = useState<PeerSortKey>('date');
  const [subsSortAsc,  setSubsSortAsc]  = useState(false);
  const [aumSortKey,   setAumSortKey]   = useState<PeerSortKey>('date');
  const [aumSortAsc,   setAumSortAsc]   = useState(false);
  const subsRef = useRef<HTMLDivElement>(null);
  const aumRef  = useRef<HTMLDivElement>(null);

  const currentGroup = useMemo(() => REDEMPTION_GROUPS.find(g => g.id === group) ?? REDEMPTION_GROUPS[0], [group]);
  const groupEtfs    = currentGroup.etfs;
  const allTickers   = useMemo(() => groupEtfs.map(e => e.ticker), [groupEtfs]);

  // 切換群組：清空上一組的結果與排序，避免殘留欄位。
  const switchGroup = (id: string) => {
    if (id === group) return;
    setGroup(id);
    setRows(null);
    setDataSource(null);
    setSubsSortKey('date');
    setAumSortKey('date');
  };

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

  const loadLive = useCallback(async (sdArg: string = startDate, edArg: string = endDate) => {
    const sd = toApi(sdArg);      // 斜線格式 YYYY/MM/DD（fhtrust、ezmoney）
    const ed = toApi(edArg);
    const sdDash = sdArg;         // 連字號格式 YYYY-MM-DD（capital、fubon）
    const edDash = edArg;
    const enc = encodeURIComponent;

    // 只打有接通爬蟲的 ETF；未接通者該欄維持「—」。
    const scrapeable = groupEtfs.filter(e => e.source && e.key);
    const results = await Promise.all(scrapeable.map(async (e) => {
      let url = '';
      switch (e.source) {
        case 'fhtrust': url = `/api/etf-scale?startDate=${enc(sd)}&endDate=${enc(ed)}&fundId=${enc(e.key!)}`; break;
        case 'ezmoney': url = `/api/ezmoney-scale?fundCode=${enc(e.key!)}&startDate=${enc(sd)}&endDate=${enc(ed)}`; break;
        case 'capital': url = `/api/capital-scale?fundId=${enc(e.key!)}&startDate=${enc(sdDash)}&endDate=${enc(edDash)}`; break;
        case 'fubon':   url = `/api/fubon-scale?stkId=${enc(e.key!)}&startDate=${enc(sdDash)}&endDate=${enc(edDash)}`; break;
        // 海外群組（皆用 key 參數 + dash 日期）
        case 'tsit':    url = `/api/tsit-scale?key=${enc(e.key!)}&startDate=${enc(sdDash)}&endDate=${enc(edDash)}`; break;
        case 'ctbc':    url = `/api/ctbc-scale?key=${enc(e.key!)}&startDate=${enc(sdDash)}&endDate=${enc(edDash)}`; break;
        case 'allianz': url = `/api/allianz-scale?key=${enc(e.key!)}&startDate=${enc(sdDash)}&endDate=${enc(edDash)}`; break;
        case 'yuanta':  url = `/api/yuanta-scale?key=${enc(e.key!)}&startDate=${enc(sdDash)}&endDate=${enc(edDash)}`; break;
        case 'nomura':  url = `/api/nomura-scale?key=${enc(e.key!)}&startDate=${enc(sdDash)}&endDate=${enc(edDash)}`; break;
        case 'cathay':  url = `/api/cathay-scale?key=${enc(e.key!)}&startDate=${enc(sdDash)}&endDate=${enc(edDash)}`; break;
        case 'kgi':     url = `/api/kgi-scale?key=${enc(e.key!)}&startDate=${enc(sdDash)}&endDate=${enc(edDash)}`; break;
        case 'cmoney':  url = `/api/cmoney-scale?key=${enc(e.key!)}&startDate=${enc(sdDash)}&endDate=${enc(edDash)}`; break;
      }
      const r = await fetch(url);
      return { ticker: e.ticker, data: r.ok ? (await r.json() as ScaleDay[]) : [] };
    }));

    const perTicker = new Map(results.map(({ ticker, data }) => [ticker, data]));
    return mergeDays(perTicker, allTickers);
  }, [startDate, endDate, groupEtfs, allTickers]);

  const load = useCallback(async (forceLive = false) => {
    setLoading(true);
    setError('');
    setRows(null);
    setDataSource(null);
    try {
      if (!forceLive) {
        const r = await fetch(`/api/peer-redemption-db?group=${encodeURIComponent(currentGroup.dbGroup)}&startDate=${startDate}&endDate=${endDate}`);
        if (r.ok) {
          const json = await r.json();
          const dbRows: DayRow[] = json.rows ?? [];
          if (dbRows.length > 0) {
            // DB has data, but the most recent trading day(s) in range may not be
            // persisted yet (today's run, or a day the scheduler skipped). Detect a
            // tail gap beyond the newest DB date and live-fill just that gap — otherwise
            // DB-only silently drops today whenever the range also covers an older day.
            const maxDbDate = dbRows.reduce((m, row) => (row.date > m ? row.date : m), dbRows[0].date);
            const gapStart = nextDay(maxDbDate);
            if (gapStart <= endDate && hasWeekdayInRange(gapStart, endDate)) {
              const liveRows = await loadLive(gapStart, endDate);
              const fresh = liveRows.filter(lr => lr.date > maxDbDate);
              if (fresh.length > 0) {
                setRows(mergeRowsPreferDb(dbRows, fresh));
                setDataSource('mixed');
                return;
              }
            }
            setRows(dbRows);
            setDataSource('db');
            return;
          }
        }
      }
      // DB miss or forceLive → live fetch
      const liveRows = await loadLive();
      setRows(liveRows);
      setDataSource('live');
    } catch (e) {
      setError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, currentGroup.dbGroup, loadLive]);

  // Quick range
  const setRange = (days: number) => {
    const end   = prevWeekday(today);
    const start = new Date(end);
    start.setDate(start.getDate() - (days - 1));
    setEndDate(localStr(end).replace(/\//g,'-'));
    setStartDate(localStr(start).replace(/\//g,'-'));
  };

  const toggleSubsSort = (key: PeerSortKey) => {
    if (key === subsSortKey) setSubsSortAsc(p => !p);
    else { setSubsSortKey(key); setSubsSortAsc(false); }
  };
  const toggleAumSort = (key: PeerSortKey) => {
    if (key === aumSortKey) setAumSortAsc(p => !p);
    else { setAumSortKey(key); setAumSortAsc(false); }
  };
  const subsLabel = (key: PeerSortKey, label: string) =>
    subsSortKey === key ? `${label} ${subsSortAsc ? '↑' : '↓'}` : label;
  const aumLabel = (key: PeerSortKey, label: string) =>
    aumSortKey === key ? `${label} ${aumSortAsc ? '↑' : '↓'}` : label;

  const sortedSubsRows = useMemo(() => {
    if (!rows) return [];
    return [...rows].sort((a, b) => {
      if (subsSortKey === 'date') return subsSortAsc ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
      const av = a.data[subsSortKey]?.netSub ?? null;
      const bv = b.data[subsSortKey]?.netSub ?? null;
      if (av === null && bv === null) return 0;
      if (av === null) return subsSortAsc ? -1 : 1;
      if (bv === null) return subsSortAsc ? 1 : -1;
      return subsSortAsc ? av - bv : bv - av;
    });
  }, [rows, subsSortKey, subsSortAsc]);

  const sortedAumRows = useMemo(() => {
    if (!rows) return [];
    return [...rows].sort((a, b) => {
      if (aumSortKey === 'date') return aumSortAsc ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
      const av = a.data[aumSortKey]?.aum ?? null;
      const bv = b.data[aumSortKey]?.aum ?? null;
      if (av === null && bv === null) return 0;
      if (av === null) return aumSortAsc ? -1 : 1;
      if (bv === null) return aumSortAsc ? 1 : -1;
      return aumSortAsc ? av - bv : bv - av;
    });
  }, [rows, aumSortKey, aumSortAsc]);

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>

      {/* Group selector */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {REDEMPTION_GROUPS.map(g => {
          const on = g.id === group;
          return (
            <button key={g.id} onClick={() => switchGroup(g.id)} disabled={loading}
              style={{
                padding: '6px 16px', borderRadius: 20, cursor: loading ? 'not-allowed' : 'pointer',
                fontSize: '.82rem', fontWeight: 600,
                border: on ? `1px solid ${RED}` : `1px solid ${BORDER}`,
                background: on ? RED : '#fff', color: on ? '#fff' : SUB,
              }}>
              {g.label}
            </button>
          );
        })}
      </div>

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
        <button onClick={() => load(false)} disabled={loading}
          style={{ padding: '8px 22px', background: loading ? '#999' : RED, color: '#fff', border: 'none', borderRadius: 6, cursor: loading ? 'not-allowed' : 'pointer', fontSize: '.88rem', fontWeight: 600 }}>
          {loading ? '載入中…' : '載入'}
        </button>
        {!loading && (
          <button onClick={() => load(true)} disabled={loading}
            style={{ padding: '8px 16px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, cursor: 'pointer', fontSize: '.82rem', color: SUB, fontWeight: 500 }}>
            強制即時查詢
          </button>
        )}
        {loading && dataSource === null && <span style={{ fontSize: '.8rem', color: SUB, alignSelf: 'center' }}>查詢資料庫中…</span>}
        {loading && dataSource === 'live' && <span style={{ fontSize: '.8rem', color: SUB, alignSelf: 'center' }}>即時查詢中，約需 10–20 秒…</span>}
        {dataSource === 'db'    && !loading && <span style={{ padding: '3px 10px', background: '#dcfce7', color: '#166534', borderRadius: 12, fontSize: '.75rem', fontWeight: 600, alignSelf: 'center' }}>資料庫</span>}
        {dataSource === 'live'  && !loading && <span style={{ padding: '3px 10px', background: '#fff7ed', color: '#92400e', borderRadius: 12, fontSize: '.75rem', fontWeight: 600, alignSelf: 'center' }}>即時查詢</span>}
        {dataSource === 'mixed' && !loading && <span style={{ padding: '3px 10px', background: '#eef2ff', color: '#3730a3', borderRadius: 12, fontSize: '.75rem', fontWeight: 600, alignSelf: 'center' }}>資料庫＋即時</span>}
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
          {/* Export button */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button
              onClick={() => exportExcel(rows, allTickers, currentGroup.label, startDate, endDate)}
              style={{ padding: '6px 16px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, cursor: 'pointer', fontSize: '.8rem', color: SUB, fontFamily: SANS, fontWeight: 500 }}
            >
              ↓ 匯出 Excel（兩張工作表）
            </button>
          </div>

          {/* 申贖金額表 */}
          <div ref={subsRef} style={{ background: '#fff', marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: '.78rem', color: SUB }}>單位：億元　正值 = 淨申購（紅）　負值 = 淨贖回（綠）</span>
            <button onClick={() => saveImage(subsRef, `同業淨申贖_${currentGroup.label}_${endDate}.png`)}
              style={{ padding: '4px 12px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, cursor: 'pointer', fontSize: '.78rem', color: SUB }}>
              儲存 / 分享
            </button>
          </div>
          <div style={{ overflowX: 'auto', borderRadius: 8, border: `1px solid ${BORDER}` }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
              <thead>
                <tr>
                  <th onClick={() => toggleSubsSort('date')} style={{ ...TH, textAlign: 'left', minWidth: 100 }}>{subsLabel('date', '日期')}</th>
                  {allTickers.map(t => (
                    <th key={t} onClick={() => toggleSubsSort(t)} style={{ ...TH, textAlign: 'right', minWidth: 100 }}>
                      {subsSortKey === t ? subsLabel(t, t) : t}<br />
                      <span style={{ fontWeight: 400, fontSize: '.7rem', opacity: .8 }}>淨申贖(億)</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedSubsRows.map((row, ri) => (
                  <tr key={row.date} style={{ background: ri % 2 === 0 ? '#fff' : '#FAFAF9', borderBottom: `1px solid ${BORDER}` }}>
                    <td style={{ padding: '7px 12px', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>{row.date}</td>
                    {allTickers.map(t => {
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
            <button onClick={() => saveImage(aumRef, `同業基金規模_${currentGroup.label}_${endDate}.png`)}
              style={{ padding: '4px 12px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, cursor: 'pointer', fontSize: '.78rem', color: SUB }}>
              儲存 / 分享
            </button>
          </div>
          <div style={{ overflowX: 'auto', borderRadius: 8, border: `1px solid ${BORDER}` }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
              <thead>
                <tr>
                  <th onClick={() => toggleAumSort('date')} style={{ ...TH, textAlign: 'left', minWidth: 100 }}>{aumLabel('date', '日期')}</th>
                  {allTickers.map(t => (
                    <th key={t} onClick={() => toggleAumSort(t)} style={{ ...TH, textAlign: 'right', minWidth: 100 }}>
                      {aumSortKey === t ? aumLabel(t, t) : t}<br />
                      <span style={{ fontWeight: 400, fontSize: '.7rem', opacity: .8 }}>規模</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedAumRows.map((row, ri) => (
                  <tr key={row.date} style={{ background: ri % 2 === 0 ? '#fff' : '#FAFAF9', borderBottom: `1px solid ${BORDER}` }}>
                    <td style={{ padding: '7px 12px', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>{row.date}</td>
                    {allTickers.map(t => {
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
