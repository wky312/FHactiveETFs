# HANDOVER — 交接與維運指南

> 2026-07-06 由 Claude（Fable 5）撰寫。給未來的維護者（人類或 AI 助手）：**動手前先讀這份**，再讀對應 feature 的 `docs/03-features/*/design.md`。

## 0. 天條（違反會出事的事）

1. **這個 repo 必須保持 private。** `data/highlights/` 存的是未經法遵的行銷草稿句，repo 轉 public＝內部素材外洩。
2. **行銷素材類內容永遠不上網站。** fhactiveetf.vercel.app 會被其他同仁/外部人看到；亮點引擎的一切產出只走 LINE 個人推播＋repo JSON，**不得新增任何前端路由/分頁**去呈現它。
   - **例外（2026-08-10，使用者明確核准）**：持股清單頁（`?tab=holdings`）的「創新高強勢股」模式（`components/HoldingsTab.tsx` 內 `mode='newhigh'`＋`app/api/holdings-newhigh`）。理由：該模式只疊加**已經公開顯示在同一頁**的持股代碼/權重，加上**公開市場價格**算出的 YTD 還原權息報酬與是否創今年新高，**不含**經理人操作意圖、事件日期、草稿句等亮點引擎才有的敏感內容，性質不同於亮點引擎。目前僅 00991A 開放。日後若要再開放同類「上站」功能，比照此例外先跟使用者確認，不要預設套用天條。
3. **Vercel 沒有接 git 自動部署。** push 到 GitHub 不會改變網站；改了 `app/`、`components/`、`lib/` 要手動 `vercel --prod`（CLI 已登入，專案 `fhactiveetf`）。反過來說：只改 `scripts/`、`config/`、workflow、docs 時**不需要**部署。
4. **`.env.local` 的值帶雙引號。** 用 `gh secret set` 搬值前要先去引號（`sed 's/^"//;s/"$//'`），否則 secret 值含引號、requests 會炸（2026-07-05 實際踩過）。
5. **對外數字必須可辯護。** 亮點文案中「同業第一」只能指 `peer_redemption` 觀測群（tw_active 14 檔＝規模百億以上＋擦邊三檔，2026-07-28 由 6 檔擴編），「持有最重」是 ATTR 動態 universe（約 20 檔）——不同母體，模板已寫死正確措辭（檔數是 `len(day_rows)` 動態帶入），改文案時不要放大宣稱。

## 1. 這個 repo 的全貌

| 部分 | 內容 | 部署方式 |
|------|------|----------|
| 網站 | Next.js 16 dashboard（13+ 分頁，inline style 非 Tailwind，Plotly CDN） | 手動 `vercel --prod` |
| 排程 scripts | `daily_summary.py`（17:15 摘要+申贖入庫）、`update_holdings.py`（持股存檔）、`highlight_scan.py`（亮點） | GitHub Actions，push 即生效 |
| 資料 | `data/holdings/`（持股 git-as-database）、`data/highlights/`（亮點+狀態） | workflow 自動 commit |
| SDD 文件 | `docs/00-concepts/`（概念探索）、`docs/03-features/`（spec/design/develop-plan） | — |

兩個 Supabase 專案，**不要混用**：
- `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`：本專案自己的（`peer_redemption`、`unit_watch` 表）。
- `ATTR_SUPABASE_URL`/`ATTR_SUPABASE_ANON_KEY`：active-etf-tracker 專案的（`etf`/`holding`/`price` 表，唯讀 anon），attribution 分頁與亮點引擎共用。

**單位數注意商品**（2026-07-15 新增，分頁在「其他」分組）：監測 00986D（fundId `ETF25`）每日在外流通單位數（fhtrust PCF 的 `qIssue`，鍵值為 `postDate`，非 `actBuyValDate`——與規模分頁的結算日落後欄位不同，已手動探測確認）。`daily_summary.py` 每日 17:15 順便存檔（不發 Pushover，失敗不影響其他區塊告警）；一次性回補用 `scripts/backfill_unit_watch.py`（GitHub Actions「Backfill Unit Watch Data」手動觸發）。**表要先手動跑 `scripts/sql/2026-07-15_create_unit_watch.sql`（Supabase SQL Editor）才會存在**，之後才能 backfill。門檻/產品清單集中在 `lib/unitWatch.ts`（`UNIT_WATCH_PRODUCTS`），新增監測商品只需在該陣列加一筆。

