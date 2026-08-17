# 強制查詢按鈕 + Pushover 資料非最新警示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓使用者能在網頁上強制繞過快取查詢官網最新持股資料，並讓 `daily_summary.py` 的 Pushover 通知在抓到「非最新交易日」資料時明確示警。

**Architecture:** 前端沿一條既有資料路徑（`Dashboard.tsx` → `/api/holdings` → `lib/fhtrust.ts`）加一個可選的 `force` 開關，讓 `fetch()` 從 `next:{revalidate:3600}` 切成 `cache:'no-store'`。排程端在 `daily_summary.py` 新增一個純函式，用既有的 TWSE 官方行事曆比對「抓到的資料日」與「應有的最新交易日」，不一致就在 Pushover 標題/內文/priority 上示警。兩塊互相獨立、可分開驗證。

**Tech Stack:** Next.js 16 App Router（TypeScript）、Python 3.11（GitHub Actions 排程腳本）、pytest。

## Global Constraints

- 這個 repo 是 private，且**沒有接 Vercel git 自動部署**：改 `app/`、`components/`、`lib/` 後必須手動 `vercel --prod` 才會上線；只改 `scripts/`、`docs/` 不需要部署，`git push` 後 GitHub Actions 就會用新版腳本。
- 元件一律用 inline style（`React.CSSProperties`），跟著 `Dashboard.tsx` 既有色票（`RED='#C00000'` 等）走，不要引入 Tailwind 或其他樣式方案。
- Python 端沿用檔案既有的錯誤處理慣例：外部請求失敗要印出訊息、不要讓單一資料源掛掉拖垮整支腳本（`try/except` + `print`，不要新增裸 `except: pass`）。
- 這個 repo 沒有 JS/TS 測試框架（`package.json` 只有 `dev/build/start/lint`），前端變更的驗證手段是 `npm run lint`、`npm run build`、以及手動 `npm run dev` + 瀏覽器 Network 面板確認；不要新增測試框架。
- Python 測試用 `python -m pytest scripts/<file>.py -q`，零網路、不能污染 `data/` 目錄（比照 `scripts/test_highlight_scan.py` 的既有模式：直接 `import daily_summary as ds`，用 `monkeypatch` 取代網路呼叫）。
- 對外數字/日期用語要精確：警示文案講「最新交易日應為 {expected}」，不要誇大或模糊措辭。

---

## File Structure

| 檔案 | 動作 | 責任 |
|---|---|---|
| `lib/fhtrust.ts` | 修改 | `fetchHoldings()` 加 `force` 選項，控制 fetch cache 行為 |
| `app/api/holdings/route.ts` | 修改 | 讀取 `?force=1`，往下傳給 `fetchHoldings` |
| `components/Dashboard.tsx` | 修改 | `fetchData`/`loadHoldings`/`loadCompare` 加 `force` 參數；3 處 UI 加「強制查詢最新資料」按鈕 |
| `scripts/daily_summary.py` | 修改 | 新增 `latest_expected_trading_day()`；`send_pushover()` 加 `priority` 參數；`process_etf`/`process_peer_redemption` 接上示警邏輯 |
| `scripts/test_daily_summary.py` | 新增 | `latest_expected_trading_day()` 的 pytest 單元測試（monkeypatch，零網路） |

---

### Task 1: 後端 — `fetchHoldings` 支援繞過快取

**Files:**
- Modify: `lib/fhtrust.ts:24-30`
- Modify: `app/api/holdings/route.ts`

**Interfaces:**
- Produces: `fetchHoldings(date: string, fundId?: string, opts?: { force?: boolean }): Promise<HoldingsResponse>` — `opts.force` 為 `true` 時用 `cache:'no-store'`，否則維持 `next:{revalidate:3600}`。
- Produces: `GET /api/holdings?date=...&fundId=...&force=1` — `force=1` 時繞過 Data Cache 直打官網。

- [ ] **Step 1: 修改 `fetchHoldings` 簽名與 fetch 選項**

編輯 `lib/fhtrust.ts`，把：

```ts
export async function fetchHoldings(date: string, fundId = 'ETF24'): Promise<HoldingsResponse> {
  const url = `${API_URL}?fundID=${fundId}&qDate=${encodeURIComponent(date)}`;
  const res = await fetch(url, {
    next: { revalidate: 3600 },
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`fhtrust API ${res.status}`);
```

改成：

