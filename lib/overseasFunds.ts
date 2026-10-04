export interface OverseasFundConfig {
  ticker: string;
  name: string;
  source: 'fhtrust' | 'cmoney';
  fundId: string;
  /** 官網直抓來源（lib/issuerHoldingsOverseas.ts）。目前只有族群曝險（consensusOverseas）採用；
      其他分頁仍依 source 走 CMoney/fhtrust，刻意不動，避免連帶改到歸因/收盤影響分頁的存檔邏輯。 */
  issuer?: 'ezmoney' | 'yuanta' | 'capital' | 'jpmorgan';
}

/* 海外族群曝險（lib/consensusOverseas.ts）用的基金範圍——目前程式裡「已知能抓到持股」的
   海外主動式ETF 只有這 7 檔：復華自家 2 檔走 fhtrust（fundId 為 ETFxx），其餘投信 5 檔走
   CMoney 代理（fundId 即股票代號本身）。

   刻意獨立成自己的清單、不依附 lib/cmoneyHoldings.ts 的 CMONEY_FUNDS——那份是給
   StockTrajectoryTab 用、生命週期不同（可能因為軌跡分頁的需求增減），避免海外族群曝險的
   基金範圍被別的分頁的編輯意外牽動。

   2026-08-26：00989A(主動摩根美國科技)、00997A(主動群益美國增長) 原本漏掉是因為沒試過，
   不是真的沒有來源——實測 CMoney AssignID=ticker 一樣抓得到逐日持股（跟其餘 CMoney 系
   一致），補上。 */
/* 2026-10-04：CMoney 開始回 Auth Failed → 能用官網直抓的 5 檔加上 issuer（族群曝險優先採用）。
   00983A/00986A/00402A 官網要 Playwright，仍只有 CMoney，CMoney 修好前會是空的。 */
export const OVERSEAS_FUNDS: OverseasFundConfig[] = [
  { ticker: '00998A', name: '主動復華全球金融', source: 'fhtrust', fundId: 'ETF24' },
  { ticker: '00409A', name: '主動復華全球50',   source: 'fhtrust', fundId: 'ETF26' },
  { ticker: '00983A', name: '主動中信ARK創新',   source: 'cmoney',  fundId: '00983A' },
  { ticker: '00986A', name: '主動台新全球龍頭',   source: 'cmoney',  fundId: '00986A' },
  { ticker: '00988A', name: '主動統一全球創新',   source: 'cmoney',  fundId: '00988A', issuer: 'ezmoney' },
  { ticker: '00989A', name: '主動摩根美國科技',   source: 'cmoney',  fundId: '00989A', issuer: 'jpmorgan' },
  { ticker: '00990A', name: '主動元大AI新經濟',   source: 'cmoney',  fundId: '00990A', issuer: 'yuanta' },
  { ticker: '00997A', name: '主動群益美國增長',   source: 'cmoney',  fundId: '00997A', issuer: 'capital' },
  { ticker: '00402A', name: '主動安聯美國科技',   source: 'cmoney',  fundId: '00402A' },
  // 2026/08/26 掛牌（統一投信，上櫃）。CMoney 自 2026/08/24 起就有逐日持股。
  { ticker: '00411A', name: '主動統一前沿科技',   source: 'cmoney',  fundId: '00411A', issuer: 'ezmoney' },
];