**受益人數**（2026-08-31 新增，分頁在「同業觀測」分組）：TDCC 集保股權分散表，每週一列 × 每檔 × 15 個持股分級，存 Supabase `beneficiary_counts`（**表要先手動跑 `scripts/sql/2026-08-31_create_beneficiary_counts.sql`**，RLS 開、不加 policy，讀寫都走 service role 會繞過）。追蹤台股 21 檔（以共用 Supabase `etf` 表為準，比 `lib/peerGroups.ts` 多 00404A/00406A/00407A）＋海外 10 檔。
- **兩條抓取路徑**：每週增量走開放資料 CSV（`scripts/beneficiary_fetch.py`，一次回全市場、只打 1 次請求，`beneficiary_weekly.yml` 週六 10:00 排程）；歷史回補走查詢頁（`scripts/backfill_beneficiary.py`，`backfill_beneficiary.yml` 手動觸發、冪等、可用 `TICKERS`/`MAX_WEEKS` 分批）。
- ⚠️ **集保只保存最近 51 週，過了就永遠沒有** → 每週存檔是唯一累積長序列的方法，週排程不能長期掛掉。
- ⚠️ **查詢頁要 CSRF**：不帶 cookie + `SYNCHRONIZER_TOKEN` 會回 HTTP 200 的空表單頁（不是錯誤碼），token 用過即失效、每次查詢都要重新 GET；表單欄位名是小寫開頭（`stockNo`/`sqlMethod`）。
- ⚠️ **合計列一律看 `level === 17`**，不可用「表中最後一列」：有「差異數調整」列時合計在第 17 列、沒有時在第 16 列。兩種情況都有 fixture 測到（`scripts/test_beneficiary.py`，16 項）。
- ⚠️⚠️ **TDCC 資料日 T ＝ 官方在外流通單位數的 T−2 個交易日**（T+2 交割才進集保）。2026-08 以 00991A 逐週對 `pcf_FundQissue` 驗證，五週一單位不差。**拿受益人數/單位數跟申贖分頁對照時必須把資料日往前推 2 個交易日**，否則區間錯位；端點碰上巨額申贖時兩邊方向會完全相反（00991A 7/31 單日申購 +9.47 億單位 → TDCC 看 7/31→8/28 是 +1.09 億，申贖看同區間是 −9.98 億）。分頁註腳已標紅警語。
- 前端：`lib/beneficiary.ts`（標的清單、5 組級距聚合、`diffLevels`/`groupShares`/`trendPoints`/`fundStats`/`commonWeeks` 純函式）、`app/api/beneficiary/route.ts`、`components/BeneficiaryTab.tsx`（人數趨勢／級距結構／**兩檔對照**三檢視）。**兩檔對照**：打兩次同一支 API，總體＋五組聚合＋各級距人數變動率並排橫條圖＋超大戶專區；週次只能選兩檔交集（掛牌時間不同），預設「最新 vs 4 週前」（週對週的結構變化太小看不出形狀）。選擇值不在交集內就推導退回預設，不用 effect 改 state。「每人平均持有」＝級距單位數 ÷ 人數，用來分辨「人變多」與「每人買更多」；但級距是固定區間、人會跨級移動，是「當期落在此級的人」的平均。

