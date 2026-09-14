import { SectorGroup } from './sectorGroups';

/* 海外科技股產業族群 —— 一次性轉換自使用者提供的觀察清單 CSV（原始檔存於
   data/global_tech_stocks_watchlist.csv），15 組、122 檔（原始 122 筆排除 SpaceX、
   加入南亞科 2408）。⚠ 2026-08-26 更正：當時排除 SPCX 的理由是「未上市、join 不到」，但
   00411A 實際持有 SPCX US 4.07%、Yahoo 也查得到報價，故已補回「低軌衛星與太空科技」。
   代號沿用 CSV 的 Yahoo Finance 格式（AMD、2454.TW、IFX.DE、300308.SZ…），
   是海外族群曝險（lib/consensusOverseas.ts）拿真實持股比對的 join key，勿改格式。

   顯示名稱（STOCK_NAMES_OVERSEAS）已手動整理：有中文的一律只留中文，不中英夾雜
   （表格欄寬會被英文撐亂，見 lib/sectorExposure.ts 的 resolveStockNameOverseas 優先採用
   這份清單而非即時持股資料的股名，原因同此）；純英文公司名（無中文譯名可用）維持原樣。
   快照日期 2026-08-25，2026-08-26 加南亞科、清理中英夾雜名稱。

   2026-09-02：比對 00409A（主動復華全球50）51 檔實際持股，補 5 檔進現有族群
   （600183.SS 廣東生益、HOOD、BMNR、8473.T、034020.KS）+ 開 3 個新組（原物料能源貴金屬、
   醫療科技與生技、精密光學元件）。同時修 lib/exchangeMap.ts：中國 A 股 Bloomberg 統一用
   " CH" 後綴（滬深要看代碼開頭數字分，不是簡單 1:1 對照），先前完全沒處理，600183 CH
   這類持股會原樣卡在彭博格式，永遠 join 不到 600183.SS。現 19→22 組、160→174 檔。

   2026-09-07：比對 00409A(57檔)、00988A(49檔) 最新持股（申報日 2026/09/03），補 6 檔進現有族群
   （3308.HK 中際旭創-H → CPO，與既有 300308.SZ 同一家公司的港股掛牌線，比照 GOOG/GOOGL；
   992.HK 聯想 → 伺服器整機與機構件；5274.TWO 信驊 → 算力與 IC 設計（fabless BMC 晶片）；
   AEM 艾格尼可鷹、EQT 天然氣 → 原物料能源貴金屬；NTRA → 醫療科技與生技，與同組 TEM 同性質）
   ＋開 1 個新組「消費網路與平台」（EXPE Expedia、DASH DoorDash，前 22 組接不住的線上旅遊／外送平台）。
   現 22→23 組、174→182 檔。

   2026-09-14：比對 00409A(50檔)／00411A(34檔)／00990A(48檔)／00988A(42檔) 最新持股（申報日
   2026/09/10），補 11 檔進現有族群、**不開新組**（這批都接得住）。組數維持 23、182→193 檔。
   ⚠ 台股後綴一律查 TWSE ISIN 確認，不要用「4 碼就是 .TW」猜：**3529 力旺與 6510 精測是上櫃
   （.TWO）**，寫成 .TW 會在熱力圖/RRG 查無報價。
     半導體設備測試 ← 6510.TWO 中華精測（探針卡，與同組 6223 旺矽同性質）、2360.TW 致茂
       （量測設備）、7769.TW 鴻勁（測試分選機）、300757.SZ 羅博特科（收購 ficonTEC 後主攻
       光電子封裝/測試設備，本質仍是設備廠）
     算力與 IC 設計 ← 3529.TWO 力旺（矽智財，組名本來就含 IP，同組已有 3443 創意/3661 世芯）
     光通訊與矽光子/CPO ← AXTI（InP/GaAs 基板是光通訊雷射晶片的上游材料；同組已有 3081 聯亞
       這類上游磊晶/雷射晶片廠，故不另開「化合物半導體」單檔組）
     軟體資安與 AI 雲端 ← FSLY Fastly（與同組 NET Cloudflare 是直接競品）
     高速傳輸與網通介面 ← 3665.TW 貿聯-KY（AI 伺服器 224G 高速銅纜／線束）、NOK 諾基亞
       （網通設備商，與同組 CSCO 同性質；併購 Infinera 後光通訊線也在內）
     原物料能源貴金屬 ← KGC Kinross（金礦，同組已有 AEM/WPM/GDX）
     醫療科技與生技 ← TWST Twist Bioscience（合成 DNA，與同組 NTRA/TEM 同性質） */

