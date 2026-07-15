# HANDOVER — 交接與維運指南

> 2026-07-06 由 Claude（Fable 5）撰寫。給未來的維護者（人類或 AI 助手）：**動手前先讀這份**，再讀對應 feature 的 `docs/03-features/*/design.md`。

## 0. 天條（違反會出事的事）

1. **這個 repo 必須保持 private。** `data/highlights/` 存的是未經法遵的行銷草稿句，repo 轉 public＝內部素材外洩。
2. **行銷素材類內容永遠不上網站。** fhactiveetf.vercel.app 會被其他同仁/外部人看到；亮點引擎的一切產出只走 LINE 個人推播＋repo JSON，**不得新增任何前端路由/分頁**去呈現它。
3. **Vercel 沒有接 git 自動部署。** push 到 GitHub 不會改變網站；改了 `app/`、`components/`、`lib/` 要手動 `vercel --prod`（CLI 已登入，專案 `fhactiveetf`）。反過來說：只改 `scripts/`、`config/`、workflow、docs 時**不需要**部署。
4. **`.env.local` 的值帶雙引號。** 用 `gh secret set` 搬值前要先去引號（`sed 's/^"//;s/"$//'`），否則 secret 值含引號、requests 會炸（2026-07-05 實際踩過）。
5. **對外數字必須可辯護。** 亮點文案中「同業第一」只能指 `peer_redemption` 觀測群（6 檔），「持有最重」是 ATTR 動態 universe（約 20 檔）——不同母體，模板已寫死正確措辭，改文案時不要放大宣稱。

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

## 2. 每日排程時序（台北時間）

| 名目時間 | 實際落地 | 任務 | 產出 |
|----------|----------|------|------|
| 14:00（UTC 06:00） | 約 16:00–18:00（GH cron 延遲 2–4h） | `highlight_scan.yml` | LINE 亮點推播＋`data/highlights/*.json` |
| 17:15（cron-job.org 觸發，準時） | 17:15 | `daily_summary.yml` | Pushover 摘要＋`peer_redemption` 入庫 |
| 17:30（UTC 09:30，GH cron） | 約 19:50–21:50 | `update_holdings.yml` | `data/holdings/*.json` commit |

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

## 6. 給 AI 助手的額外提醒

- 使用者偏好：**除破壞性操作外自主執行不用問**；新專案放 `~/Claude/`；正體中文溝通。
- `AGENTS.md` 說要讀 `node_modules/next/dist/docs/`——該目錄**不存在**，照現有 App Router 慣例寫即可。
- 元件全用 inline style（`React.CSSProperties`），色票 `RED='#C00000'` 等每檔自宣告；**紅漲綠跌**（台灣慣例）。
- 網站 API route 的口徑（除息、先進位、anomaly 偵測）是唯一真相——需要報酬數字時**呼叫站上 API**，不要用 Python 重算一套（會口徑漂移）。
- 使用者的長期記憶在 Claude 的 memory 系統（`project_00998a_web.md` 等）；若你沒有 memory 存取，本檔案＋`docs/` 就是完整交接。