**個股代碼格式與國家判定（2026-09-02 修）**：復華 API 對**台股給裸 4 碼**（`2383`）、外國股給**彭博式空格＋兩碼**（`NVDA US`、`600183 CH`）。兩個獨立的洞讓 00409A 的國家配置有 12 檔 / 18.20% 是 Unknown：
- ① 裸 4 碼沒有後綴 → `getSuffixCountry('')` 回 Unknown。以前只有 ETF23 靠 `fetchHoldings` 尾端「整批把 Unknown 補成台灣」蓋過去，所以 **00991A 看起來正常、全球型基金才爆**。已改成 `resolveCountry` 用 `TW_BARE_CODE` 通則判定。
- ② `EXCHANGE_MAP` 缺彭博 ` CH`（中國）。⚠️ **` CN` 是加拿大、` CH` 才是中國**；` CH` 同時涵蓋滬深，Yahoo 後綴不同（**6xxxxx→`.SS`、0/3xxxxx→`.SZ`**），所以實際後綴在 `stockidToYfTicker` 依代號開頭再分一次，不能只靠 suffix 表。
- **查價路徑抽成 `lib/exchangeMap.ts` 的 `resolveYfTicker()`**：同一段「`isTwOnly && !suffix` 就補 `.TW`」原本在 `lib/stockTrajectory.ts`、`/api/performance`、`/api/holdings-newhigh` **各寫一次且都硬編 `fundId === 'ETF23'`** → 00409A 的 11 檔台股在這三處都查不到價。改用裸 4 碼通則，`.TWO` 退路也適用於非純台股基金（實測 6274 台燿自動退 `.TWO`）。
- ⚠️ **刻意不改 `stockidToYfTicker` 本身**：它的輸出還被 `consensusOverseas` 當共識持股的 join key 與顯示代號（`sectorExposure` 有 `canonicalCode` 在兩邊剝後綴配對），動它會連帶改到那邊。查價一律走 `resolveYfTicker`。
- ⚠️ **個股軌跡的純數字捷徑**：`fetchTrajectory` 對 `/^\d{4,6}[A-Za-z]?$/` 曾直接 `stockid = qU`，等於假設「全數字＝台股代碼」→ 中國 A 股打 `600183` 永遠空白（打 `600183 CH` 或中文名反而查得到）。已改成先用**代碼第一段**比對持股清單（`matchHolding()`），找不到才維持原字串，保留「此基金未持有」訊息。

**國家配置分頁（2026-09-02）**：下方加上當日持股清單，**兩張獨立 Card、各自的 ref**（`countryRef` / `countryHoldingsRef`），所以「儲存 / 分享」各存各的圖。深連結加 `?etf=`：只帶 `?tab=` 的話對方一律開到預設的 00991A，現在 `?tab=country&etf=00409A` 才分得出是哪一檔。

⚠️ **新基金掛牌前 `data/holdings/{fundId}.json` 是空的，不代表 `update_holdings.py` 壞了**：00409A 的持股復華是**掛牌日（2026/09/02）才對外開放**，在那之前每天排程都是 `ETF26: +0 天，共 0 天`，掛牌後手動觸發一次就補齊成立日以來 8 天。**診斷時別被 CI 日誌的時間戳誤導**——Python stdout 在 CI 是塊緩衝、所有 print 到最後一起 flush，兩行只差 0.8 毫秒**不代表**迴圈沒跑；要看的是有沒有 stderr 的 `! {fund} {date} fetch error`。

**市場重要行事曆**（2026-09-22 新增，分頁 `?tab=calendar`，分組「市場行事曆」）：FOMC、美國數據、財報法說、選舉政治的時間軸＋手機訂閱 `webcal://fhactiveetf.vercel.app/api/market-calendar/ics`（`cat=`/`min=`/`alarm=` 可篩）。只放公開事件，**不得加入任何行銷切角**（天條 2）。
- **程式**：`lib/marketCalendar/`（`build.ts` 組裝、`sources/*` 各來源、`history.ts` 歷史反應、`store.ts` 快取、`ics.ts`）、`app/api/market-calendar/{route,ics/route}.ts`、`components/MarketCalendarTab.tsx`。
- **來源**：Fed 官網 HTML（FOMC，`*`＝SEP 點陣圖）、FRED（CPI/PPI/非農/PCE：歷史公布日用 `output_type=4` 首次公布日、未來排程用 `release/dates`；實際值取**公布當天的 ALFRED vintage** 才會跟新聞一致）、ForexFactory 週曆 JSON（市場預期）、Yahoo `calendarEvents`（NVDA/TSM 財報日）、`config/market-events.json`（選舉/外交/台灣央行/GTC＋歷史種子，**改完要 `vercel --prod`**）。財報觀察清單在 `lib/marketCalendar/config.ts` 的 `EARNINGS_WATCHLIST`。
- **快取**：本專案 Supabase `page_cache` 三個 key：`market_calendar_events_v1`（頁面讀）、`market_calendar_state_v1`（累積的預期值/實際值，**刪了會丟失歷史預期值，無法重建**）、`market_calendar_history_v1`（歷史反應，約每週或有新樣本滿 T+5 時重算）。超過 3 小時、或剛有事件公布，開頁時會用 `after()` 背景刷新。Vercel env 需 `FRED_API_KEY`、`CRON_SECRET`。
- ⚠️ **FRED 數列有缺月**（2025/10 政府關門 CPI 未公布）→ 月增/年增一律**用日期對齊前期**，不可用陣列位置（曾因此把 CPI 年增算成 3.7%，官方 3.4%）。
- ⚠️ **ForexFactory 會 429**：一小時最多抓一次（`ffFetchedAt`）；它只給本週，預期值自上線日起逐週累積。**ISM 沒有免費實際值來源**，用下一期的「前值」回填上一期（晚一個月）。FRED 實際值每次刷新最多回補 12 筆（每分鐘 120 次上限）。
- ISM 公布日依「每月第一個營業日（避開元旦、勞動節）」推算，本週被 ForexFactory 列出才算確認；CPI 等只排到 BLS 已公布的日程（通常到年底）。

