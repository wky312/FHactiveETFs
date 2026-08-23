export interface EtfConfig {
  ticker: string;
  name: string;
  short: string;      // 簡稱，頁首基金選單用（全名在選單裡太長會擠爆窄螢幕）
  fundId: string;
  yfTicker: string;   // Yahoo Finance ticker for ETF market price
}

export const ETF_LIST: EtfConfig[] = [
  { ticker: '00991A', name: '復華主動式ETF',             short: '主動復華未來50',   fundId: 'ETF23', yfTicker: '00991A.TW' },
  { ticker: '00998A', name: '復華全球金融股票主動式ETF', short: '主動復華全球金融', fundId: 'ETF24', yfTicker: '00998A.TW' },
  { ticker: '00409A', name: '復華全球未來50主動式ETF',   short: '主動復華全球50',   fundId: 'ETF26', yfTicker: '00409A.TW' },
];

export const DEFAULT_ETF = ETF_LIST[0];
