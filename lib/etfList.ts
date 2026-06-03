export interface EtfConfig {
  ticker: string;
  name: string;
  fundId: string;
  yfTicker: string;   // Yahoo Finance ticker for ETF market price
}

export const ETF_LIST: EtfConfig[] = [
  { ticker: '00991A', name: '復華主動式ETF',             fundId: 'ETF23', yfTicker: '00991A.TW' },
  { ticker: '00998A', name: '復華全球金融股票主動式ETF', fundId: 'ETF24', yfTicker: '00998A.TW' },
];

export const DEFAULT_ETF = ETF_LIST[0];