## 2. 每日排程時序（台北時間）

| 名目時間 | 實際落地 | 任務 | 產出 |
|----------|----------|------|------|
| 14:00（UTC 06:00） | 約 16:00–18:00（GH cron 延遲 2–4h） | `highlight_scan.yml` | LINE 亮點推播＋`data/highlights/*.json` |
| 17:15（cron-job.org 觸發，準時） | 17:15 | `daily_summary.yml` | Pushover 摘要＋`peer_redemption` 入庫 |
| 18:00（cron-job.org 觸發，準時） | 18:00（資料沒到齊時每 3 分鐘重查到 19:30） | `daily_change_push.yml` | Pushover：00991A/00981A/00992A 當日加減碼（同 `?tab=dailychange`，打正式站 `/api/daily-change`）；冪等狀態 `data/daily_change_push/_state.json` |
| 17:30（UTC 09:30，GH cron） | 約 19:50–21:50 | `update_holdings.yml` | `data/holdings/*.json` commit |
| 06:00（UTC 22:00，**Vercel Cron**） | 同左（誤差 1 小時內） | `/api/market-calendar?refresh=1` | 市場行事曆刷新（page_cache） |

由此而來的兩個設計事實（改排程前務必理解）：
- 亮點掃描拿**當日持股**靠 fhtrust **即時補抓**（git 存檔那時還停在前一日）。
- R5 資金流吃到的申贖是**前一交易日**的（17:15 才入庫），按「資料日」去重（`_state.json` 的 `r5_last_data_date`），每個資料日恰推一次——這是設計內的一天延遲，不是 bug。

## 3. 亮點引擎維運手冊

完整技術文件：`docs/03-features/001-daily-highlight-engine/`（spec=需求、design=技術、develop-plan=任務勾稽）。

### 日常
- **沒收到推播**＝當日無亮點（靜默是正常的）或非交易日。想確認：看 `data/highlights/{date}.json` 的 `push.reason`。
- **workflow 紅燈**＝LINE 推播失敗或全資料源故障。推播失敗**不會**標記已推，下次執行自動重試，通常不用人工介入。
- 每日 JSON 裡 `candidates` 含**全部**候選（含未入選），`sources` 記錄各資料源狀態，`config_snapshot` 記當時閾值——回溯任何一天的決策都靠它。

### 調閾值
1. 改 `config/highlight_thresholds.json`（各規則門檻、top 5 上限、字數上限全在這）。
2. commit + push。
3. GitHub Actions → Daily Highlight Scan → Run workflow，`force=true`（繞過同日冪等鎖）、可選 `scan_date=YYYY-MM-DD` 重掃指定日。