export const BUILTIN_GROUPS_OVERSEAS: SectorGroup[] = [
  { name: '算力與 IC 設計 (CPU / GPU / ASIC / IP)', codes: ['AMD', '2454.TW', 'ARM', 'INTC', 'NVDA', 'QCOM', 'AVGO', '3661.TW', '3443.TW', 'CDNS', 'CBRS', '5274.TWO', '3529.TWO'], builtin: true },
  { name: 'AI 資料中心電力、燃料電池與核能基建', codes: ['BE', 'PLUG', 'FCEL', 'VRT', 'ETN', 'GEV', 'CEG', 'VST', 'OKLO', 'SMR', '6508.T', '034020.KS'], builtin: true },
  { name: '低軌衛星與太空科技 (LEO Satellite & Aerospace)', codes: ['ASTS', 'RKLB', 'IRDM', 'SATS', 'GSAT', 'PL', '3491.TWO', '6285.TW', 'SPCX'], builtin: true },
  { name: '半導體設備、測試與探針卡', codes: ['6223.TWO', '6871.T', 'TER', 'FORM', 'AIXA.DE', 'AEHR', '095340.KS', 'ASML', 'AMAT', 'LRCX', 'KLAC', '8035.T', '6857.T', '6515.TW', '6510.TWO', '2360.TW', '7769.TW', '300757.SZ'], builtin: true },
  { name: '晶圓代工與封測製造 (Foundry & OSAT)', codes: ['2330.TW', 'TSM', 'TSEM', '3711.TW', 'GFS', '2303.TW', 'AMKR', '2449.TW'], builtin: true },
  { name: '光通訊與矽光子 / CPO (Optical & CPO)', codes: ['LITE', 'COHR', '300308.SZ', '3308.HK', '4979.TWO', 'FN', 'CIEN', '6442.TW', '3363.TWO', '3081.TWO', 'AXTI'], builtin: true },
  { name: '載板與高階 PCB / 材料 (Substrates & PCB)', codes: ['3037.TW', '2383.TW', '301377.SZ', '8046.TW', '3189.TW', '4062.T', '6967.T', '2368.TW', '6274.TW', '600183.SS'], builtin: true },
  { name: '記憶體與高容量儲存 (Memory & Storage)', codes: ['MU', '285A.T', 'STX', 'WDC', '000660.KS', '005930.KS', 'PSTG', '8299.TWO', '2408.TW', 'SNDK'], builtin: true },
  { name: '軟體、資安與 AI 雲端服務 (SaaS & Security)', codes: ['PANW', 'SNOW', 'PLTR', 'NET', 'TWLO', '4180.T', 'CRWD', 'NOW', 'DDOG', 'ZS', 'CRM', 'NTSK', 'FSLY'], builtin: true },
  { name: '高速傳輸與網通介面 (Transmission & Networking)', codes: ['CRDO', 'MRVL', '5801.T', 'ANET', 'ALAB', 'CSCO', '2379.TW', 'SMTC', '2345.TW', '3665.TW', 'NOK'], builtin: true },
  { name: '被動元件與電子零組件 (Passive Components)', codes: ['009150.KS', '6981.T', '300408.SZ', '2327.TW', '6997.T', '6762.T', '6976.T', '2492.TW', '3026.TW', 'SITM'], builtin: true },
  { name: 'AI 伺服器電源與散熱 (Power & Cooling)', codes: ['2308.TW', '3017.TW', '3324.TW', '3653.TW', '2301.TW', 'SMCI', '8996.TW'], builtin: true },
  { name: '車用與功率半導體 (Power & Auto Chips)', codes: ['IFX.DE', 'MPWR', 'TXN', 'STM', 'ON', 'NXPI'], builtin: true },
  { name: '超級雲端巨頭 (Hyperscalers)', codes: ['MSFT', 'GOOGL', 'GOOG', 'AMZN', 'META', 'AAPL'], builtin: true },
  { name: '金融科技與數位支付 (FinTech & Payments)', codes: ['CRCL', 'V', 'MA', 'COIN', 'SQ', 'HOOD', 'BMNR', '8473.T'], builtin: true },
  /* 以下 4 組為 2026-08-26 新增：原始 CSV 是「零組件供應鏈」視角，接不住主動式ETF 實際
     押的幾條主線（算力租賃、伺服器整機、電動車/自駕、量子）。成分股取自 00411A 與
     00988A 的實際持股，再各補同業補齊族群輪廓。
     ⚠ SMCI 仍留在「AI 伺服器電源與散熱」（原始 CSV 的分類），沒有搬到伺服器組——
     一檔股票只能屬於一組，搬動會改變既有那組的曝險數字，留待需要時再決定。 */
  { name: 'AI 算力租賃 (Neocloud)', codes: ['CRWV', 'NBIS', 'IREN', 'APLD', 'CIFR', 'WULF'], builtin: true },
  // 含整機/ODM 與機構件：川湖(滑軌)、勤誠(機殼)是伺服器機構件龍頭，不是散熱件——
  // 2059 一度誤放在「電源與散熱」，2026-08-26 修正歸位。
  { name: 'AI 伺服器整機與機構件 (Server, ODM & Mechanicals)', codes: ['DELL', 'HPE', '992.HK', '6669.TW', '2382.TW', '3231.TW', '2376.TW', '2059.TW', '8210.TW'], builtin: true },
  { name: '電動車、自駕與出行平台 (EV & Mobility)', codes: ['TSLA', 'UBER', '581A.T', 'RIVN', 'MBLY', 'XPEV', '7203.T'], builtin: true },
  { name: '量子運算 (Quantum Computing)', codes: ['IONQ', 'RGTI', 'QBTS', 'QUBT'], builtin: true },
  /* 以下 3 組為 2026-09-02 新增：比對 00409A（主動復華全球50）51 檔實際持股後，
     這批完全不屬於「科技供應鏈」視角，前一輪 19 組故意不收（見上一輪 commit 的
     「需要時再開新組」），現在真的需要了。 */
  { name: '原物料、能源與貴金屬 (Commodities & Energy)', codes: ['GDX', 'COPX', 'WPM', 'PSX', 'AEM', 'EQT', 'KGC'], builtin: true },
  { name: '醫療科技與生技 (Healthcare & Biotech)', codes: ['LLY', 'MRK', 'TEM', 'NTRA', 'TWST'], builtin: true },
  // 精密光學元件目前只有大立光一檔——刻意不硬塞進「光通訊與矽光子」（那組是通訊用零組件，
  // 大立光是手機相機鏡頭，製程與客戶完全不同），寧可先開一組只有 1 檔的類別。
  { name: '精密光學元件 (Precision Optics)', codes: ['3008.TW'], builtin: true },
  /* 2026-09-07 新增：00409A 的 EXPE、00988A 的 DASH 都是「消費網路／平台經濟」，
     跟前 22 組（清一色科技供應鏈／算力主線）完全不同性質，故獨立成組。
     UBER 留在「電動車、自駕與出行平台」不動（那組的敘事是出行，不是純平台）。 */
  { name: '消費網路與平台 (Consumer Internet & Platforms)', codes: ['EXPE', 'DASH'], builtin: true },
];

