export interface EtfConfig {
  ticker: string;
  name: string;
  fundId: string;
}

export const ETF_LIST: EtfConfig[] = [
  { ticker: '00991A', name: '復華主動式ETF',             fundId: 'ETF23' },
  { ticker: '00998A', name: '復華全球金融股票主動式ETF', fundId: 'ETF24' },
];

export const DEFAULT_ETF = ETF_LIST[0];
