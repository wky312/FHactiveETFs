// 主動式 ETF 掛牌破發追蹤 — 標的清單與共用型別（client-safe，不含伺服器端相依）。
//
// 為什麼另立一份而不用 lib/peerGroups.ts：破發分析需要「掛牌日 / 發行價 / 上市或上櫃」
// 這三個 peerGroups 沒有的欄位，且母體要涵蓋全部 32 檔（peerGroups 目前缺 00404A/00406A/00407A/00410A）。
// route 與 BreakIssueTab 共用同一份定義。

export interface BreakIssueFund {
  ticker: string;
  name: string;        // 「主動…」簡稱，與 peerGroups 一致
  issuer: string;      // 投信簡稱，供發行公司篩選
  yfTicker: string;    // 上櫃兩檔要 .TWO
  listDate: string;    // 掛牌日 YYYY-MM-DD（首批三檔採官方公布日）
  issuePrice: number;  // 發行價，多數 10、少數 15
  tpex?: boolean;      // true = 櫃買中心上櫃
  approxListDate?: boolean; // true = 掛牌日為近似值（yfinance 有掛牌前 K 棒）
}

export const BREAK_ISSUE_FUNDS: BreakIssueFund[] = [
  { ticker: '00980A', name: '主動野村台灣優選',     issuer: '野村',   yfTicker: '00980A.TW',  listDate: '2025-05-05', issuePrice: 10, approxListDate: true },
  { ticker: '00981A', name: '主動統一台股增長',     issuer: '統一',   yfTicker: '00981A.TW',  listDate: '2025-05-27', issuePrice: 10, approxListDate: true },
  { ticker: '00982A', name: '主動群益台灣強棒',     issuer: '群益',   yfTicker: '00982A.TW',  listDate: '2025-05-22', issuePrice: 10, approxListDate: true },
  { ticker: '00983A', name: '主動中信ARK創新',      issuer: '中信',   yfTicker: '00983A.TW',  listDate: '2025-06-10', issuePrice: 10 },
  { ticker: '00984A', name: '主動安聯台灣高息',     issuer: '安聯',   yfTicker: '00984A.TW',  listDate: '2025-07-07', issuePrice: 10 },
  { ticker: '00985A', name: '主動野村台灣50',       issuer: '野村',   yfTicker: '00985A.TW',  listDate: '2025-07-09', issuePrice: 10 },
  { ticker: '00986A', name: '主動台新全球龍頭成長', issuer: '台新',   yfTicker: '00986A.TW',  listDate: '2025-08-27', issuePrice: 10 },
  { ticker: '00987A', name: '主動台新優勢成長',     issuer: '台新',   yfTicker: '00987A.TW',  listDate: '2025-12-16', issuePrice: 10 },
  { ticker: '00988A', name: '主動統一全球創新',     issuer: '統一',   yfTicker: '00988A.TW',  listDate: '2025-11-05', issuePrice: 10 },
  { ticker: '00989A', name: '主動摩根美國科技',     issuer: '摩根',   yfTicker: '00989A.TW',  listDate: '2025-11-13', issuePrice: 15 },
  { ticker: '00990A', name: '主動元大AI新經濟',     issuer: '元大',   yfTicker: '00990A.TW',  listDate: '2025-12-02', issuePrice: 10 },
  { ticker: '00991A', name: '主動復華未來50',       issuer: '復華',   yfTicker: '00991A.TW',  listDate: '2025-12-09', issuePrice: 10 },
  { ticker: '00992A', name: '主動群益科技創新',     issuer: '群益',   yfTicker: '00992A.TW',  listDate: '2025-12-17', issuePrice: 10 },
  { ticker: '00993A', name: '主動安聯台灣',         issuer: '安聯',   yfTicker: '00993A.TW',  listDate: '2026-01-22', issuePrice: 10 },
  { ticker: '00994A', name: '主動第一金台股',       issuer: '第一金', yfTicker: '00994A.TW',  listDate: '2025-12-30', issuePrice: 10 },
  { ticker: '00995A', name: '主動中信台灣卓越',     issuer: '中信',   yfTicker: '00995A.TW',  listDate: '2026-01-13', issuePrice: 10 },
  { ticker: '00996A', name: '主動兆豐台灣豐收',     issuer: '兆豐',   yfTicker: '00996A.TW',  listDate: '2026-03-17', issuePrice: 10 },
  { ticker: '00997A', name: '主動群益美國增長',     issuer: '群益',   yfTicker: '00997A.TW',  listDate: '2026-03-30', issuePrice: 10 },
  { ticker: '00998A', name: '主動復華全球金融',     issuer: '復華',   yfTicker: '00998A.TWO', listDate: '2026-04-15', issuePrice: 15, tpex: true },
  { ticker: '00999A', name: '主動野村台灣高息',     issuer: '野村',   yfTicker: '00999A.TW',  listDate: '2026-04-21', issuePrice: 10 },
  { ticker: '00400A', name: '主動國泰動能高息',     issuer: '國泰',   yfTicker: '00400A.TW',  listDate: '2026-03-30', issuePrice: 10 },
  { ticker: '00401A', name: '主動摩根台灣鑫收',     issuer: '摩根',   yfTicker: '00401A.TW',  listDate: '2026-03-31', issuePrice: 10 },
  { ticker: '00402A', name: '主動安聯美國科技領航', issuer: '安聯',   yfTicker: '00402A.TW',  listDate: '2026-06-01', issuePrice: 10 },
  { ticker: '00403A', name: '主動統一升級50',       issuer: '統一',   yfTicker: '00403A.TW',  listDate: '2026-04-28', issuePrice: 10 },
  { ticker: '00404A', name: '主動聯博動能50',       issuer: '聯博',   yfTicker: '00404A.TW',  listDate: '2026-05-28', issuePrice: 10 },
  { ticker: '00405A', name: '主動富邦台灣龍耀',     issuer: '富邦',   yfTicker: '00405A.TW',  listDate: '2026-05-26', issuePrice: 10 },
  { ticker: '00406A', name: '主動中信台灣收益',     issuer: '中信',   yfTicker: '00406A.TW',  listDate: '2026-06-02', issuePrice: 10 },
  { ticker: '00407A', name: '主動凱基台灣',         issuer: '凱基',   yfTicker: '00407A.TW',  listDate: '2026-06-16', issuePrice: 10 },
  { ticker: '00408A', name: '主動第一金優股息',     issuer: '第一金', yfTicker: '00408A.TW',  listDate: '2026-07-07', issuePrice: 10 },
  { ticker: '00415A', name: '主動群益核心50',       issuer: '群益',   yfTicker: '00415A.TW',  listDate: '2026-10-20', issuePrice: 10 },
  { ticker: '00409A', name: '主動復華全球50',       issuer: '復華',   yfTicker: '00409A.TW',  listDate: '2026-09-02', issuePrice: 10 },
  { ticker: '00410A', name: '主動永豐科技趨勢',     issuer: '永豐',   yfTicker: '00410A.TW',  listDate: '2026-07-28', issuePrice: 10 },
  { ticker: '00411A', name: '主動統一前沿科技',     issuer: '統一',   yfTicker: '00411A.TWO', listDate: '2026-08-26', issuePrice: 10, tpex: true },
];

