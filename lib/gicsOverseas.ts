import { canonicalCode } from './sectorExposure';

/* 海外持股的 GICS 11 大類別（Sector）對照表 —— 供「族群曝險 → 海外GICS分類」使用。

   ⚠ 為什麼是手動對照、不抓 Yahoo 的 sector：Yahoo 用的是 Morningstar 分類，與 GICS 有出入
     （例：Uber 在 Yahoo 是科技、GICS 是工業；Visa/Mastercard 在 Yahoo 是 Financial Services、
     GICS 2023 起也歸金融，但 Alphabet/Meta 是通訊服務、Amazon/Tesla 是非必需消費，Yahoo 的命名與
     歸屬都不完全一致）。與 sectorGroupsOverseas.ts 相同做法：靜態檔、git 版控、隨持股變動人工維護。

   ⚠ 一檔股票只屬於一個 GICS 類別（GICS 本來就是互斥分類）。

   涵蓋範圍（2026-09-21 快照）：sectorGroupsOverseas.ts 全部 284 檔，加上 00989A/00997A 當時未分類的
   30 檔，以及本機驗證時在較舊持股快照裡發現的 6 檔（ORCL、RBRK、APP、DIOD、KEYS、RTX）。GICS 是完整分類，不像主題族群需要挑選，所以只要是海外主動式ETF 持有的股票都應該在這裡。
   新持股沒收錄時不會憑空消失：lib/gicsExposure.ts 會把它們歸進「未對應」欄並列出代號，補進來即可。

   代號格式沿用 sectorGroupsOverseas.ts（Yahoo 格式，台股帶 .TW/.TWO）；比對時兩邊都套
   canonicalCode() 剝掉 .TW/.TWO，因為基金回報的台股是裸 4 碼。

   分類上比較有爭議、之後若使用者質疑要回頭檢查的（以 S&P/MSCI 公開分類為準，新上市或非美股不一定查得到）：
     OKLO 小型模組化核能反應爐 → 公用事業（也有資料放工業／電力設備）
     XE X-Energy、PL Planet Labs、SPCX SpaceX → 工業（太空／核能設備，尚無或剛有 GICS）
     301377.SZ 鼎泰高科（PCB 鑽針）、8996.TW 高力（板式熱交換器）、5801.T 古河電工 → 工業
     VICR Vicor → 工業（電源模組，有些資料放資訊科技）
     GDX、COPX 是 ETF 本身沒有 GICS → 依底層資產歸原物料
     IREN／CIFR／WULF／APLD／NBIS 比特幣礦工轉 AI 算力 → 資訊科技（S&P 對礦工也放資訊科技）
   B86912（和潤債券）不是股票，刻意不歸類；期貨部位在持股讀取階段就已被過濾。 */

export interface GicsSector {
  id: string;
  zh: string;
  en: string;
}

/** 顯示順序即陣列順序：先放持股最集中的類別，方便一眼看重點。 */
export const GICS_SECTORS: GicsSector[] = [
  { id: 'IT',     zh: '資訊科技',   en: 'Information Technology' },
  { id: 'FIN',    zh: '金融',       en: 'Financials' },
  { id: 'IND',    zh: '工業',       en: 'Industrials' },
  { id: 'COMM',   zh: '通訊服務',   en: 'Communication Services' },
  { id: 'HC',     zh: '醫療保健',   en: 'Health Care' },
  { id: 'DISC',   zh: '非必需消費', en: 'Consumer Discretionary' },
  { id: 'STAPLE', zh: '必需消費',   en: 'Consumer Staples' },
  { id: 'ENERGY', zh: '能源',       en: 'Energy' },
  { id: 'MAT',    zh: '原物料',     en: 'Materials' },
  { id: 'RE',     zh: '房地產',     en: 'Real Estate' },
  { id: 'UTIL',   zh: '公用事業',   en: 'Utilities' },
];

export const GICS_UNMAPPED_ID = 'UNMAPPED';

