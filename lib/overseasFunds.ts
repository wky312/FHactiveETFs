export interface OverseasFundConfig {
  ticker: string;
  name: string;
  source: 'fhtrust' | 'cmoney';
  fundId: string;
}

/* 海外族群曝險（lib/consensusOverseas.ts）用的基金範圍——目前程式裡「已知能抓到持股」的
   海外主動式ETF 只有這 7 檔：復華自家 2 檔走 fhtrust（fundId 為 ETFxx），其餘投信 5 檔走
   CMoney 代理（fundId 即股票代號本身）。

   刻意獨立成自己的清單、不依附 lib/cmoneyHoldings.ts 的 CMONEY_FUNDS——那份是給
   StockTrajectoryTab 用、生命週期不同（可能因為軌跡分頁的需求增減），避免海外族群曝險的
   基金範圍被別的分頁的編輯意外牽動。

   TODO(2026-08-25)：00989A(主動摩根美國科技)、00997A(主動群益美國增長) 目前程式裡完全沒有
   抓持股的管道（不在 CMONEY_FUNDS、也不是復華自家基金），待找到資料源後補上。 */
export const OVERSEAS_FUNDS: OverseasFundConfig[] = [
  { ticker: '00998A', name: '主動復華全球金融', source: 'fhtrust', fundId: 'ETF24' },
  { ticker: '00409A', name: '主動復華全球50',   source: 'fhtrust', fundId: 'ETF26' },
  { ticker: '00983A', name: '主動中信ARK創新',   source: 'cmoney',  fundId: '00983A' },
  { ticker: '00986A', name: '主動台新全球龍頭',   source: 'cmoney',  fundId: '00986A' },
  { ticker: '00988A', name: '主動統一全球創新',   source: 'cmoney',  fundId: '00988A' },
  { ticker: '00990A', name: '主動元大AI新經濟',   source: 'cmoney',  fundId: '00990A' },
  { ticker: '00402A', name: '主動安聯美國科技',   source: 'cmoney',  fundId: '00402A' },
];