### 常見故障對照
| 症狀 | 原因 | 影響 | 處理 |
|------|------|------|------|
| `sources.own_holdings='stale'` | fhtrust 當日資料未出/API 掛 | R1/R2 用最後已知權重，R3 不受影響 | 通常自癒，免處理 |
| `attr_supabase='fail'` | ATTR Supabase 掛或 key 失效 | R1 少「持有最重」句、R2 整條停 | 檢查 active-etf-tracker 專案狀態 |
| `peer_redemption='fail'` | 本專案 Supabase 掛 | R5 停 | 同時會影響網站申贖分頁，一起查 |
| 訊息尾「本日未掃描：Rx」 | 上述任一 | 對應規則當日缺席 | 記錄在 JSON，可隔日 force 重掃 |
| yfinance 大量 404 log | 個股 `.TW`/`.TWO` 試錯 | 無（fallback 機制） | 忽略 |

### LINE 通道
- Workflow secrets 優先序：`LINE_CHANNEL_TOKEN`/`LINE_TO`（未設）→ fallback `LINE_CHANNEL_ACCESS_TOKEN`/`LINE_USER_ID`（repo 既有，目前生效）。
- 要換成 etf-daily-line 那個 bot：把該專案用的同組值設進本 repo 的 `LINE_CHANNEL_TOKEN`/`LINE_TO` 即可自動切換。

### 準時化（選配）
GH cron 有 2–4 小時延遲。若要準時 14:00：cron-job.org 加 job，POST `https://api.github.com/repos/wky312/00998a-web/actions/workflows/highlight_scan.yml/dispatches`，body `{"ref":"master"}`，headers 帶 `Authorization: Bearer {GitHub PAT}`＋`Accept: application/vnd.github+json`＋`User-Agent: cron-job.org`（成功回 204）。與 GH cron 並存安全——腳本冪等，重複觸發不重推。參考 etf-daily-line 的 README 同模式。

### 00409A 版（2026-10-07 新增，清晨 06:00 送）
同一支 `highlight_scan.py`，用環境變數 `FUND_TICKER=00409A` 切換；設定集中在 `config/highlight_profiles.json`（預設 00991A，行為不變）。
- **workflow**：`highlight_scan_00409a.yml`。準時靠 cron-job.org（週二~六 06:00 Asia/Taipei，URL 換成 `.../workflows/highlight_scan_00409a.yml/dispatches`）；檔內 GH schedule（UTC 週一~五 22:00）只是備援，同日冪等鎖保證不重複推播。
- **掃描日**：台北日期的前一個平日（美股在台北清晨收盤；週一早上掃上週五）。報價一律走 Yahoo（台/美/日/韓），**最後一根日 K 的日期必須等於掃描日才算有報價**，該市場休市就自然略過，所以不用單一交易日曆擋。
- **輸出與去重狀態獨立**：`data/highlights/00409A/`（`_state.json` 與 00991A 不共用，否則一檔推過另一檔就被擋）。
- **同業比對（R1「持有最重」、R2 獨門/超配）**：ATTR 資料庫沒有 00409A 也沒有海外檔，所以改讀 repo 的 `data/holdings/*.json`（profile 的 `cross_files`，目前 10 檔海外主動 ETF，超過 15 天沒更新的同業略過），代碼去掉彭博後綴（`NVDA US`→`NVDA`）才對得上。文案母體寫「海外主動 ETF 觀測群」，**不可寫成「全市場」**（天條 5）。
- **R4**：同業排名改用 `overseas` 群組；**連勝對標關閉**（`benchmark_ticker: null`）——全球型對 0050 不可辯護，要開須先決定對標（QQQ/S&P500TR）並確認 cumulative-return 跨時區日期對齊。
- **R5**：`peer_group: overseas`。
- ⚠️ 00409A 持股是 T+1 才公告（`ETF26.json` 常比其他檔晚一天），R1/R2 權重用最後已知日；R3 用的是持股存檔的相鄰日差，不受影響。
- ⚠️ R3「至今 +X%」是**當地幣別**報酬（美股用美元），不含匯率。

