export type Category = 'central_bank' | 'macro' | 'earnings' | 'politics' | 'industry';

export type EventType =
  | 'fomc' | 'twcb'
  | 'cpi' | 'ppi' | 'nfp' | 'pce' | 'ism_mfg'
  | 'earnings'
  | 'election' | 'diplomacy' | 'policy'
  | 'conference';

export type EventSource = 'fed' | 'fred' | 'rule' | 'ff' | 'yahoo' | 'manual';

export interface Metric {
  label: string;
  forecast?: string | null;
  previous?: string | null;
  actual?: string | null;
}

export interface MarketEvent {
  id: string;                // 穩定識別碼，同時當 ics UID
  type: EventType;
  category: Category;
  title: string;
  start: string;             // ISO UTC；allDay 時為當地日期 00:00 對應的 UTC（僅供排序），日期看 date
  date: string;              // 事件當地日期 YYYY-MM-DD（allDay 顯示與 ics 用）
  endDate?: string;          // 多日事件的最後一天（含）
  allDay: boolean;
  importance: 1 | 2 | 3;
  tentative?: boolean;       // 尚未官方確認（預估 / 依慣例推算）
  source: EventSource;
  historyKey: string;        // 歷史反應統計分組
  reactionAt: string;        // 計算市場反應用的時間點（ISO UTC）
  symbol?: string;
  note?: string;
  metrics?: Metric[];
}

export interface SourceStatus { ok: boolean; count: number; error?: string }

export interface MoveStats { mean: number; median: number; upPct: number }

export interface MarketReaction {
  symbol: string;
  name: string;
  n: number;
  t1: MoveStats;
  t5: MoveStats;
  volRatio: number;          // 事件後首日平均絕對漲跌 ÷ 平常日平均絕對漲跌
}

export interface ReactionSample {
  id: string;
  date: string;
  title: string;
  moves: Record<string, { t1: number | null; t5: number | null }>;
}

export interface ReactionStats {
  historyKey: string;
  label: string;
  n: number;
  markets: MarketReaction[];
  samples: ReactionSample[];  // 最近的樣本（新到舊）
}

export interface CalendarPayload {
  generatedAt: string;
  events: MarketEvent[];
  sources: Record<string, SourceStatus>;
  history: Record<string, ReactionStats>;
  historyGeneratedAt: string | null;
}
