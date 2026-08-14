# 002 — 強制查詢按鈕 + Pushover 資料非最新警示

> 2026-08-14 由 Claude（Sonnet 5）撰寫，經使用者於對話中核准設計後落筆。

## 背景 / 動機

使用者反映兩個問題：

1. **網頁端**：`fhactiveetf.vercel.app`（`?tab=summary`）有時明明復華官網已補上最新持股，網頁卻還是顯示不出來。
2. **排程端**：`daily_summary.py` 每日固定排程（持股摘要、同業申贖）有時因為官網資料上傳較晚，抓到的其實是前一交易日的資料，但 Pushover 通知沒有明確提醒「這不是最新一天」。

## 根本原因（問題 1）

`lib/fhtrust.ts` 的 `fetchHoldings()` 用 Next.js fetch cache（`next:{revalidate:3600}`）抓官網持股，快取鍵含日期。若使用者在官網補資料**之前**查詢過某天，該天的（可能是空的）回應會被快取住最長 1 小時；官網補上資料後，1 小時內再查仍吃到同一份舊快取。`/api/pcf-snapshot`（規模/淨值）本來就是 `cache:'no-store'`，不受影響。

「持股比較」與「當日摘要」共用同一份 `baseData/cmpData`（同一個 `loadCompare`）；「持股清單」則是獨立的 `loadHoldings`。三者都走 `/api/holdings` → `fetchHoldings()`，都受同一個根因影響。

## 設計

### 功能 1：強制查詢按鈕

- `lib/fhtrust.ts`：`fetchHoldings(date, fundId, opts?: { force?: boolean })`。`force` 為真時，`fetch()` 改用 `cache: 'no-store'`（略過 Data Cache 直接打官網）；否則維持現有 `next:{revalidate:3600}` 行為不變。
- `app/api/holdings/route.ts`：讀取 query 參數 `force=1`，轉呼叫 `fetchHoldings(date, fundId, { force: true })`。
- `components/Dashboard.tsx`：
  - `fetchData(dateStr, fundId, force = false)` 在 URL 上多帶 `&force=1`（force 為真時）。
  - `loadHoldings(force = false)`、`loadCompare(force = false)` 把 `force` 往下傳。
  - 三處各加一顆「強制查詢最新資料」按鈕（沿用既有 `ActionButton` 元件）：
    - **持股清單**：既有控制列（`DateInput` + 「載入」）旁加一顆。
    - **持股比較**：既有控制列（兩個 `DateInput` + 「載入比較」）旁加一顆。
    - **當日摘要**：目前資料載入後完全沒有控制列 —— 在 `DailySummaryTab` 上方新增一個小工具列，只放這顆按鈕；未載入時的空狀態控制列也加一顆。因為與「持股比較」共用資料狀態，點擊效果會同步反映在兩頁。
- 不改變預設行為：一般「載入」按鈕不受影響，只有明確按下「強制查詢」才繞過快取。

### 功能 2：Pushover 資料非最新交易日警示

適用範圍：`scripts/daily_summary.py` 內兩個會發送 Pushover 通知的段落 —— `process_etf()`（00991A 當日摘要）與 `process_peer_redemption()`（同業申贖觀測）。

新增輔助函式：

```python
def latest_expected_trading_day(anchor: date, max_back: int = 10) -> date | None:
    """從 anchor（通常是「今天」）往回找最近一個 TWSE 交易日，作為「資料應該多新」的基準。
    TWSE 行事曆連不到時回 None —— 呼叫端不可把「無法判斷」當成「資料太舊」誤報。"""
```

實作：用檔案內既有的 `is_twse_trading_day()`（TWSE FMTQIK 官方行事曆）從 `anchor` 逐日往回檢查；第一天回傳 `None`（連不到官方行事曆）就整體回 `None`，第一天回傳 `True` 就回傳該日。

在 `process_etf` 與 `process_peer_redemption` 內，取得 `base_date` 後：

```python
expected = latest_expected_trading_day(today)
stale = expected is not None and base_date < expected
```

若 `stale` 為真：
- Pushover 標題前面加 `⚠️ ` 前綴。
- 內文附加一行：`⚠️ 官網尚未更新，此為 {base_date} 資料（最新交易日應為 {expected}）`。
- `send_pushover()` 呼叫帶 `priority=1`（比照現有「同業申贖抓到非交易日資料」等異常告警的等級，可繞過安靜時段）。

`send_pushover()` 需新增 `priority: int = 0` 參數並帶進 Pushover API 的 `data`。

**不誤報原則**：`expected is None`（TWSE 連不到）時一律不觸發警示，維持檔案內既有「無法判斷時不誤報」慣例。`TEST_DATE` 手動測試路徑天然不受影響（該路徑把測試日期當 `today` 傳入，`expected` 與 `base_date` 會一致）。

## 不動的部分

- `find_peer_base_date()`（fhtrust 掛掉時的 fallback，故意從 `today - 1` 開始找）維持現狀不改 —— 觸發時新警示會如實反映「這份是 T-1 資料」，這本來就是使用者想被提醒的情境，不需要特別處理。
- `highlight_scan.py`（亮點引擎）、`update_holdings.py`（git-as-database 存檔，不發 Pushover）不在本次範圍內。
- 一般（非強制）查詢的快取行為（`revalidate 3600`）維持不變，只是新增一個「繞過」選項。

## 測試

- 前端：手動在本機 `npm run dev` 驗證三個「強制查詢」按鈕都能觸發重新 fetch（可用瀏覽器 Network 面板確認請求帶 `force=1` 且回應不是 304/快取）。
- 排程：`latest_expected_trading_day()` 可用既有 `python -m pytest` 模式寫幾個純函式單元測試（mock `is_twse_trading_day`），不需要真連網。也可以用 `TEST_DATE` 手動跑一次確認沒有誤觸發警示。