const MEMBERS: Record<string, string[]> = {
  IT: [
    // 半導體與半導體設備
    'AMD', '2454.TW', 'ARM', 'INTC', 'NVDA', 'QCOM', 'AVGO', '3661.TW', '3443.TW', '5274.TWO', '3529.TWO', 'CBRS',
    '6223.TWO', '6871.T', 'TER', 'FORM', 'AIXA.DE', 'AEHR', '095340.KS', 'ASML', 'AMAT', 'LRCX', 'KLAC', '8035.T',
    '6857.T', '6515.TW', '6510.TWO', '2360.TW', '7769.TW', '300757.SZ', 'ASML.AS', '6640.TWO',
    '2330.TW', 'TSM', 'TSEM', '3711.TW', 'GFS', '2303.TW', 'AMKR', '2449.TW',
    'MU', '285A.T', 'STX', 'WDC', '000660.KS', '005930.KS', 'PSTG', '8299.TWO', '2408.TW', 'SNDK', 'SKHY', 'SIMO',
    'IFX.DE', 'MPWR', 'TXN', 'STM', 'ON', 'NXPI', 'ADI', 'MCHP', 'ALGM', 'MTSI', 'ENTG', 'DIOD', 'SITM', 'CRDO', 'MRVL', 'ALAB', 'SMTC', '2379.TW',
    // 光通訊、網通、電子零組件、PCB
    'LITE', 'COHR', '300308.SZ', '3308.HK', '4979.TWO', 'FN', 'CIEN', '6442.TW', '3363.TWO', '3081.TWO', 'AXTI',
    'ANET', 'CSCO', '2345.TW', '3665.TW', 'NOK', '3491.TWO', '6285.TW', 'APH',
    '3037.TW', '2383.TW', '8046.TW', '3189.TW', '4062.T', '6967.T', '2368.TW', '6274.TW', '600183.SS', 'TTMI',
    '009150.KS', '6981.T', '300408.SZ', '2327.TW', '6997.T', '6762.T', '6976.T', '2492.TW', '3026.TW', 'GLW',
    '3008.TW',
    // 伺服器、電源散熱（電子設備／硬體）
    '2308.TW', '3017.TW', '3324.TW', '3653.TW', '2301.TW', 'SMCI',
    'DELL', 'HPE', '992.HK', '6669.TW', '2382.TW', '3231.TW', '2376.TW', '2059.TW', '8210.TW', 'CLS',
    // 軟體與 IT 服務
    'MSFT', 'AAPL', 'CDNS', 'PANW', 'SNOW', 'PLTR', 'NET', 'TWLO', '4180.T', 'CRWD', 'NOW', 'DDOG', 'ZS', 'CRM',
    'NTSK', 'FSLY', 'FIG', 'IOT', 'MDB', 'OKTA', 'SHOP',
    'ZM', 'HUBS', 'ADBE', 'DOCN', 'TEAM', 'U', 'ESTC', 'ADSK', 'INTU', 'DT', 'FTNT',
    'ORCL', 'RBRK', 'APP', 'KEYS',
    // AI 算力租賃（雲端基礎設施／礦工轉型）
    'CRWV', 'NBIS', 'IREN', 'APLD', 'CIFR', 'WULF',
    // 量子運算
    'IONQ', 'RGTI', 'QBTS', 'QUBT',
  ],
  FIN: [
    // 銀行
    'JPM', 'BAC', 'WFC', 'UBS', 'BNY', 'C', 'HSBA.L', 'BARC.L', 'LLOY.L', 'NWG.L', 'STAN.L', 'DBK.DE', 'BNP.PA', 'GLE.PA',
    'INGA.AS', 'ABN.AS', 'CABK.MC', 'UCG.MI', 'BAMI.MI', 'BMPS.MI', 'ETE.AT', 'TPEIR.AT', 'BOCHGR.AT',
    '8306.T', '8308.T', '8309.T', '8331.T', '8377.T', '7167.T', '8411.T', '055550.KS', 'KBC.BR',
    // 保險
    'AV.L', 'ADM.L', 'LGEN.L', 'MNG.L', 'SDLF.L', 'AGN.AS', 'ASRNL.AS', 'G.MI', 'UNI.MI', 'CS.PA', 'EQH', 'LMND',
    // 資產管理、券商、支付、加密與金融科技
    'BLK', 'BX', 'ARES', 'AMUN.PA', 'GS', 'MRX',
    'CRCL', 'V', 'MA', 'COIN', 'XYZ', 'HOOD', 'BMNR', '8473.T', 'CHYM', 'GPN', 'RELY', 'BLSH', 'SOFI', 'NU', 'FIGR',
  ],
  IND: [
    // 電力設備與能源基建
    'BE', 'PLUG', 'FCEL', 'VRT', 'ETN', 'GEV', 'SMR', '6508.T', '034020.KS', 'ENR.DE', 'SU.PA', 'XE', 'BWXT',
    // 航太國防、太空、機械
    'RKLB', 'PL', 'SPCX', 'HWM', 'KTOS', 'ACHR', 'AXON', 'GE', 'LMT', 'RTX', 'DE', 'ROK', 'SYM', 'VICR',
    // 運輸平台、人力資源、其他工業零組件
    'UBER', '581A.T', '6098.T', '301377.SZ', '8996.TW', '5801.T',
  ],
  COMM: [
    'GOOGL', 'GOOG', 'META', 'NFLX', 'SPOT', 'TTWO', 'RBLX',
    'ASTS', 'IRDM', 'SATS', 'GSAT',
  ],
  HC: [
    'LLY', 'MRK', 'TEM', 'NTRA', 'TWST', 'TXG', 'CRSP', 'BEAM', 'ILMN', 'WGS', 'NTLA', 'RXRX', 'VCYT', 'CERS',
    'VEEV', 'GENB',
  ],
  DISC: [
    'AMZN', 'TSLA', 'RIVN', 'MBLY', 'XPEV', '7203.T', 'EXPE', 'DASH', 'BKNG', 'BABA', 'WRBY',
  ],
  STAPLE: [],
  ENERGY: ['PSX', 'EQT'],
  MAT: ['GDX', 'COPX', 'WPM', 'AEM', 'KGC', 'GLEN.L'],
  RE: [],
  UTIL: ['CEG', 'VST', 'OKLO'],
};

/** canonicalCode(代號) → GICS 類別 id。模組載入時建一次。 */
export const GICS_OF: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [sector, codes] of Object.entries(MEMBERS)) {
    for (const c of codes) {
      const k = canonicalCode(c).toUpperCase();
      if (m[k] && m[k] !== sector) throw new Error(`GICS 對照重複且衝突：${c}（${m[k]} vs ${sector}）`);
      m[k] = sector;
    }
  }
  return m;
})();

export function gicsSectorOf(stockid: string): string | null {
  return GICS_OF[canonicalCode(stockid.trim()).toUpperCase()] ?? null;
}
