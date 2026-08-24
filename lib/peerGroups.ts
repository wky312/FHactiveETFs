// 同業/比較標的清單（client-safe，不含任何伺服器端相依）。
// peer-performance、cumulative-return route 與前端分頁共用同一份定義。

export interface PeerItem {
  ticker: string;
  yfTicker: string;
  name: string;
  /* true = 這一列是「對照基準」而非同業標的（大盤指數、被動對標 ETF）。
     只影響表格最下方的等權平均——把 +104% 的費半指數算進「同業平均」會讓那個數字失去意義。 */
  benchmark?: boolean;
}

export const PEER_GROUPS: Record<string, { label: string; items: PeerItem[] }> = {
  active: {
    label: '台股主動式ETF',
    items: [
      { ticker: '00980A', yfTicker: '00980A.TW', name: '主動野村台灣優選' },
      { ticker: '00981A', yfTicker: '00981A.TW', name: '主動統一台股增長' },
      { ticker: '00982A', yfTicker: '00982A.TW', name: '主動群益台灣強棒' },
      { ticker: '00984A', yfTicker: '00984A.TW', name: '主動安聯台灣高息' },
      { ticker: '00985A', yfTicker: '00985A.TW', name: '主動野村台灣50' },
      { ticker: '00987A', yfTicker: '00987A.TW', name: '主動台新優勢成長' },
      { ticker: '00991A', yfTicker: '00991A.TW', name: '主動復華未來50' },
      { ticker: '00992A', yfTicker: '00992A.TW', name: '主動群益科技創新' },
      { ticker: '00993A', yfTicker: '00993A.TW', name: '主動安聯台灣' },
      { ticker: '00994A', yfTicker: '00994A.TW', name: '主動第一金台股優' },
      { ticker: '00995A', yfTicker: '00995A.TW', name: '主動中信台灣卓越' },
      { ticker: '00996A', yfTicker: '00996A.TW', name: '主動兆豐台灣豐收' },
      { ticker: '00999A', yfTicker: '00999A.TW', name: '主動野村台灣高息' },
      { ticker: '00400A', yfTicker: '00400A.TW', name: '主動國泰動能高息' },
      { ticker: '00401A', yfTicker: '00401A.TW', name: '主動摩根台灣鑫收' },
      { ticker: '00403A', yfTicker: '00403A.TW', name: '主動統一升級50' },
      { ticker: '00405A', yfTicker: '00405A.TW', name: '主動富邦台灣龍耀' },
      { ticker: '00408A', yfTicker: '00408A.TW', name: '主動第一金優股息' },
      { ticker: '0050',   yfTicker: '0050.TW',   name: '元大台灣50',   benchmark: true },
      { ticker: '^TWII',  yfTicker: '^TWII',     name: '台灣加權指數', benchmark: true },
      { ticker: '^TWOII', yfTicker: '^TWOII',    name: '台灣OTC指數',  benchmark: true },
    ],
  },
  overseas: {
    label: '海外主動式ETF',
    items: [
      { ticker: '00983A', yfTicker: '00983A.TW', name: '主動中信ARK創新' },
      { ticker: '00986A', yfTicker: '00986A.TW', name: '主動台新全球龍頭' },
      { ticker: '00988A', yfTicker: '00988A.TW', name: '主動統一全球創新' },
      { ticker: '00989A', yfTicker: '00989A.TW', name: '主動摩根美國科技' },
      { ticker: '00990A', yfTicker: '00990A.TW', name: '主動元大AI新經濟' },
      { ticker: '00997A', yfTicker: '00997A.TW', name: '主動群益美國增長' },
      { ticker: '00998A', yfTicker: '00998A.TWO', name: '主動復華全球金融' },
      { ticker: '00402A', yfTicker: '00402A.TW', name: '主動安聯美國科技' },
      { ticker: '00409A', yfTicker: '00409A.TW', name: '主動復華全球50' },
      /* 美股對照組。要「還原權息」就得挑對 Yahoo 代號——一般指數（^IXIC/^GSPC）是價格指數，
         adjClose 等於 close、配息完全沒算進去，所以改用官方總報酬指數：
           ^XCMP    = NASDAQ Composite Total Return
           ^SP500TR = S&P 500 (TR)
         QQQ 是 ETF，Yahoo 的 adjClose 本來就已還原配息。
         費半只有價格指數：^SOXTR / ^SPSIST 在 Yahoo 都查無此代號（2026-08 實測），
         所以 ^SOX 是價格報酬，已在分頁註腳標明。 */
      { ticker: '^XCMP',    yfTicker: '^XCMP',    name: 'NASDAQ綜合(含息)', benchmark: true },
      { ticker: 'QQQ',      yfTicker: 'QQQ',      name: 'QQQ 那斯達克100',  benchmark: true },
      { ticker: '^SOX',     yfTicker: '^SOX',     name: '費城半導體(價格)', benchmark: true },
      { ticker: '^SP500TR', yfTicker: '^SP500TR', name: 'S&P500(含息)',     benchmark: true },
    ],
  },
  tw50: {
    label: '台股50',
    items: [
      { ticker: '00935',  yfTicker: '00935.TW',  name: '野村臺灣新科技50' },
      { ticker: '006201', yfTicker: '006201.TW', name: '元大富櫃50' },
      { ticker: '00991A', yfTicker: '00991A.TW', name: '主動復華未來50' },
      { ticker: '009802', yfTicker: '009802.TW', name: '富邦旗艦50' },
      { ticker: '009803', yfTicker: '009803.TW', name: '玉山市值動能50' },
      { ticker: '00923',  yfTicker: '00923.TW',  name: '群益台ESG低碳50' },
      { ticker: '009804', yfTicker: '009804.TW', name: '聯邦台精彩50' },
      { ticker: '00985A', yfTicker: '00985A.TW', name: '主動野村台灣50' },
      { ticker: '00952',  yfTicker: '00952.TW',  name: '凱基台灣AI50' },
      { ticker: '00922',  yfTicker: '00922.TW',  name: '國泰台灣領袖50' },
      { ticker: '0050',   yfTicker: '0050.TW',   name: '元大台灣50' },
      { ticker: '009809', yfTicker: '009809.TW', name: '富邦淨零ESG50' },
      { ticker: '006208', yfTicker: '006208.TW', name: '富邦台50' },
      { ticker: '009808', yfTicker: '009808.TW', name: '華南永昌優選50' },
      { ticker: '00912',  yfTicker: '00912.TW',  name: '中信臺灣智慧50' },
      { ticker: '009816', yfTicker: '009816.TW', name: '凱基台灣TOP50' },
      { ticker: '00403A', yfTicker: '00403A.TW', name: '主動統一升級50' },
      { ticker: '^TWII',  yfTicker: '^TWII',     name: '台灣加權指數', benchmark: true },
      { ticker: '^TWOII', yfTicker: '^TWOII',    name: '台灣OTC指數',  benchmark: true },
    ],
  },
};
