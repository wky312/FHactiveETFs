# 001-daily-highlight-engine — 每日行銷亮點引擎

> 狀態: 已實作，上線中（Phase 4）
> 來源: [Concept Brief 2026-07-05](../../00-concepts/2026-07-05-marketing-highlight-engine-and-fund-flow.md)

收盤後自動掃描 00991A 相關數據，依規則產出「今日行銷亮點」，**只推播 LINE（個人 push）、不上網站**。歷史結果存 repo JSON。

| 文件 | 內容 |
|------|------|
| [spec.md](spec.md) | 需求真相：規則定義、訊息格式、AC |
| [design.md](design.md) | 技術真相：模組、資料流、演算法 |
| [develop-plan.md](develop-plan.md) | 任務拆解與進度 |

## 已定案的關鍵決策
- 範圍：**00991A 單檔**（v2 再擴 00998A／全產品線）
- 輸出：**LINE push 給個人**（沿用 etf-daily-line channel，secrets：`LINE_CHANNEL_TOKEN`/`LINE_TO`）；**不做網站分頁**（網站會被其他人看到）
- 規則：v1 上規則 1–5（持股亮點、獨門股、操作驗證、績效里程碑、資金流）；規則 6 受益人數（需 TDCC fetcher）留 v2
- 架構：獨立 `highlight_scan.py`＋獨立 workflow，import 重用 `daily_summary.py` 的 fetcher
- 文案：確定性模板（不用 LLM）