```ts
export async function fetchHoldings(
  date: string,
  fundId = 'ETF24',
  opts?: { force?: boolean },
): Promise<HoldingsResponse> {
  const url = `${API_URL}?fundID=${fundId}&qDate=${encodeURIComponent(date)}`;
  const res = await fetch(url, {
    ...(opts?.force ? { cache: 'no-store' as const } : { next: { revalidate: 3600 } }),
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`fhtrust API ${res.status}`);
```

`opts?: { force?: boolean }` 是**新增的第三個參數**，既有呼叫端（不帶第三個參數）行為不變。

- [ ] **Step 2: 讓 API route 讀取並轉傳 `force`**

把 `app/api/holdings/route.ts` 整份改成：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { fetchHoldings } from '@/lib/fhtrust';

export async function GET(request: NextRequest) {
  const date   = request.nextUrl.searchParams.get('date');
  const fundId = request.nextUrl.searchParams.get('fundId') ?? 'ETF24';
  const force  = request.nextUrl.searchParams.get('force') === '1';
  if (!date) {
    return NextResponse.json({ error: '缺少 date 參數（格式：YYYY/MM/DD）' }, { status: 400 });
  }

  try {
    const data = await fetchHoldings(date, fundId, { force });
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
```

- [ ] **Step 3: 型別檢查 + lint**

Run: `npm run build`
Expected: 編譯成功（無 TypeScript 錯誤）。這個 repo 沒有專屬測試框架，`build` 是驗證型別正確性的手段。

Run: `npm run lint`
Expected: 無新增的 lint 錯誤。

- [ ] **Step 4: 手動驗證繞過快取生效**

Run: `npm run dev`（另開一個 terminal），伺服器啟動後執行：

```bash
curl -s "http://localhost:3000/api/holdings?date=2026/08/14&fundId=ETF23&force=1" | head -c 200
```

Expected: 回傳 JSON（不是 500），且終端機（跑 `npm run dev` 那個視窗）的 log 沒有出現快取相關錯誤。這一步只是確認 `force=1` 參數不會讓 route 掛掉；實際「有沒有真的繞過快取」在 Task 2 用瀏覽器 Network 面板一併驗證。

- [ ] **Step 5: Commit**

```bash
git add lib/fhtrust.ts app/api/holdings/route.ts
git commit -m "feat: fetchHoldings 支援 force 參數繞過 fetch cache

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: 前端 — 三處「強制查詢最新資料」按鈕

**Files:**
- Modify: `components/Dashboard.tsx`

**Interfaces:**
- Consumes: `fetchHoldings`/`/api/holdings?...&force=1`（Task 1）
- Produces: 無下游依賴（UI 終端任務）

- [ ] **Step 1: `fetchData` 加 `force` 參數並帶進 URL**

把：

```ts
  const fetchData = useCallback(async (dateStr: string, fundId: string): Promise<LoadedData> => {
    const res  = await fetch(`/api/holdings?date=${encodeURIComponent(toApiDate(dateStr))}&fundId=${encodeURIComponent(fundId)}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? '載入失敗');
    return json as LoadedData;
  }, []);
