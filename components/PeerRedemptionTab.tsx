'use client';
import { useState, useCallback, useRef, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { captureAndShare } from '@/lib/captureImage';

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
// 與 scripts/daily_summary.py 的 _SOURCE_FETCHERS 一一對應；加新來源兩邊都要加。
type RedemptionSource = 'fhtrust' | 'ezmoney' | 'capital' | 'fubon' | 'tsit' | 'ctbc' | 'allianz'
                      | 'yuanta' | 'cmoney' | 'nomura' | 'cathay' | 'kgi' | 'jpmorgan'
                      | 'ab' | 'fsitc' | 'sinopac' | 'mega';
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
    id: 'tw_active_all',
    label: '台股主動式ETF（全部23檔）',
    dbGroup: 'tw_active',
    /* 全市場台股型主動式ETF —— 基準是 TWSE/TPEx 的 ISIN 清單（`C_public.jsp?strMode=2|4`
       篩 `^00\d{3}A$`），2026-10-02 稽核出全市場 22 檔台股型，其中 17 檔已接通申贖來源。
       上面兩組是刻意的策展（核心六檔／百億以上），這一組才是「全貌」——想看大檔資金流看上面，
       想確認有沒有漏標的看這裡，兩者互不干擾。
       依 2026-10-02 規模由大到小排。2026-10-03 起 **22/22 全覆蓋**（最後五檔接通：聯博
       00404A、第一金 00994A/00408A、永豐 00410A、兆豐 00996A）。
       ⚠ 永豐與兆豐的官網**只拿得到最新一期**（無日期參數），所以它們只有 2026-10-02 之後的
         紀錄，往前翻會是空的——那是來源沒有歷史，不是抓不到。 */
    etfs: [
      { ticker: '00981A', name: '統一981', source: 'ezmoney',  key: '49YTW' },
      { ticker: '00403A', name: '統一403', source: 'ezmoney',  key: '63YTW' },
      { ticker: '00991A', name: '復華991', source: 'fhtrust',  key: 'ETF23' },
      { ticker: '00406A', name: '中信406', source: 'ctbc',     key: 'E0038' },
      { ticker: '00982A', name: '群益982', source: 'capital',  key: '399' },
      { ticker: '00992A', name: '群益992', source: 'capital',  key: '500' },
      { ticker: '00400A', name: '國泰400', source: 'cathay',   key: 'EA' },
      { ticker: '00405A', name: '富邦405', source: 'fubon',    key: '00405A' },
      { ticker: '00407A', name: '凱基407', source: 'kgi',      key: 'J024' },
      { ticker: '00980A', name: '野村980', source: 'nomura',   key: '00980A' },
      { ticker: '00985A', name: '野村985', source: 'nomura',   key: '00985A' },
      { ticker: '00999A', name: '野村999', source: 'nomura',   key: '00999A' },
      { ticker: '00993A', name: '安聯993', source: 'allianz',  key: 'E0002' },
      { ticker: '00984A', name: '安聯984', source: 'allianz',  key: 'E0001' },
      // 以下三檔 2026-10-02 才接通（投信早就有抓取器、只缺 key）。
      { ticker: '00995A', name: '中信995', source: 'ctbc',     key: 'E0036' },
      { ticker: '00401A', name: '摩根401', source: 'jpmorgan', key: 'TW00000401A1' },
      { ticker: '00987A', name: '台新987', source: 'tsit',     key: '00987A' },
      // 以下五檔 2026-10-03 接通。⚠ key 是投信內部代號不是股票代號：第一金 182=00994A、
      // 183=00408A（由 FundDetail.aspx?ID= 對出來）；兆豐 23 是 WebForms 的 fund_id。
      { ticker: '00994A', name: '第一金994', source: 'fsitc',   key: '182' },
      { ticker: '00404A', name: '聯博404', source: 'ab',        key: 'TW00000404A5' },
      { ticker: '00996A', name: '兆豐996', source: 'mega',      key: '23' },
      { ticker: '00410A', name: '永豐410', source: 'sinopac',   key: '00410A' },
      { ticker: '00408A', name: '第一金408', source: 'fsitc',   key: '183' },
      // 2026-10-20 掛牌即接通：群益 fundNo 504（/CFWeb/api/etf/items 對出來）。
      { ticker: '00415A', name: '群益415', source: 'capital',   key: '504' },
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
      // 復華官方 PCF 有回 actBuyValDate（2026-08-23 實測 ETF24 完整）→ 改吃官方，不再用 CMoney 推算。
      // CMoney 的規模序列以公告日標記，海外檔會整整錯位 2 個交易日，推出來的淨申贖是假的。
      { ticker: '00998A', name: '復華全球金融', source: 'fhtrust', key: 'ETF24'  },  // 復華 fundID
      { ticker: '00983A', name: '中信ARK創新',  source: 'ctbc',    key: 'E0034'  },  // 中信投信 FID
      { ticker: '00986A', name: '台新全球龍頭', source: 'tsit',    key: '00986A' },  // 台新投信（HTML）
      // 00409A 成立 2026/08/20、掛牌 2026/09/02：掛牌當天 fhtrust ETFPcf 才開始有值（在那之前
      // 全 null），已接上官方來源；最早查得到的交易日是 2026-08-31，更早的日期本來就沒有。
      { ticker: '00409A', name: '復華全球未來50', source: 'fhtrust', key: 'ETF26' },
      // 2026-08-26 補：摩根投信官網其實有官方 PCF（product-data API），不用只靠 CMoney 反推——
      // 只是這支 API 沒有依日期查詢的能力，只回「目前最新一筆」，區間內其餘天數仍用 CMoney
      // 頂著（見 lib/jpmorganScale.ts）。規模約 12 億，是這組裡最小的一檔。
      { ticker: '00989A', name: '摩根美國科技', source: 'jpmorgan', key: 'TW00000989A5' },
      // 2026/08/26 掛牌（統一投信）。ezmoney fundCode 由 PCF 頁上的 fundCode↔代號配對查得＝64YTW。
      { ticker: '00411A', name: '統一前沿科技', source: 'ezmoney', key: '64YTW'  },
    ],
  },
  {
    id: 'hot',
    label: '熱門ETF',
    dbGroup: 'hot',
    // 被動式大型 ETF。DB 只回補到 2026-01-01（使用者指定「今年初開始」），
    // 更早的日期查詢會是空表 —— 那是沒入庫、不是抓不到。
    // 依使用者指定的順序排（非規模序）；00631L 緊接 0050，兩檔同一個標的、看的是同一批資金。
    etfs: [
      { ticker: '0050',   name: '元大台灣50',      source: 'yuanta',  key: '0050'   },
      { ticker: '00631L', name: '元大台灣50正2',   source: 'yuanta',  key: '00631L' },  // 槓桿型，PCF 形狀同 0050
      { ticker: '0056',   name: '元大高股息',      source: 'yuanta',  key: '0056'   },
      { ticker: '00878',  name: '國泰永續高股息',  source: 'cathay',  key: 'CN'     },  // 國泰 FundCode（申贖為推算值）
      { ticker: '00919',  name: '群益台灣精選高息', source: 'capital', key: '195'    },  // 群益 fundNo
      { ticker: '00929',  name: '復華台灣科技優息', source: 'fhtrust', key: 'ETF21'  },  // 復華 fundID
      { ticker: '00712',  name: '復華富時不動產',  source: 'fhtrust', key: 'ETF07'  },  // 海外 REITs → PCF 公告 +2
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
// 逐「格」合併（DB 有值者優先）。用於補「整欄缺席」的標的：DB 只存了當時已納入觀測群的
// ETF，之後才加進群組的標的，其歷史列在 DB 裡整欄都是空的——那不是日期尾巴缺口，
// mergeRowsPreferDb 這種以「列」為單位的合併補不到，必須逐格填。
function mergeCellsPreferDb(dbRows: DayRow[], liveRows: DayRow[]): DayRow[] {
  const byDate = new Map<string, DayRow>();
  for (const r of dbRows) byDate.set(r.date, { date: r.date, data: { ...r.data } });
  for (const lr of liveRows) {
    const row = byDate.get(lr.date);
    if (!row) { byDate.set(lr.date, { date: lr.date, data: { ...lr.data } }); continue; }
    for (const [ticker, cell] of Object.entries(lr.data)) {
      if (cell != null && row.data[ticker] == null) row.data[ticker] = cell;
    }
  }
  return Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
}

// 以「列」為單位合併：補日期尾巴（今天還沒入庫）的缺口，DB 在日期撞號時勝出。
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
function fmtAumDiff(v: number | null) {
  if (v === null) return '—';
  const abs = Math.abs(v);
  const unit = abs >= 10000 ? `${(abs / 10000).toFixed(2)} 兆` : `${abs.toFixed(2)} 億`;
  return v > 0 ? `+${unit}` : v < 0 ? `−${unit}` : '0 億';
}

// Unified row type
// isEstimate：正式公告出來前，從申購買回清單「預估發行受益權單位數」概算的暫定值
// （見 scripts/daily_summary.py 的 fetch_*_estimate）；只有 DB 來源會有，即時查詢一律 false。
interface DayRow {
  date: string;
  data: Record<string, { netSub: number; aum: number; isEstimate?: boolean } | null>;
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
      data[ticker] = d ? { netSub: d.netSub, aum: d.aum, isEstimate: false } : null;
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
  const defStart = localStr(new Date(new Date(defEnd.replace(/\//g,'-')).setDate(new Date(defEnd.replace(/\//g,'-')).getDate() - 4)));

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

  // 共用 captureAndShare：截圖前攤平長清單與寬表格，避免存圖被切
  const saveImage = useCallback(async (ref: React.RefObject<HTMLDivElement | null>, filename: string) => {
    const el = ref.current;
    if (!el) return;
    await captureAndShare(el, filename, '同業申贖觀測');
  }, []);

  const toApi = (s: string) => s.replace(/-/g, '/');

  const loadLive = useCallback(async (sdArg: string = startDate, edArg: string = endDate,
                                      etfsArg: RedemptionEtf[] = groupEtfs) => {
    const sd = toApi(sdArg);      // 斜線格式 YYYY/MM/DD（fhtrust、ezmoney）
    const ed = toApi(edArg);
    const sdDash = sdArg;         // 連字號格式 YYYY-MM-DD（capital、fubon）
    const edDash = edArg;
    const enc = encodeURIComponent;

    // 只打有接通爬蟲的 ETF；未接通者該欄維持「—」。
    const scrapeable = etfsArg.filter(e => e.source && e.key);
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
        case 'jpmorgan': url = `/api/jpmorgan-scale?key=${enc(e.key!)}&startDate=${enc(sdDash)}&endDate=${enc(edDash)}`; break;
      }
      const r = await fetch(url);
      return { ticker: e.ticker, data: r.ok ? (await r.json() as ScaleDay[]) : [] };
    }));

    const perTicker = new Map(results.map(({ ticker, data }) => [ticker, data]));
    return mergeDays(perTicker, scrapeable.map(e => e.ticker));
  }, [startDate, endDate, groupEtfs]);

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
            let merged = dbRows;
            let filled = false;

            const maxDbDate = dbRows.reduce((m, row) => (row.date > m ? row.date : m), dbRows[0].date);
            const gapStart = nextDay(maxDbDate);
            if (gapStart <= endDate && hasWeekdayInRange(gapStart, endDate)) {
              const liveRows = await loadLive(gapStart, endDate);
              const fresh = liveRows.filter(lr => lr.date > maxDbDate);
              if (fresh.length > 0) {
                merged = mergeRowsPreferDb(merged, fresh);
                filled = true;
              }
            }

            // 觀測群擴編後，新加入的 ETF 在 DB 的歷史列裡整欄缺席（backfill 跑完前都是如此）。
            // 只補日期尾巴補不到這種洞，所以再依 ticker 找出範圍內仍有缺格者，單獨即時補抓。
            const holes = groupEtfs.filter(e =>
              e.source && e.key && merged.some(row => row.data[e.ticker] == null));
            if (holes.length > 0) {
              const holeRows = await loadLive(startDate, endDate, holes);
              if (holeRows.length > 0) {
                merged = mergeCellsPreferDb(merged, holeRows);
                filled = true;
              }
            }

            setRows(merged);
            setDataSource(filled ? 'mixed' : 'db');
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
  }, [startDate, endDate, currentGroup.dbGroup, groupEtfs, loadLive]);

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

  // 區間合計（不受目前排序影響，永遠依實際資料計算）：每檔淨申贖加總。
  const subsTotal = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const t of allTickers) {
      const vals = (rows ?? []).map(r => r.data[t]?.netSub).filter((v): v is number => v != null);
      out[t] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    }
    return out;
  }, [rows, allTickers]);

  // 區間規模變化：區間內最新一筆有資料的規模 − 最早一筆有資料的規模。
  const aumChange = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const t of allTickers) {
      const withData = (rows ?? [])
        .filter(r => r.data[t]?.aum != null)
        .map(r => ({ date: r.date, aum: r.data[t]!.aum }))
        .sort((a, b) => a.date.localeCompare(b.date));
      out[t] = withData.length >= 2 ? withData[withData.length - 1].aum - withData[0].aum : null;
    }
    return out;
  }, [rows, allTickers]);

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
        {[{ label: '近5日', days: 5 }, { label: '近10日', days: 10 }, { label: '近20日', days: 20 }, { label: '近30日', days: 30 }].map(p => (
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
            <span style={{ fontSize: '.78rem', color: SUB }}>
              單位：億元　正值 = 淨申購（紅）　負值 = 淨贖回（綠）
              {rows.some(r => Object.values(r.data).some(d => d?.isEstimate)) && (
                <> ／ <span style={{ color: '#B08F6E' }}>斜體+*</span> = 正式公告前的預估值，公告後會自動改成正式值</>
              )}
            </span>
            <button onClick={() => saveImage(subsRef, `同業淨申贖_${currentGroup.label}_${endDate}.png`)}
              style={{ padding: '4px 12px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, cursor: 'pointer', fontSize: '.78rem', color: SUB }}>
              儲存 / 分享
            </button>
          </div>
          <div className="mt" style={{ overflowX: 'auto', borderRadius: 8, border: `1px solid ${BORDER}` }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
              <thead>
                <tr>
                  <th className="m-edge" onClick={() => toggleSubsSort('date')} style={{ ...TH, textAlign: 'left', minWidth: 100, position: 'sticky', left: 0, zIndex: 2 }}>{subsLabel('date', '日期')}</th>
                  {allTickers.map(t => (
                    <th key={t} onClick={() => toggleSubsSort(t)} style={{ ...TH, textAlign: 'right', minWidth: 100 }}>
                      {subsSortKey === t ? subsLabel(t, t) : t}<br />
                      <span style={{ fontWeight: 400, fontSize: '.7rem', opacity: .8 }}>淨申贖(億)</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedSubsRows.map((row, ri) => {
                  const rowBg = ri % 2 === 0 ? '#fff' : '#FAFAF9';
                  return (
                  <tr key={row.date} style={{ background: rowBg, borderBottom: `1px solid ${BORDER}` }}>
                    <td className="m-edge" style={{ padding: '7px 12px', fontFamily: MONO, fontSize: '.8rem', color: TEXT, position: 'sticky', left: 0, zIndex: 1, background: rowBg }}>{row.date}</td>
                    {allTickers.map(t => {
                      const d = row.data[t];
                      return (
                        <td key={t} title={d?.isEstimate ? '預估值：正式公告出來前的概算，之後會自動改成正式值' : undefined}
                          style={{ padding: '7px 12px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', fontWeight: 600, color: subColor(d?.netSub ?? null),
                            fontStyle: d?.isEstimate ? 'italic' : 'normal', opacity: d?.isEstimate ? 0.75 : 1 }}>
                          {d ? <>{fmtSub(d.netSub)}{d.isEstimate && <span style={{ color: '#B08F6E' }}>*</span>}</> : <span style={{ color: '#CCC' }}>—</span>}
                        </td>
                      );
                    })}
                  </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: '#F5F3F0', borderTop: `2px solid ${BORDER}` }}>
                  <td className="m-edge" style={{ padding: '7px 12px', fontFamily: MONO, fontSize: '.8rem', fontWeight: 700, color: TEXT, position: 'sticky', left: 0, zIndex: 1, background: '#F5F3F0' }}>區間合計</td>
                  {allTickers.map(t => {
                    const sum = subsTotal[t];
                    return (
                      <td key={t} style={{ padding: '7px 12px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', fontWeight: 700, color: subColor(sum) }}>
                        {sum !== null ? fmtSub(sum) : <span style={{ color: '#CCC' }}>—</span>}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
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
          <div className="mt" style={{ overflowX: 'auto', borderRadius: 8, border: `1px solid ${BORDER}` }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
              <thead>
                <tr>
                  <th className="m-edge" onClick={() => toggleAumSort('date')} style={{ ...TH, textAlign: 'left', minWidth: 100, position: 'sticky', left: 0, zIndex: 2 }}>{aumLabel('date', '日期')}</th>
                  {allTickers.map(t => (
                    <th key={t} onClick={() => toggleAumSort(t)} style={{ ...TH, textAlign: 'right', minWidth: 100 }}>
                      {aumSortKey === t ? aumLabel(t, t) : t}<br />
                      <span style={{ fontWeight: 400, fontSize: '.7rem', opacity: .8 }}>規模</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedAumRows.map((row, ri) => {
                  const rowBg = ri % 2 === 0 ? '#fff' : '#FAFAF9';
                  return (
                  <tr key={row.date} style={{ background: rowBg, borderBottom: `1px solid ${BORDER}` }}>
                    <td className="m-edge" style={{ padding: '7px 12px', fontFamily: MONO, fontSize: '.8rem', color: TEXT, position: 'sticky', left: 0, zIndex: 1, background: rowBg }}>{row.date}</td>
                    {allTickers.map(t => {
                      const d = row.data[t];
                      return (
                        <td key={t} title={d?.isEstimate ? '預估值：正式公告出來前的概算，之後會自動改成正式值' : undefined}
                          style={{ padding: '7px 12px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', color: SUB,
                            fontStyle: d?.isEstimate ? 'italic' : 'normal', opacity: d?.isEstimate ? 0.75 : 1 }}>
                          {d ? <>{fmtAum(d.aum)}{d.isEstimate && <span style={{ color: '#B08F6E' }}>*</span>}</> : <span style={{ color: '#CCC' }}>—</span>}
                        </td>
                      );
                    })}
                  </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: '#F5F3F0', borderTop: `2px solid ${BORDER}` }}>
                  <td className="m-edge" style={{ padding: '7px 12px', fontFamily: MONO, fontSize: '.8rem', fontWeight: 700, color: TEXT, position: 'sticky', left: 0, zIndex: 1, background: '#F5F3F0' }}>區間規模變化</td>
                  {allTickers.map(t => {
                    const diff = aumChange[t];
                    return (
                      <td key={t} style={{ padding: '7px 12px', textAlign: 'right', fontFamily: MONO, fontSize: '.82rem', fontWeight: 700, color: subColor(diff) }}>
                        {diff !== null ? fmtAumDiff(diff) : <span style={{ color: '#CCC' }}>—</span>}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            </table>
          </div>
          </div>
        </>
      )}
    </div>
  );
}
