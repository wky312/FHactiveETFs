import type { Category, EventType } from './types';

export const CATEGORY_META: Record<Category, { label: string; color: string }> = {
  central_bank: { label: '央行', color: '#6B3FA0' },
  macro:        { label: '經濟數據', color: '#1F5FA8' },
  earnings:     { label: '財報法說', color: '#A87A3E' },
  politics:     { label: '選舉政治', color: '#C0561E' },
  industry:     { label: '產業大會', color: '#2E7F7F' },
};

export type MetricKind = 'mom' | 'yoy' | 'diffK' | 'level';

export interface FredMetricSpec { label: string; series: string; kind: MetricKind }

export interface FredReleaseSpec {
  type: Extract<EventType, 'cpi' | 'ppi' | 'nfp' | 'pce'>;
  releaseId: number;
  datesSeries: string;       // 用它的「首次公布日」(output_type=4) 取得歷史公布日
  title: string;
  importance: 1 | 2 | 3;
  metrics: FredMetricSpec[]; // label 與 ForexFactory 標題一致，才能對上市場預期
}

/* BLS / BEA 的數據都在美東 08:30 公布 */
export const FRED_RELEASES: FredReleaseSpec[] = [
  { type: 'cpi', releaseId: 10, datesSeries: 'CPIAUCSL', title: '美國 CPI 消費者物價', importance: 3, metrics: [
    { label: 'CPI m/m', series: 'CPIAUCSL', kind: 'mom' },
    { label: 'Core CPI m/m', series: 'CPILFESL', kind: 'mom' },
    { label: 'CPI y/y', series: 'CPIAUCNS', kind: 'yoy' },
    { label: 'Core CPI y/y', series: 'CPILFENS', kind: 'yoy' },
  ] },
  { type: 'ppi', releaseId: 46, datesSeries: 'PPIFIS', title: '美國 PPI 生產者物價', importance: 2, metrics: [
    { label: 'PPI m/m', series: 'PPIFIS', kind: 'mom' },
    { label: 'Core PPI m/m', series: 'PPIFES', kind: 'mom' },
  ] },
  { type: 'nfp', releaseId: 50, datesSeries: 'PAYEMS', title: '美國非農就業', importance: 3, metrics: [
    { label: 'Non-Farm Employment Change', series: 'PAYEMS', kind: 'diffK' },
    { label: 'Unemployment Rate', series: 'UNRATE', kind: 'level' },
  ] },
  { type: 'pce', releaseId: 54, datesSeries: 'PCEPILFE', title: '美國核心 PCE 物價', importance: 2, metrics: [
    { label: 'Core PCE Price Index m/m', series: 'PCEPILFE', kind: 'mom' },
    { label: 'Core PCE Price Index y/y', series: 'PCEPILFE', kind: 'yoy' },
  ] },
];

/* ForexFactory 標題 → 我們的事件類型（只收這些，其餘忽略） */
export const FF_TITLE_TO_TYPE: Record<string, EventType> = {
  'CPI m/m': 'cpi', 'Core CPI m/m': 'cpi', 'CPI y/y': 'cpi', 'Core CPI y/y': 'cpi',
  'PPI m/m': 'ppi', 'Core PPI m/m': 'ppi',
  'Non-Farm Employment Change': 'nfp', 'Unemployment Rate': 'nfp',
  'Core PCE Price Index m/m': 'pce', 'Core PCE Price Index y/y': 'pce',
  'ISM Manufacturing PMI': 'ism_mfg', 'ISM Manufacturing Prices': 'ism_mfg',
  'Federal Funds Rate': 'fomc',
};

export const METRIC_LABEL_ZH: Record<string, string> = {
  'CPI m/m': 'CPI 月增率', 'Core CPI m/m': '核心 CPI 月增率', 'CPI y/y': 'CPI 年增率', 'Core CPI y/y': '核心 CPI 年增率',
  'PPI m/m': 'PPI 月增率', 'Core PPI m/m': '核心 PPI 月增率',
  'Non-Farm Employment Change': '非農新增就業', 'Unemployment Rate': '失業率',
  'Core PCE Price Index m/m': '核心 PCE 月增率', 'Core PCE Price Index y/y': '核心 PCE 年增率',
  'ISM Manufacturing PMI': 'ISM 製造業 PMI', 'ISM Manufacturing Prices': 'ISM 物價指數',
  'Federal Funds Rate': '聯邦基金利率（上限）',
  'EPS': 'EPS（分析師均值）',
};

export interface EarningsSpec {
  symbol: string;            // Yahoo 代碼（取財報日）
  key: string;               // 事件 id / historyKey 用
  title: string;
  time: string;              // 當地公布時間 HH:MM（Yahoo 的時間常是佔位值，這裡用慣例）
  tz: string;
}

export const EARNINGS_WATCHLIST: EarningsSpec[] = [
  { symbol: 'NVDA', key: 'NVDA', title: 'Nvidia 財報', time: '16:20', tz: 'America/New_York' },
  { symbol: 'TSM',  key: 'TSMC', title: '台積電法說會', time: '14:00', tz: 'Asia/Taipei' },
];

export interface ReactionMarket { symbol: string; name: string; tz: string; close: string }

export const REACTION_MARKETS: ReactionMarket[] = [
  { symbol: '^TWII',   name: '加權指數', tz: 'Asia/Taipei',      close: '13:30' },
  { symbol: '0050.TW', name: '0050',     tz: 'Asia/Taipei',      close: '13:30' },
  { symbol: '^SOX',    name: '費半',     tz: 'America/New_York', close: '16:00' },
  { symbol: '^IXIC',   name: 'NASDAQ',   tz: 'America/New_York', close: '16:00' },
];

export const HISTORY_LABELS: Record<string, string> = {
  fomc: 'FOMC 利率決議', twcb: '台灣央行理監事會',
  cpi: '美國 CPI', ppi: '美國 PPI', nfp: '美國非農就業', pce: '美國核心 PCE', ism_mfg: 'ISM 製造業 PMI',
  'earnings:NVDA': 'Nvidia 財報', 'earnings:TSMC': '台積電法說會',
  election_us: '美國大選 / 期中選舉', election_tw: '台灣選舉', diplomacy_uscn: '美中元首會晤',
  policy: '重大政策衝擊',
};

export const HISTORY_START = '2015-01-01';
