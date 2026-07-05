# develop-plan.md — 每日行銷亮點引擎

> 依據 [spec.md](spec.md)（需求）與 [design.md](design.md)（技術）。任務不含代碼，實作時參照 design 對應章節。

## Phase 0 — 基礎建設
- [x] T0-1 `config/highlight_thresholds.json`：照 design §4 全量閾值（spec §4 預設值）
- [x] T0-2 `.github/workflows/highlight_scan.yml`：workflow_dispatch＋force input＋commit-back（design §7）
- [x] T0-3 排程接線決定：cron-job.org 直打 GitHub dispatch API（etf-daily-line 先例）或 trigger route 擴充——見 design §7；若走直打則 **trigger route 不用改、免 Vercel 部署**

## Phase 1 — Script 骨架（scripts/highlight_scan.py）
- [x] T1-1 Config/State 層：`load_config`、`DedupState`、`load_state/save_state/prune_state`（design §3/§5.2）
- [x] T1-2 Data-access 層：11 個 `fetch_*` 函式（design §3/§6），含 fhtrust live top-up（design §0#6）
- [x] T1-3 `build_context`＋`sources_status`；`send_line_text/send_line_alert`；`write_daily_json`（design §5.1）
- [x] T1-4 `main()` 流程：交易日守門→context→rules→top5→訊息→冪等→推播→存檔（design §3 Main）

## Phase 2 — 規則引擎（TDD：先寫 fixture 測試再實作）
- [x] T2-1 `rule_r1`＋測試（AC-001/002）
- [x] T2-2 `rule_r2`＋測試（AC-003）
- [x] T2-3 `rule_r3`＋tier 去重＋測試（AC-004）
- [x] T2-4 `rule_r4`（連勝/排名/新高三子規則）＋測試（AC-005）
- [x] T2-5 `rule_r5`（streak/里程碑雙保險/單日第一）＋測試（AC-006）
- [x] T2-6 `select_top`＋`build_message`＋測試（AC-007/008、FR-02/03/07）

## Phase 3 — 整合驗證
- [x] T3-1 Mock 整合測試：無亮點日、同日冪等、own_holdings 故障降級、LINE 4xx、站上 API 逾時（design §9）
- [x] T3-2 本機 dry-run 實跑（真資料、`DRY_RUN=1` 不發 LINE）：檢視當日 JSON 產出與訊息預覽
- [x] T3-3 全測試綠燈＋dry-run 人工確認訊息品質

## Phase 4 — 上線
- [x] T4-1 GH secrets：`LINE_CHANNEL_TOKEN`/`LINE_TO`/`ATTR_SUPABASE_URL`/`ATTR_SUPABASE_ANON_KEY`（design §7 表；涉及跨專案憑證，**需使用者確認來源**）
- [x] T4-2 commit＋push（feature branch 或依使用者慣例直上 master）
- [x] T4-3 手動 `workflow_dispatch` 首跑實測（真推播一次驗收）
- [x] T4-4 排程接線：GH `schedule:` cron 已生效（保底）；cron-job.org 直打 dispatch API 為選配準時化（使用者手動，見 design §7）
- [x] T4-5 收尾：README/memory 更新、develop-plan 勾稽

## 測試策略
- L1 單元：規則函式/訊息組裝/狀態管理（pytest、fixture 內嵌，零網路）
- L2 整合：mock 外部回應走全流程（design §9 下表）
- L3 實跑：dry-run → 首次真推播人工驗收

## AC 勾稽
| AC | 任務 | | AC | 任務 |
|----|------|-|----|------|
| 001/002 | T2-1 | | 007 | T2-6/T3-1 |
| 003 | T2-2 | | 008 | T2-6 |
| 004 | T2-3 | | 009 | T1-4/T3-1 |
| 005 | T2-4 | | 010 | T3-1 |
| 006 | T2-5 | | 011 | T1-4 |
