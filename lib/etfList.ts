export interface EtfConfig {
  ticker: string;
  name: string;
  short: string;      // 簡稱，頁首基金選單用（全名在選單裡太長會擠爆窄螢幕）
  fundId: string;
  yfTicker: string;   // Yahoo Finance ticker for ETF market price
  /* 持股本來就會落後幾個交易日：國內檔 T 日下午就掛出 T 日持股；海外檔要 T+1 才公告，
     查「今天」會回「持股尚未公布」。網頁預設日期依此往回推（同 scripts/daily_summary.py 的 holdingsLag）。 */
  holdingsLag: number;
}

export const ETF_LIST: EtfConfig[] = [
  { ticker: '00991A', name: '復華主動式ETF',             short: '主動復華未來50',   fundId: 'ETF23', yfTicker: '00991A.TW',  holdingsLag: 0 },
  { ticker: '00998A', name: '復華全球金融股票主動式ETF', short: '主動復華全球金融', fundId: 'ETF24', yfTicker: '00998A.TWO', holdingsLag: 1 },  // 上櫃 → .TWO
  { ticker: '00409A', name: '復華全球未來50主動式ETF',   short: '主動復華全球50',   fundId: 'ETF26', yfTicker: '00409A.TW',  holdingsLag: 1 },
];

export const DEFAULT_ETF = ETF_LIST[0];