**拆成兩份（2026-10-08）**：用 `MARKET_SCOPE` 切（profile 鍵 `00409A:us` / `00409A:asia`），個股依彭博後綴分市場（`_market_of`：US 後綴＝美股；台股裸碼＋JP/KS＝台日韓；其他後綴兩邊都不報）。
| 份數 | workflow | 時間 | 範圍 | 狀態目錄 |
|---|---|---|---|---|
| 美股 | `highlight_scan_00409a.yml` | 週二~六 06:00 | R1/R2/R3，只看美股持股，掃前一個平日 | `data/highlights/00409A/` |
| 台日韓 | `highlight_scan_00409a_asia.yml` | 週一~五 15:00 | R1~R5（基金層級的 R4 績效、R5 申贖放這份），只看台/日/韓持股，掃當日 | `data/highlights/00409A-asia/` |
- 為什麼台日韓是 15:00：日、韓股台北 14:30 才收盤。腳本也有保險——掃描日是今天且還沒到 14:45，會自動略過日韓股報價，不讓盤中價冒充收盤漲跌幅。
- 兩份**狀態必須分開**：掃描日會重疊（早上掃的 10/07 美股、下午掃的 10/07 台日韓），共用 `pushed_dates` 會讓後送的那份被擋。
- cron-job.org 要各建一個 job（URL 換成對應 workflow 檔名）。

### 測試
```bash
# 單元+整合（零網路、不污染 repo data/）
python -m pytest scripts/test_highlight_scan.py -q     # 32 項應全綠
# 真資料 dry-run（不發 LINE、不寫檔）
set -a && source .env.local && set +a
DRY_RUN=1 SCAN_DATE=2026-07-03 python scripts/highlight_scan.py
```
⚠️ 本機 Python 3.14 是 PEP 668 externally-managed，pip 裝不了——用 venv。改 `load_state`/`save_state` 之類函式時注意：路徑要在**呼叫時**解析（`path or STATE_PATH`），不要放預設參數，否則測試 monkeypatch 失效且會把測試狀態寫進真的 `data/highlights/`（踩過）。

## 4. 開發工作流程（SDD）

這個專案跑過一輪完整流程，照抄即可：
1. **概念探索** → `docs/00-concepts/YYYY-MM-DD-{title}.md`（方向、取捨、放棄原因都記錄）。
2. **feature-spec** → `docs/03-features/{NNN}-{name}/` 三件套：spec.md（What，含 AC）、design.md（How，**每個整合點都要對實際 code 驗證**）、develop-plan.md（任務勾稽）。
3. **實作前把 design 交給獨立 reviewer**（agent 或人）對照 codebase 審——這次抓到 2 個會靜默失效的 bug（API 缺必填參數、推播失敗仍標已推），非常值得。
4. 實作 → pytest 全綠 → 真資料 dry-run 人工看品質 → push → CI 首跑真實驗收 → 檢查 `data/highlights/` 產出。

## 5. Roadmap 與已決策事項

**v2 候選（優先序由使用者定）：**
- **R6 受益人數規則**：TDCC 開放資料 `smart.tdcc.com.tw/opendata/getOD.ashx?id=1-5`（每週五更、免 token、只回最新一週）；歷史回補走 TDCC 查詢頁（**已 PoC 驗證**：無驗證碼、CSRF token 每回應更新、可回補 51 週；00991A 受益人半年 79k→279k，本身就是素材）。
- 擴 00998A／全產品線（`FUND_TICKER` 目前寫死 00991A，擴充時抽參數）。
- Gemini 潤飾草稿句（選配按鈕思路）、餵入 etf-content-factory（該專案已有文案＋法遵產線）。

**已取消/暫緩（不要誤拾）：**
- ❌ 資金流網站分頁（2026-07-05 使用者取消）——TDCC 知識保留在 concept brief。
- ⏸ 經理人操作復盤分頁、全市場異動雷達、輿情整合——見 concept brief 的取捨表。

## 5.5 申贖來源的「公告日 vs 資料日」（2026-07-28 踩過，勿再犯）

各家投信的 PCF（申購買回清單）端點**幾乎都是用「公告日」查詢**，內容卻是前一個（海外型可能前 2-3 個）
交易日的資料。凡是這類來源，一律「試公告日候選 → 用回應裡的資料日欄位對齊交易日」，不要假設固定位移：