```

改成：

```ts
  const fetchData = useCallback(async (dateStr: string, fundId: string, force = false): Promise<LoadedData> => {
    const qs = `date=${encodeURIComponent(toApiDate(dateStr))}&fundId=${encodeURIComponent(fundId)}${force ? '&force=1' : ''}`;
    const res  = await fetch(`/api/holdings?${qs}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? '載入失敗');
    return json as LoadedData;
  }, []);
```

- [ ] **Step 2: `loadHoldings`／`loadCompare` 加 `force` 參數並往下傳**

把：

```ts
  const loadHoldings = useCallback(async () => {
    setHoldLoading(true); setHoldError('');
    try   { setHoldData(await fetchData(holdDate, selectedEtf.fundId)); }
    catch (e) { setHoldError(e instanceof Error ? e.message : '載入失敗'); }
    finally   { setHoldLoading(false); }
  }, [holdDate, selectedEtf, fetchData]);

  const loadCompare = useCallback(async () => {
    setCmpLoading(true); setCmpError('');
    try {
      const [b, c] = await Promise.all([fetchData(baseDate, selectedEtf.fundId), fetchData(cmpDate, selectedEtf.fundId)]);
      setBaseData(b); setCmpData(c);
    } catch (e) { setCmpError(e instanceof Error ? e.message : '載入失敗'); }
    finally     { setCmpLoading(false); }
  }, [baseDate, cmpDate, selectedEtf, fetchData]);
```

改成：

```ts
  const loadHoldings = useCallback(async (force = false) => {
    setHoldLoading(true); setHoldError('');
    try   { setHoldData(await fetchData(holdDate, selectedEtf.fundId, force)); }
    catch (e) { setHoldError(e instanceof Error ? e.message : '載入失敗'); }
    finally   { setHoldLoading(false); }
  }, [holdDate, selectedEtf, fetchData]);

  const loadCompare = useCallback(async (force = false) => {
    setCmpLoading(true); setCmpError('');
    try {
      const [b, c] = await Promise.all([
        fetchData(baseDate, selectedEtf.fundId, force),
        fetchData(cmpDate, selectedEtf.fundId, force),
      ]);
      setBaseData(b); setCmpData(c);
    } catch (e) { setCmpError(e instanceof Error ? e.message : '載入失敗'); }
    finally     { setCmpLoading(false); }
  }, [baseDate, cmpDate, selectedEtf, fetchData]);
```

`loadHoldings` 與 `loadCompare` 原本被直接當 `onClick={loadHoldings}` 用，`force` 有預設值 `false`，既有按鈕行為不變。

- [ ] **Step 3: 持股清單分頁加按鈕**

把：

```tsx
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 18, flexWrap: 'wrap' }}>
              <DateInput label="資料日期" value={holdDate} onChange={setHoldDate} />
              <ActionButton onClick={loadHoldings} loading={holdLoading} label="載入" />
            </div>
```

改成：

```tsx
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 18, flexWrap: 'wrap' }}>
              <DateInput label="資料日期" value={holdDate} onChange={setHoldDate} />
              <ActionButton onClick={loadHoldings} loading={holdLoading} label="載入" />
              <ActionButton onClick={() => loadHoldings(true)} loading={holdLoading} label="強制查詢最新資料" />
            </div>
```

- [ ] **Step 4: 持股比較分頁加按鈕**

把：

```tsx
            <div style={{ display: 'flex', gap: 20, alignItems: 'flex-end', marginBottom: 18, flexWrap: 'wrap' }}>
              <DateInput label="比較日期" value={cmpDate}  onChange={setCmpDate} />
              <DateInput label="基準日期" value={baseDate} onChange={setBaseDate} />
              <ActionButton onClick={loadCompare} loading={cmpLoading} label="載入比較" />
            </div>
```

改成：

```tsx
            <div style={{ display: 'flex', gap: 20, alignItems: 'flex-end', marginBottom: 18, flexWrap: 'wrap' }}>
              <DateInput label="比較日期" value={cmpDate}  onChange={setCmpDate} />
              <DateInput label="基準日期" value={baseDate} onChange={setBaseDate} />
              <ActionButton onClick={loadCompare} loading={cmpLoading} label="載入比較" />
              <ActionButton onClick={() => loadCompare(true)} loading={cmpLoading} label="強制查詢最新資料" />
            </div>
```

- [ ] **Step 5: 當日摘要分頁加按鈕（已載入 + 未載入兩種狀態）**

把：

```tsx
        {activeTab === 'summary' && (
          <Card ref={summaryRef} title="當日摘要" onSave={baseData && cmpData ? () => saveImage(summaryRef, imgName('當日摘要')) : undefined}>
            {baseData && cmpData
              ? <DailySummaryTab
                  baseDate={baseData.date}
                  cmpDate={cmpData.date}
                  baseHoldings={baseData.holdings}
                  cmpHoldings={cmpData.holdings}
                  fundId={selectedEtf.fundId}
                  yfTicker={selectedEtf.yfTicker}
                  etfTicker={selectedEtf.ticker}
                />
              : (
                <div style={{ textAlign: 'center', padding: '40px 0' }}>
                  <p style={{ color: '#AAA', fontSize: '.9rem', marginBottom: 18 }}>請先在「持股比較」頁面選擇日期並載入資料</p>
                  <div style={{ display: 'flex', gap: 20, justifyContent: 'center', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <DateInput label="基準日期" value={baseDate} onChange={setBaseDate} />
                    <DateInput label="比較日期" value={cmpDate}  onChange={setCmpDate} />
                    <ActionButton onClick={loadCompare} loading={cmpLoading} label="載入比較" />
                  </div>
                  <ErrorMsg msg={cmpError} onReset={() => { setCmpError(''); setBaseData(null); setCmpData(null); }} />
                </div>
              )
            }
```

改成：

```tsx
        {activeTab === 'summary' && (
          <Card ref={summaryRef} title="當日摘要" onSave={baseData && cmpData ? () => saveImage(summaryRef, imgName('當日摘要')) : undefined}>
            {baseData && cmpData
              ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
                    <ActionButton onClick={() => loadCompare(true)} loading={cmpLoading} label="強制查詢最新資料" />
                  </div>
                  <DailySummaryTab
                    baseDate={baseData.date}
                    cmpDate={cmpData.date}
                    baseHoldings={baseData.holdings}
                    cmpHoldings={cmpData.holdings}
                    fundId={selectedEtf.fundId}
                    yfTicker={selectedEtf.yfTicker}
                    etfTicker={selectedEtf.ticker}
                  />
                </>
              )
              : (
                <div style={{ textAlign: 'center', padding: '40px 0' }}>
                  <p style={{ color: '#AAA', fontSize: '.9rem', marginBottom: 18 }}>請先在「持股比較」頁面選擇日期並載入資料</p>
                  <div style={{ display: 'flex', gap: 20, justifyContent: 'center', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <DateInput label="基準日期" value={baseDate} onChange={setBaseDate} />
                    <DateInput label="比較日期" value={cmpDate}  onChange={setCmpDate} />
                    <ActionButton onClick={loadCompare} loading={cmpLoading} label="載入比較" />
                    <ActionButton onClick={() => loadCompare(true)} loading={cmpLoading} label="強制查詢最新資料" />
                  </div>
                  <ErrorMsg msg={cmpError} onReset={() => { setCmpError(''); setBaseData(null); setCmpData(null); }} />
                </div>
              )
            }
```

- [ ] **Step 6: 型別檢查 + lint**

Run: `npm run build`
Expected: 編譯成功。

Run: `npm run lint`
Expected: 無新增錯誤。

- [ ] **Step 7: 手動驗證三顆按鈕都會繞過快取**

`npm run dev`，瀏覽器開 `http://localhost:3000/?tab=holdings`，開 DevTools Network 面板：
1. 點「載入」，觀察 `/api/holdings?...` 請求（不帶 `force=1`）。
2. 點「強制查詢最新資料」，確認請求帶 `&force=1`，且回應正常（200、非 500）。
3. 切到 `?tab=compare` 與 `?tab=summary`，重複確認「強制查詢最新資料」按鈕都會送出帶 `force=1` 的請求，且點擊後頁面資料有重新渲染（不是卡住不動）。

- [ ] **Step 8: Commit**

```bash
git add components/Dashboard.tsx
git commit -m "feat: 持股清單/比較/當日摘要三分頁加強制查詢按鈕

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Python — `latest_expected_trading_day()` 純函式 + 單元測試

**Files:**
- Modify: `scripts/daily_summary.py:113-117`（緊接在 `is_twse_trading_day` 之後）
- Create: `scripts/test_daily_summary.py`

**Interfaces:**
- Consumes: `is_twse_trading_day(d: date) -> bool | None`（既有函式，`scripts/daily_summary.py:113`）
- Produces: `latest_expected_trading_day(anchor: date, max_back: int = 10) -> date | None`

- [ ] **Step 1: 寫測試（先寫，此時 import 會失敗）**

建立 `scripts/test_daily_summary.py`：

```python
"""daily_summary 純函式單元測試。零網路：is_twse_trading_day 一律 monkeypatch。

跑法：cd 00998a-web && python -m pytest scripts/test_daily_summary.py -q
"""

from datetime import date

import daily_summary as ds


def test_latest_expected_trading_day_anchor_is_trading_day(monkeypatch):
    """anchor 本身就是交易日 → 直接回傳 anchor。"""
    monkeypatch.setattr(ds, 'is_twse_trading_day', lambda d: True)
    assert ds.latest_expected_trading_day(date(2026, 8, 14)) == date(2026, 8, 14)


def test_latest_expected_trading_day_walks_back_over_weekend(monkeypatch):
    """anchor 是週一但行事曆說週一非交易日（例如颱風假）→ 應往回找到最近一個交易日。"""
    trading_days = {date(2026, 8, 14): True, date(2026, 8, 15): False, date(2026, 8, 16): False, date(2026, 8, 17): False}
    monkeypatch.setattr(ds, 'is_twse_trading_day', lambda d: trading_days[d])
    assert ds.latest_expected_trading_day(date(2026, 8, 17)) == date(2026, 8, 14)


def test_latest_expected_trading_day_none_when_twse_unreachable():
    """TWSE 連不到（回 None）→ 整體回 None，呼叫端不應誤報。"""
    def flaky(d):
        return None
    import daily_summary as ds2
    orig = ds2.is_twse_trading_day
    ds2.is_twse_trading_day = flaky
    try:
        assert ds2.latest_expected_trading_day(date(2026, 8, 17)) is None
    finally:
        ds2.is_twse_trading_day = orig


def test_latest_expected_trading_day_gives_up_after_max_back(monkeypatch):
    """一路都非交易日、超過 max_back 天仍找不到 → 回 None（不要無限迴圈或誤回舊日期）。"""
    monkeypatch.setattr(ds, 'is_twse_trading_day', lambda d: False)
    assert ds.latest_expected_trading_day(date(2026, 8, 17), max_back=3) is None
```

（第三個測試沒用 `monkeypatch` fixture、改手動存回舊值，是因為要驗證「函式一開始就連不到 TWSE」這個情境用 `monkeypatch.setattr` 也可以，這裡刻意示範兩種寫法皆可——若你覺得不必要可以統一成 `monkeypatch.setattr(ds, 'is_twse_trading_day', lambda d: None)`，效果相同。）

- [ ] **Step 2: 執行測試，確認因為函式不存在而失敗**

Run: `cd C:\Users\WKY\CLAUDE\00998a-web && python -m pytest scripts/test_daily_summary.py -q`
Expected: `AttributeError: module 'daily_summary' has no attribute 'latest_expected_trading_day'`（或 import 階段就失敗，兩者皆可接受，代表函式還沒寫）。

- [ ] **Step 3: 實作 `latest_expected_trading_day`**

編輯 `scripts/daily_summary.py`，在既有的：

```python
def is_twse_trading_day(d: date):
    """True / False per TWSE; None if TWSE unreachable (caller must not hard-block on None)."""
    days = _twse_trading_days(d.year, d.month)
    return None if days is None else (d in days)
```

之後加入：

```python


def latest_expected_trading_day(anchor: date, max_back: int = 10) -> date | None:
    """從 anchor（通常是「今天」）往回找最近一個 TWSE 交易日，作為「資料應該多新」的基準。
    TWSE 行事曆連不到時（is_twse_trading_day 回 None）整體回 None ——
    呼叫端不可把「無法判斷」當成「資料太舊」誤報。"""
    d = anchor
    for _ in range(max_back):
        trading = is_twse_trading_day(d)
        if trading is None:
            return None
        if trading:
            return d
        d -= timedelta(days=1)
    return None
```

- [ ] **Step 4: 執行測試，確認全綠**

Run: `cd C:\Users\WKY\CLAUDE\00998a-web && python -m pytest scripts/test_daily_summary.py -q`
Expected: `4 passed`

- [ ] **Step 5: Commit**

```bash
git add scripts/daily_summary.py scripts/test_daily_summary.py
git commit -m "feat: daily_summary 新增 latest_expected_trading_day 純函式

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Python — Pushover 接上「資料非最新」示警

**Files:**
- Modify: `scripts/daily_summary.py:1156-1167`（`send_pushover`）
- Modify: `scripts/daily_summary.py`（`process_etf` 函式全文，Task 3 完成後行號會往後移，用內容比對定位）
- Modify: `scripts/daily_summary.py`（`process_peer_redemption` 函式全文，同上）

**Interfaces:**
- Consumes: `latest_expected_trading_day(anchor: date, max_back: int = 10) -> date | None`（Task 3）
- Produces: `send_pushover(title: str, message: str, image_bytes: bytes, priority: int = 0)`（新增 `priority` 參數，供其他呼叫端未來使用）

- [ ] **Step 1: `send_pushover` 加 `priority` 參數**

把：

```python
def send_pushover(title: str, message: str, image_bytes: bytes):
    r = requests.post(
        'https://api.pushover.net/1/messages.json',
        data={'token': PUSHOVER_TOKEN, 'user': PUSHOVER_USER,
              'title': title, 'message': message, 'html': '1'},
        files={'attachment': ('summary.png', image_bytes, 'image/png')},
        timeout=30,
    )
    result = r.json()
    if result.get('status') != 1:
        raise RuntimeError(f'Pushover error: {result}')
    print(f'  ✓ Pushover sent: {title}')
```

改成：

```python
def send_pushover(title: str, message: str, image_bytes: bytes, priority: int = 0):
    data = {'token': PUSHOVER_TOKEN, 'user': PUSHOVER_USER,
             'title': title, 'message': message, 'html': '1'}
    if priority:
        data['priority'] = priority
    r = requests.post(
        'https://api.pushover.net/1/messages.json',
        data=data,
        files={'attachment': ('summary.png', image_bytes, 'image/png')},
        timeout=30,
    )
    result = r.json()
    if result.get('status') != 1:
        raise RuntimeError(f'Pushover error: {result}')
    print(f'  ✓ Pushover sent: {title}')
```

- [ ] **Step 2: `process_etf` 接上示警**

把：

```python
async def process_etf(etf: dict, today: date):
    print(f'\n[{etf["ticker"]}]')
    fid = etf['fundId']

    base_date, base_data = find_trading_day_with_data(today, fid)
    if not base_data:
        print(f'  No base data found, skipping.')
        return False

    cmp_date, cmp_data = find_trading_day_with_data(base_date - timedelta(days=1), fid)
    if not cmp_data:
        print(f'  No comparison data found, skipping.')
        return False

    print(f'  base={base_date}  cmp={cmp_date}')

    curr_pcf  = fetch_pcf(base_date, fid)
    prev_pcf  = fetch_pcf(cmp_date,  fid)
    etf_price = fetch_etf_price(etf.get('yfTicker', ''))

    rows = build_diff_rows(base_data['holdings'], cmp_data['holdings'])
    html = build_html(etf, base_data, cmp_data, curr_pcf, prev_pcf, rows, etf_price)

    img = await screenshot_html(html)

    bs    = str(base_data['date'])[5:]
    cs    = str(cmp_data['date'])[5:]
    total = len(rows)
    send_pushover(
        title   = f'{etf["ticker"]} 當日摘要 {bs}',
        message = f'vs {cs}　共 {total} 筆異動',
        image_bytes = img,
    )
    return True
```

改成：

```python
async def process_etf(etf: dict, today: date):
    print(f'\n[{etf["ticker"]}]')
    fid = etf['fundId']

    base_date, base_data = find_trading_day_with_data(today, fid)
    if not base_data:
        print(f'  No base data found, skipping.')
        return False

    cmp_date, cmp_data = find_trading_day_with_data(base_date - timedelta(days=1), fid)
    if not cmp_data:
        print(f'  No comparison data found, skipping.')
        return False

    print(f'  base={base_date}  cmp={cmp_date}')

    expected = latest_expected_trading_day(today)
    stale = expected is not None and base_date < expected
    if stale:
        print(f'  ⚠ 資料非最新：base_date={base_date}，最新交易日應為 {expected}')

    curr_pcf  = fetch_pcf(base_date, fid)
    prev_pcf  = fetch_pcf(cmp_date,  fid)
    etf_price = fetch_etf_price(etf.get('yfTicker', ''))

    rows = build_diff_rows(base_data['holdings'], cmp_data['holdings'])
    html = build_html(etf, base_data, cmp_data, curr_pcf, prev_pcf, rows, etf_price)

    img = await screenshot_html(html)

    bs    = str(base_data['date'])[5:]
    cs    = str(cmp_data['date'])[5:]
    total = len(rows)
    stale_note = f'\n⚠️ 官網尚未更新，此為 {base_date} 資料（最新交易日應為 {expected}）' if stale else ''
    send_pushover(
        title   = f'{"⚠️ " if stale else ""}{etf["ticker"]} 當日摘要 {bs}',
        message = f'vs {cs}　共 {total} 筆異動{stale_note}',
        image_bytes = img,
        priority = 1 if stale else 0,
    )
    return True
```

- [ ] **Step 3: `process_peer_redemption` 接上示警**

把：

```python
async def process_peer_redemption(today: date):
    """Fetch peer redemption data, write to Supabase, and send Pushover notification.
    Returns True if a notification was sent."""
    print('\n[同業申贖觀測]')
    base_date, _ = find_trading_day_with_data(today, 'ETF23')
    if base_date:
        peer_results = fetch_all_peer_data(base_date)
    else:
        # fhtrust 掛掉時，不要連不需要 fhtrust 的同業申贖一起跳過 → 改用同業資料源自行定位基準日
        print('  fhtrust 無法定位基準日，改用同業資料源 fallback…')
        base_date, peer_results = find_peer_base_date(today)
    if not base_date or not peer_results or not _peer_has_data(peer_results):
        print('  No base date / no peer data (incl. fallback), skipping.')
        return False
    print(f'  date={base_date}')

    # Authoritative cross-check: if TWSE says base_date was NOT a trading day yet a
    # source still returned data, it's almost certainly a scraper echoing a closed day
    # → alert and skip rather than publish bad data. (None = TWSE unreachable → proceed.)
    if is_twse_trading_day(base_date) is False:
        print(f'  ⚠ TWSE 確認 {base_date} 非交易日，但資料源仍回傳資料 → 跳過並告警')
        send_pushover_text(
            '⚠️ 同業申贖：偵測到非交易日資料',
            f'{base_date} 經 TWSE 官方行事曆確認為非交易日，但資料源仍回傳申贖資料，'
            f'已跳過寫入。請檢查對應爬蟲（很可能是某家官網回放前一交易日）。',
            priority=1,
        )
        return False

    write_peer_to_supabase(peer_results, base_date)

    html = build_peer_html(peer_results, base_date)
    img  = await screenshot_html(html)
    send_pushover(
        title       = f'同業申贖觀測 {base_date}',
        message     = '淨申贖：' + '　'.join(
            f'{e["ticker"]} {e["data"]["netSub"]:+.2f}億' if e['data'] and e['data']['netSub'] is not None else f'{e["ticker"]} —'
            for e in peer_results
        ),
        image_bytes = img,
    )
    return True
```

改成：

```python
async def process_peer_redemption(today: date):
    """Fetch peer redemption data, write to Supabase, and send Pushover notification.
    Returns True if a notification was sent."""
    print('\n[同業申贖觀測]')
    base_date, _ = find_trading_day_with_data(today, 'ETF23')
    if base_date:
        peer_results = fetch_all_peer_data(base_date)
    else:
        # fhtrust 掛掉時，不要連不需要 fhtrust 的同業申贖一起跳過 → 改用同業資料源自行定位基準日
        print('  fhtrust 無法定位基準日，改用同業資料源 fallback…')
        base_date, peer_results = find_peer_base_date(today)
    if not base_date or not peer_results or not _peer_has_data(peer_results):
        print('  No base date / no peer data (incl. fallback), skipping.')
        return False
    print(f'  date={base_date}')

    # Authoritative cross-check: if TWSE says base_date was NOT a trading day yet a
    # source still returned data, it's almost certainly a scraper echoing a closed day
    # → alert and skip rather than publish bad data. (None = TWSE unreachable → proceed.)
    if is_twse_trading_day(base_date) is False:
        print(f'  ⚠ TWSE 確認 {base_date} 非交易日，但資料源仍回傳資料 → 跳過並告警')
        send_pushover_text(
            '⚠️ 同業申贖：偵測到非交易日資料',
            f'{base_date} 經 TWSE 官方行事曆確認為非交易日，但資料源仍回傳申贖資料，'
            f'已跳過寫入。請檢查對應爬蟲（很可能是某家官網回放前一交易日）。',
            priority=1,
        )
        return False

    expected = latest_expected_trading_day(today)
    stale = expected is not None and base_date < expected
    if stale:
        print(f'  ⚠ 資料非最新：base_date={base_date}，最新交易日應為 {expected}')

    write_peer_to_supabase(peer_results, base_date)

    html = build_peer_html(peer_results, base_date)
    img  = await screenshot_html(html)
    stale_note = f'\n⚠️ 官網尚未更新，此為 {base_date} 資料（最新交易日應為 {expected}）' if stale else ''
    send_pushover(
        title       = f'{"⚠️ " if stale else ""}同業申贖觀測 {base_date}',
        message     = '淨申贖：' + '　'.join(
            f'{e["ticker"]} {e["data"]["netSub"]:+.2f}億' if e['data'] and e['data']['netSub'] is not None else f'{e["ticker"]} —'
            for e in peer_results
        ) + stale_note,
        image_bytes = img,
        priority = 1 if stale else 0,
    )
    return True
```

- [ ] **Step 4: 語法檢查**

Run: `cd C:\Users\WKY\CLAUDE\00998a-web && python -m py_compile scripts/daily_summary.py`
Expected: 無輸出（代表語法正確）。

- [ ] **Step 5: 既有測試 + 新測試都要過**

Run: `cd C:\Users\WKY\CLAUDE\00998a-web && python -m pytest scripts/test_daily_summary.py scripts/test_highlight_scan.py -q`
Expected: 全綠（`test_daily_summary.py` 4 項 + `test_highlight_scan.py` 既有 32 項）。

- [ ] **Step 6: 手動 dry-run 確認正常路徑不會誤觸發警示**

Run（需要 `.env.local` 有 `PUSHOVER_TOKEN`/`PUSHOVER_USER`；沒有的話這步可以跳過，只看 Step 5 的單元測試結果）：

```bash
cd C:\Users\WKY\CLAUDE\00998a-web
set -a && source .env.local && set +a
TEST_DATE=$(date +%Y-%m-%d) python scripts/daily_summary.py
```

Expected: log 裡沒有出現「⚠ 資料非最新」字樣（因為 `TEST_DATE` 路徑把測試日期當 `today` 傳入，`expected` 理論上會等於抓到的 `base_date`）。若看到這行，先確認是不是當天真的還沒收盤/官網真的還沒更新，而不是邏輯寫錯。

- [ ] **Step 7: Commit**

```bash
git add scripts/daily_summary.py
git commit -m "feat: daily_summary Pushover 資料非最新交易日時示警（priority=1）

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: 收尾 — push、部署、更新交接文件

**Files:**
- Modify: `docs/HANDOVER.md`（新增一行維運提醒）

**Interfaces:**
- 無（收尾任務）

- [ ] **Step 1: push 分支**

```bash
git push -u origin feat/force-query-and-stale-pushover-alert
```

（依既有偏好：push 後不用特別問即可留著分支或視情況清掉，但**部署與合併回 master 前**，先跟使用者確認一次——這兩個都是對外／較難逆轉的動作。）

- [ ] **Step 2: 在 `docs/HANDOVER.md` 補一條維運提醒**

在「## 6. 給 AI 助手的額外提醒」清單最後加一行：

```markdown
- 持股/比較/當日摘要三分頁的「強制查詢最新資料」按鈕會繞過 `lib/fhtrust.ts` 的 1 小時 fetch cache；`daily_summary.py` 的 Pushover 若標題帶 `⚠️`，代表抓到的資料日早於 TWSE 官方行事曆認定的最新交易日（官網尚未更新），不是程式錯誤。
```

- [ ] **Step 3: Commit**

```bash
git add docs/HANDOVER.md
git commit -m "docs: HANDOVER 補強制查詢按鈕與 stale pushover 提醒

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push
```

- [ ] **Step 4: 詢問使用者是否要合併回 master 並部署**

跟使用者確認：
1. 要不要把這個分支合併回 `master`？
2. 合併後要不要現在就 `vercel --prod` 部署前端變更（`lib/`、`app/`、`components/` 有改動，不部署網站不會生效）？
3. Python 腳本變更（`scripts/daily_summary.py`）只要 push 到 `master` 就會在下次排程生效，不需要額外部署。

不要自己直接合併/部署——這兩步是對外、較難逆轉的動作，等使用者明確答覆再執行。

---

## Self-Review

**Spec coverage：**
- 功能 1（強制查詢按鈕，含根因、三分頁、`force` 選項）→ Task 1 + Task 2。✓
- 功能 2（`latest_expected_trading_day`、`send_pushover priority`、`process_etf`/`process_peer_redemption` 示警、不誤報原則）→ Task 3 + Task 4。✓
- 「不動的部分」（`find_peer_base_date`、`highlight_scan.py`、`update_holdings.py`、一般查詢快取行為）→ 計畫中沒有任何 task 觸碰這些檔案，符合設計文件範圍。✓
- 設計文件「測試」段落（前端手動驗證、Python 純函式單元測試、`TEST_DATE` dry-run）→ Task 2 Step 7、Task 3、Task 4 Step 6 對應覆蓋。✓

**Placeholder 掃描：** 全文檢查過，沒有「TBD」「之後補」「加適當的錯誤處理」這類字眼；每個程式碼步驟都是完整可貼上的程式碼。

**型別/簽名一致性：**
- `fetchHoldings(date, fundId, opts?: { force?: boolean })`：Task 1 定義，Task 2 沒有直接呼叫它（前端呼叫的是 `/api/holdings` route），一致。
- `fetchData(dateStr, fundId, force = false)`／`loadHoldings(force = false)`／`loadCompare(force = false)`：Task 2 內部一致使用。
- `latest_expected_trading_day(anchor: date, max_back: int = 10) -> date | None`：Task 3 定義、Task 3 測試呼叫、Task 4 呼叫（`latest_expected_trading_day(today)`，用預設 `max_back`）三處簽名一致。
- `send_pushover(title, message, image_bytes, priority: int = 0)`：Task 4 Step 1 定義，Step 2／Step 3 呼叫都用具名參數 `priority=`，一致；`send_pushover_text` 是既有函式、本次未改動，不受影響。
