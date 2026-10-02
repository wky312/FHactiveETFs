import { OverseasFundConfig } from './overseasFunds';

/* 台股主動式ETF 清單 —— 「台股收盤影響」分頁（lib/twImpact.ts）的候選基金範圍。
   欄位形狀直接沿用 OverseasFundConfig：那個介面其實只是「基金 + 持股來源」，
   跟海不海外無關（buildOverseasDayMap 本來就吃 fhtrust / cmoney 兩種來源）。

   為什麼不從 lib/breakIssue.ts 的 32 檔扣掉 OVERSEAS_FUNDS 自動導出：那份清單是給
   「掛牌破發追蹤」用的，生命週期不同（它需要掛牌日/發行價，也可能為了破發分析增減標的）。
   lib/overseasFunds.ts 的開頭就記過同樣的理由——避免一個分頁的編輯意外改掉另一個分頁的母體。

   2026-09-15 建立，22 檔全數實測 CMoney AssignID=代號 抓得到逐日持股。
   ⚠ 2026-10-03 起 CMoney（pocket.tw）改回 {"Error":{"Code":101,"Message":"Auth Failed"}}（HTTP 200），
     `source: 'cmoney'` 的即時補抓實質上是空轉。持股改由 `data/holdings/*.json` 存檔提供
     —— scripts/update_holdings.py 已改用各家投信官網（scripts/issuers/，自 active-etf-tracker
     移植）每日 commit 15 檔台股持股。buildOverseasDayMap 本來就「先讀存檔、再即時補」，所以
     這裡的 source 維持 'cmoney' 不動：CMoney 哪天恢復就會自動再接上，掛著也只是 catch 掉。
   ⚠ 存檔是打包進 bundle 的 → 新資料要等下次 `vercel --prod` 才會進站（見 HANDOVER）。
   ⚠ 尚無官網持股來源的 4 檔：00984A/00993A（安聯）、00406A/00995A（中信）需 Playwright 渲染，
     00407A（凱基）、00410A（永豐）兩家還沒研究過端點 —— 這 6 檔在 CMoney 恢復前沒有持股。
   00991A 刻意走 fhtrust(ETF23) 而非 CMoney：復華自家 API 是官方來源，且 T 日下午就掛出
   T 日持股（holdingsLag=0），比 CMoney 代理早也更準；其餘投信沒有可直接串的官方持股 API。 */
export const TW_ACTIVE_FUNDS: OverseasFundConfig[] = [
  { ticker: '00991A', name: '主動復華未來50',   source: 'fhtrust', fundId: 'ETF23'  },
  { ticker: '00981A', name: '主動統一台股增長', source: 'cmoney',  fundId: '00981A' },
  { ticker: '00992A', name: '主動群益科技創新', source: 'cmoney',  fundId: '00992A' },
  { ticker: '00403A', name: '主動統一升級50',   source: 'cmoney',  fundId: '00403A' },
  { ticker: '00980A', name: '主動野村台灣優選', source: 'cmoney',  fundId: '00980A' },
  { ticker: '00982A', name: '主動群益台灣強棒', source: 'cmoney',  fundId: '00982A' },
  { ticker: '00984A', name: '主動安聯台灣高息', source: 'cmoney',  fundId: '00984A' },
  { ticker: '00985A', name: '主動野村台灣50',   source: 'cmoney',  fundId: '00985A' },
  { ticker: '00987A', name: '主動台新優勢成長', source: 'cmoney',  fundId: '00987A' },
  { ticker: '00993A', name: '主動安聯台灣',     source: 'cmoney',  fundId: '00993A' },
  { ticker: '00994A', name: '主動第一金台股',   source: 'cmoney',  fundId: '00994A' },
  { ticker: '00995A', name: '主動中信台灣卓越', source: 'cmoney',  fundId: '00995A' },
  { ticker: '00996A', name: '主動兆豐台灣豐收', source: 'cmoney',  fundId: '00996A' },
  { ticker: '00999A', name: '主動野村台灣高息', source: 'cmoney',  fundId: '00999A' },
  { ticker: '00400A', name: '主動國泰動能高息', source: 'cmoney',  fundId: '00400A' },
  { ticker: '00401A', name: '主動摩根台灣鑫收', source: 'cmoney',  fundId: '00401A' },
  { ticker: '00404A', name: '主動聯博動能50',   source: 'cmoney',  fundId: '00404A' },
  { ticker: '00405A', name: '主動富邦台灣龍耀', source: 'cmoney',  fundId: '00405A' },
  { ticker: '00406A', name: '主動中信台灣收益', source: 'cmoney',  fundId: '00406A' },
  { ticker: '00407A', name: '主動凱基台灣',     source: 'cmoney',  fundId: '00407A' },
  { ticker: '00408A', name: '主動第一金優股息', source: 'cmoney',  fundId: '00408A' },
  { ticker: '00410A', name: '主動永豐科技趨勢', source: 'cmoney',  fundId: '00410A' },
];

export function listTwActiveFunds(): { ticker: string; name: string }[] {
  return TW_ACTIVE_FUNDS.map((f) => ({ ticker: f.ticker, name: f.name }));
}