| 來源 | 查詢參數 | 回應中的資料日欄位 |
|---|---|---|
| 野村 nomura | `Date`（公告日） | `Entries.CNavDtStr` |
| 安聯 allianz | `Date`（公告日） | `Entries.CNavDt` |
| 中信 ctbc | `StartDate`（公告日） | `淨值日期` |
| 台新 tsit | `DataDate`（公告日） | `YYYY/M/D每基數實際申購總價金` 標籤前綴 |
| 凱基 kgi | `queryDate`（公告日） | `(YYYY/MM/DD)每受益權單位淨資產價值` 括號前綴 |
| 統一 ezmoney / 群益 capital / 元大 yuanta | 公告日 | `TranDate` / `date2` / `trandate`（本來就有驗） |
| 富邦 fubon / 國泰 cathay / 復華 fhtrust | **資料日** | 富邦驗標籤前綴、國泰驗 `preDate`、復華驗 `actBuyValDate` |

安聯/中信/台新原本直接把交易日當查詢日 → 整欄晚一天，已於 2026-07-28 修正（Python 與
`lib/*Scale.ts` 兩邊都改）。**Supabase `peer_redemption` 裡 2026-07-28 以前的 00983A /
00986A / 00402A 三檔仍是舊的位移資料**，要修就重跑 `backfill_peer_redemption.py`
（`START_DATE=2025-12-08`，upsert 會覆蓋）。

另外兩個口徑注意事項：
- **國泰 00400A 沒有公開「與前日已發行單位差異數」**，申贖是用「單位數差 × 每單位淨值」推算的
  （同 00998A 走 CMoney 的作法）；對外引用時要知道它是推估值。
- 凱基 `RedemptionVC` 回的 HTML **中文全部是數值 entity**（`&#x8207;`…），不解碼比對不到標籤；
  且 kgifund / nomurafunds 的憑證缺 Subject Key Identifier，Python 端要走 `_post_lax`。

### 熱門ETF 觀測群（`group='hot'`，2026-09-12 新增）

申贖分頁第四顆按鈕，7 檔被動式大型 ETF（欄位順序 0050 / 00631L / 0056 / 00878 / 00919 /
00929 / 00712 —— 00631L 刻意緊接 0050，同一個標的並排才看得出資金是進原型還是進正2）：
0050 / 00631L / 0056（元大 `yuanta`，key 就是代號）、
00878（國泰 `cathay`，FundCode `CN`）、00919（群益 `capital`，fundNo `195`）、
00929（復華 `fhtrust`，fundID `ETF21`）、00712（復華 `fhtrust`，fundID `ETF07`）。

- **只回補到 2026-01-01**（使用者指定「今年初開始」）。`PEER_ETFS` 這 7 筆都帶
  `since='2026-01-01'`，否則 DB 裡 2025-12 那幾天會永遠被判成缺漏、每天白抓一輪。
- **復華 fundID 的查法**：`GET /api/fundList` 回的每筆有 `fundID` 與 `etf002`（＝股票代號），
  對一次就有全表；官網掛維護頁時可退到 Wayback（`web.archive.org/web/<ts>id_/<url>`）。
- **`group='hot'` 是刻意隔離的**：亮點引擎 `fetch_peer_redemption_history` 寫死
  `group=eq.tw_active`，`build_peer_html` 也只收 tw_active，所以天條 5 的「同業第一」母體
  不受影響；Pushover 的淨申贖字串則另外排除 `group == 'hot'`（同業推播不混被動 ETF）。
- ⚠⚠ **PostgREST 一次只回 1000 列、超過的部分靜默消失**（2026-09-12 修）。`peer_redemption`
  是「一個交易日 × 一檔 ＝ 一列」，觀測群一大就很容易撞到：實測 `?group=tw_active` 拉
  2026-01-01→09-12，**分頁只回得到 5/29 以後的 74 天**，前四個月憑空不見、而且不會報錯。
  三個讀取點都已改成 `.range()` 分頁（排序要「全序」，`date`+`ticker` 就是主鍵）：
  `app/api/peer-redemption-db/route.ts`、`backfill_peer_redemption.get_complete_dates`、
  `daily_summary._fetch_existing_peer_keys`。**日後任何新的 peer_redemption 讀取一律照抄這個
  分頁寫法**，不要再寫裸 select。