export const STOCK_NAMES_OVERSEAS: Record<string, string> = {
  // 2026-09-14 新增（比對 00409A/00411A/00990A/00988A 最新持股，補 11 檔進現有族群）
  '6510.TWO': '中華精測', '2360.TW': '致茂', '7769.TW': '鴻勁', '300757.SZ': '羅博特科',
  '3529.TWO': '力旺', 'AXTI': 'AXT', 'FSLY': 'Fastly', '3665.TW': '貿聯-KY',
  'NOK': '諾基亞', 'KGC': 'Kinross黃金', 'TWST': 'Twist Bioscience',
  // 2026-09-07 新增（比對 00409A/00988A 最新持股，補 6 檔進現有族群 + 1 個新族群）
  '3308.HK': '中際旭創-H', '992.HK': '聯想集團', '5274.TWO': '信驊',
  'AEM': 'Agnico Eagle 礦業', 'EQT': 'EQT天然氣', 'NTRA': 'Natera',
  'EXPE': 'Expedia', 'DASH': 'DoorDash',
  // 2026-09-02 新增（比對 00409A 實際持股，補 5 檔進現有族群 + 3 個新族群）
  '600183.SS': '廣東生益', 'HOOD': 'Robinhood', 'BMNR': 'BitMine Immersion',
  '8473.T': 'SBI控股', '034020.KS': '斗山重工業',
  'GDX': 'VanEck黃金礦業ETF', 'COPX': '全球銅礦生產商ETF', 'WPM': '惠頓貴金屬',
  'PSX': '菲利普66', 'LLY': '禮來', 'MRK': '默克', 'TEM': 'Tempus AI', '3008.TW': '大立光',
  // 2026-08-26 新增（補進現有族群 + 4 個新族群）
  'SNDK': '晟碟', 'SPCX': 'SpaceX', '6508.T': '明電舍', '8996.TW': '高力', '2059.TW': '川湖',
  'SMTC': 'Semtech', '2345.TW': '智邦', 'NTSK': 'Netskope', '3026.TW': '禾伸堂', 'SITM': 'SiTime',
  'CRWV': 'CoreWeave', 'NBIS': 'Nebius', 'IREN': 'IREN', 'APLD': 'Applied Digital',
  'CIFR': 'Cipher Mining', 'WULF': 'TeraWulf',
  'DELL': '戴爾', 'HPE': '慧與科技', '6669.TW': '緯穎', '2382.TW': '廣達', '3231.TW': '緯創', '2376.TW': '技嘉',
  '8210.TW': '勤誠',
  'TSLA': '特斯拉', 'UBER': 'Uber', '581A.T': 'GO', 'RIVN': 'Rivian', 'MBLY': 'Mobileye',
  'XPEV': '小鵬汽車', '7203.T': '豐田汽車',
  'IONQ': 'IonQ', 'RGTI': 'Rigetti', 'QBTS': 'D-Wave Quantum', 'QUBT': 'Quantum Computing',
  // 原清單漏掉的「同一家公司的另一個掛牌」與同供應鏈標的
  'GOOG': 'Alphabet C股', 'TSM': '台積電ADR', '6274.TW': '台燿',
  'CDNS': 'Cadence', 'CBRS': 'Cerebras',
  'AMD': '超微半導體',
  '2454.TW': '聯發科',
  'ARM': 'ARM Holdings',
  'INTC': '英特爾',
  'NVDA': '輝達',
  'QCOM': '高通',
  'AVGO': '博通',
  '3661.TW': '世芯-KY',
  '3443.TW': '創意電子',
  'BE': 'Bloom Energy',
  'PLUG': 'Plug Power',
  'FCEL': 'FuelCell Energy',
  'VRT': 'Vertiv Holdings',
  'ETN': 'Eaton Corp',
  'GEV': 'GE Vernova',
  'CEG': 'Constellation Energy',
  'VST': 'Vistra Corp',
  'OKLO': 'Oklo Inc',
  'SMR': 'NuScale Power',
  'ASTS': 'AST SpaceMobile',
  'RKLB': 'Rocket Lab',
  'IRDM': 'Iridium Communications',
  'SATS': 'EchoStar / Hughes',
  'GSAT': 'Globalstar',
  'PL': 'Planet Labs',
  '3491.TWO': '昇達科',
  '6285.TW': '啟碁',
  '6223.TWO': '旺矽',
  '6871.T': '日本微電子',
  'TER': '泰瑞達',
  'FORM': 'FormFactor',
  'AIXA.DE': '愛思強',
  'AEHR': 'Aehr Test Systems',
  '095340.KS': 'ISC Co Ltd',
  'ASML': '艾司摩爾',
  'AMAT': '應用材料',
  'LRCX': '科林研發',
  'KLAC': '科磊',
  '8035.T': '東京威力科創',
  '6857.T': '愛德萬測試',
  '6515.TW': '穎崴科技',
  '2330.TW': '台積電',
  'TSEM': '高塔半導體',
  '3711.TW': '日月光投控',
  'GFS': '格羅方德',
  '2303.TW': '聯電',
  'AMKR': '艾姆科',
  '2449.TW': '京元電子',
  'LITE': 'Lumentum Holdings',
  'COHR': '高意',
  '300308.SZ': '中際旭創',
  '4979.TWO': '華星光',
  'FN': 'Fabrinet',
  'CIEN': 'Ciena Corp',
  '6442.TW': '光聖',
  '3363.TWO': '上詮',
  '3081.TWO': '聯亞',
  '3037.TW': '欣興',
  '2383.TW': '台光電',
  '301377.SZ': '鼎泰高科',
  '8046.TW': '南電',
  '3189.TW': '景碩',
  '4062.T': '伊比電',
  '6967.T': '新光電氣',
  '2368.TW': '金像電',
  'MU': '美光科技',
  '285A.T': '鎧俠',
  'STX': '希捷科技',
  'WDC': '威騰電子',
  '000660.KS': 'SK海力士',
  '005930.KS': '三星電子',
  'PSTG': 'Pure Storage',
  '8299.TWO': '群聯電子',
  '2408.TW': '南亞科',
  'PANW': 'Palo Alto Networks',
  'SNOW': 'Snowflake',
  'PLTR': 'Palantir Technologies',
  'NET': 'Cloudflare',
  'TWLO': 'Twilio',
  '4180.T': '沛星',
  'CRWD': 'CrowdStrike',
  'NOW': 'ServiceNow',
  'DDOG': 'Datadog',
  'ZS': 'Zscaler',
  'CRM': 'Salesforce',
  'CRDO': 'Credo Technology',
  'MRVL': '邁威爾',
  '5801.T': '古河電氣工業',
  'ANET': 'Arista Networks',
  'ALAB': 'Astera Labs',
  'CSCO': '思科',
  '2379.TW': '瑞昱',
  '009150.KS': '三星電機',
  '6981.T': '村田製作所',
  '300408.SZ': '潮州三環',
  '2327.TW': '國巨',
  '6997.T': '日本化學工業',
  '6762.T': 'TDK Corp',
  '6976.T': '太陽誘電',
  '2492.TW': '華新科',
  '2308.TW': '台達電',
  '3017.TW': '奇鋐',
  '3324.TW': '雙鴻',
  '3653.TW': '健策',
  '2301.TW': '光寶科',
  'SMCI': '美超微',
  'IFX.DE': '英飛凌',
  'MPWR': '芯源系統',
  'TXN': '德州儀器',
  'STM': '意法半導體',
  'ON': '安森美',
  'NXPI': '恩智浦',
  'MSFT': '微軟',
  'GOOGL': 'Alphabet (Google)',
  'AMZN': '亞馬遜',
  'META': 'Meta Platforms',
  'AAPL': '蘋果',
  'CRCL': 'Circle Internet Group',
  'V': 'Visa',
  'MA': 'Mastercard',
  'COIN': 'Coinbase',
  'SQ': 'Block (Square)',
};