export type BreakIssueStatus = 'above' | 'below' | 'never';

export interface BreakIssueRow {
  ticker: string;
  name: string;
  issuer: string;
  listDate: string;
  issuePrice: number;
  tpex: boolean;
  approxListDate: boolean;
  tradingDays: number;
  fresh: boolean;              // 掛牌未滿 20 個交易日，數據僅供參考
  day1Break: boolean;          // 掛牌首日收盤即 < 發行價
  first10BreakDay: number | null;   // 前 10 個交易日內首次破發，是第幾個交易日；否為 null
  firstBreakDate: string | null;    // 任一交易日首次破發之日
  low20: number;               // 掛牌後前 20 個交易日的最低收盤（未還原）
  low20Date: string;
  low20Day: number;            // low20 為掛牌後第幾個交易日
  reclaimDate: string | null;  // 首次破發後、首次收盤重新 >= 發行價之日
  reclaimGap: number | null;   // 首次破發 → 首次站回，相隔幾個交易日
  reclaimHeld: boolean;        // 站回後是否守住（站回日之後 > 55% 交易日 >= 發行價）
  status: BreakIssueStatus;
  ret3m: number | null;        // 掛牌後 3 個月還原報酬 %
  ret6m: number | null;        // 掛牌後 6 個月還原報酬 %
  retNow: number | null;       // 掛牌至今還原報酬 %
  lastClose: number | null;
}

export interface BreakIssuePayload {
  asOf: string;                // 產表日 YYYY-MM-DD（台北）
  rows: BreakIssueRow[];
  errors: string[];            // 抓不到資料的代號
}
