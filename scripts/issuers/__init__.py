"""各家投信官網「每日持股」抓取（官網優先資料源；CMoney 當 fallback）。

每個 fetcher 簽名：fetch(ticker, date=None) -> list[Row]
  Row = {"date": "YYYY-MM-DD", "stockid", "stockname", "qshare": int, "prate": float}
  只回「台股個股」列（過濾期貨/外股/現金/其他資產）。回最新一日（或指定 date）。
date=None 代表「最新可得日」；需要日期參數的來源會自行用今天往回試。

REGISTRY[ticker] = fetch 函式；沒列在 REGISTRY 的 ticker 由 CMoney fallback 處理。
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

# 台股個股代號：4–6 碼數字 + 可選一碼字母（沿用 cmoney 規則）
_STOCK_RE = re.compile(r"^\d{4,6}[A-Z]?$")
_TPE = timezone(timedelta(hours=8))  # Asia/Taipei


def is_tw_stock(sid: str) -> bool:
    return bool(_STOCK_RE.match((sid or "").strip().upper()))


def to_int(v) -> int:
    """'440,000' / '440000.0' / 440000 -> 440000。"""
    s = str(v).replace(",", "").strip()
    if not s:
        return 0
    return int(float(s))


def to_float(v, ndigits: int = 4) -> float:
    s = str(v).replace(",", "").replace("%", "").strip()
    if not s:
        return 0.0
    return round(float(s), ndigits)


def norm_date(s: str) -> str:
    """各種日期格式 -> 'YYYY-MM-DD'。支援 2026/06/17、2026-06-17、20260617、06/17/2026。"""
    s = str(s).strip()
    if not s:
        return ""
    m = re.match(r"/Date\((\d+)", s)  # .NET JSON 日期 /Date(epoch_ms)/（如統一 ezmoney）
    if m:
        return datetime.fromtimestamp(int(m.group(1)) / 1000, tz=timezone.utc).astimezone(_TPE).strftime("%Y-%m-%d")
    s = s.split("T")[0].split(" ")[0]
    if re.fullmatch(r"\d{8}", s):
        return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
    if re.fullmatch(r"\d{4}[/-]\d{1,2}[/-]\d{1,2}", s):
        y, m, d = re.split(r"[/-]", s)
        return f"{y}-{int(m):02d}-{int(d):02d}"
    if re.fullmatch(r"\d{1,2}/\d{1,2}/\d{4}", s):  # 06/17/2026 (美式)
        m, d, y = s.split("/")
        return f"{y}-{int(m):02d}-{int(d):02d}"
    return s


def today_tpe() -> str:
    return datetime.now(_TPE).strftime("%Y-%m-%d")


def recent_trading_days(n: int = 6, start: str | None = None) -> list[str]:
    """從 start（含）往回取 n 個工作日（粗略：跳週末，不含台股假日）。回 'YYYY-MM-DD' 由新到舊。"""
    d = datetime.strptime(start or today_tpe(), "%Y-%m-%d").replace(tzinfo=_TPE)
    out: list[str] = []
    while len(out) < n:
        if d.weekday() < 5:  # 0=Mon..4=Fri
            out.append(d.strftime("%Y-%m-%d"))
        d -= timedelta(days=1)
    return out


def latest_weekday(ref: str | None = None) -> str:
    """ref（預設今天）起往回的第一個平日。00998a-web 的持股存檔是「交易日 → 持股」，
    週末寫進去會變成不存在的交易日；而每日排程平日/假日都會跑。上游 active-etf-tracker 的
    mk_row 只 clamp 到「今天」，週六跑就會產出 2026/10/03 這種 key（實測群益 00982A/00992A、
    兆豐 00996A 都會），所以這裡再退一層到最近的平日。國定假日另由呼叫端用 TWSE 行事曆驗證。"""
    d = datetime.strptime(ref or today_tpe(), "%Y-%m-%d").replace(tzinfo=_TPE)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d.strftime("%Y-%m-%d")


def mk_row(date: str, sid: str, name: str, qshare, prate) -> dict:
    # 持股日不可晚於「最近一個平日」：部分投信（如群益 buyback 的 date1）回的是「申購買回
    # 清單生效日＝下一交易日」而非持股快照日 → clamp，與其他家對齊、避免異動日跳未來日。
    d = norm_date(date)
    t = latest_weekday()
    return {
        "date": d if (d and d <= t) else t,
        "stockid": (sid or "").strip().upper(),
        "stockname": (name or "").strip(),
        "qshare": to_int(qshare),
        "prate": to_float(prate),
    }


# REGISTRY 在 sources / browser 匯入後填入
REGISTRY: dict[str, object] = {}


def register(*tickers):
    def deco(fn):
        for t in tickers:
            REGISTRY[t] = fn
        return fn
    return deco