- **只回補特定幾檔**：`backfill_peer_redemption.py` 吃 `ONLY_TICKERS='0050,0056,…'`
  （workflow 有對應的 `only_tickers` 輸入）。新增觀測群時每個舊日期都會少那幾檔 →
  完成度判斷會把整段區間標成未完成、連已入庫的 20 幾檔一起重抓（180 天 × 27 檔＝一小時起跳）。
  ⚠ `ignore_complete` 曾經一直是開著的（2026-09-12 修）：`github.event.inputs.<boolean>` 回的是
  **字串**，`'false' && '1'` 在 GH 運算式裡是 truthy → `IGNORE_COMPLETE` 永遠是 `'1'`、每次回補
  都整段重抓。已改成 `== 'true'` 明確比對；要補幾個洞時記得**不要**勾這個選項。
- **0050 於 2026-06-18 一拆四**：netSub 取「同日單位數差 × 同日每單位淨值」，拆分前後各自
  自洽，**不要**再另外做還原調整。
- ⚠⚠ **公告日掃描視窗一定要涵蓋 9 天年假**：2026 春節 2/12–2/20 全休，2/11（年前最後一個
  交易日）的申購買回清單要到 **2/23** 才公告——整整 12 個日曆日 / 8 個「營業日」之後。
  首次回補實測，元大三檔（掃 5 個日曆日）與群益（掃 5 個營業日，`_next_biz_day` 只跳週末
  不認國定假日）在 2/11 全部靜靜回 None；國泰是往回找前一交易日（掃 10 個日曆日），在
  **2/23** 摸不到 2/11 而回 None。已分別放寬成 元大 14 個日曆日、群益 10 個營業日、
  國泰 16 個日曆日，Python 與 `lib/*Scale.ts` 兩邊都改。放寬不會變慢——各家都在
  「自報日期越過目標日」時提早收工，休市日反而比原本更省請求。
- ⚠ 00712 是美國 REITs，PCF 公告落後 **T+2 交易日**；`fetch_fhtrust_day` 為此把公告日候選
  從 8 個日曆日拉到 14（春節連休 9 天時 T+2 要等 11 天），並在自報 `actBuyValDate` 越過目標日
  時提早收工（單調遞增，掃過頭不可能再對上）。
- ⚠ 復華官網每隔一陣子會有整站維護（例：2026-09-12 08:00–20:00 全站回 HTML 公告頁），
  期間 00929/00712 兩欄會是空的——那是維護不是壞掉，維護結束後補跑 backfill 即可。

## 6. 給 AI 助手的額外提醒

- 使用者偏好：**除破壞性操作外自主執行不用問**；新專案放 `~/Claude/`；正體中文溝通。
- `AGENTS.md` 說要讀 `node_modules/next/dist/docs/`——該目錄**不存在**，照現有 App Router 慣例寫即可。
- 元件全用 inline style（`React.CSSProperties`），色票 `RED='#C00000'` 等每檔自宣告；**紅漲綠跌**（台灣慣例）。
- 網站 API route 的口徑（除息、先進位、anomaly 偵測）是唯一真相——需要報酬數字時**呼叫站上 API**，不要用 Python 重算一套（會口徑漂移）。
- 使用者的長期記憶在 Claude 的 memory 系統（`project_00998a_web.md` 等）；若你沒有 memory 存取，本檔案＋`docs/` 就是完整交接。
- 持股/比較/當日摘要三分頁的「強制查詢最新資料」按鈕會繞過 `lib/fhtrust.ts` 的 1 小時 fetch cache；`daily_summary.py` 的 Pushover 若標題帶 `⚠️`，代表抓到的資料日早於**該檔應該要有的**資料日（官網尚未更新），不是程式錯誤。基準逐檔不同，看 `ETFS` 的 `holdingsLag`（該檔持股本來就會落後幾個交易日）：國內檔 00991A=0（T 日下午就掛出 T 日持股），海外檔 00409A、00998A=1（T+1 才公告，今天拿到 T−1、對比 T−2 是正常的，停在 T−2 以前才告警）。這類 stale 告警是用 `priority=1` 發送，在 Pushover 端會繞過使用者的靜音時段（quiet hours）直接響鈴，不只是多顯示一個警示圖示，半夜也可能吵醒人。
