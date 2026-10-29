"""即時持股：直接向各投信官網取「當下最新」持股（不經資料庫）。

給「同業當日加減碼」的『強制查最新』用：資料庫約 17:40 才寫入、部分投信更晚才公告，
按下強制更新時要能直接問源頭。重用 scripts/issuers 的 requests 版官網抓取器（不需瀏覽器）。

GET /api/live_holdings?tickers=00981A,00991A,...
回傳 {fetchedAt, funds: {ticker: {date, rows: [[stockid, stockname, qshare], ...]} | {error}}}
只接受 REGISTRY 內的台股型主動式 ETF 代號，抓取目標固定為各投信自家公開頁面，不接受任意 URL。
"""
import json
import os
import re
import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))

import issuers  # noqa: E402
import issuers.sources  # noqa: E402,F401  匯入即註冊各投信 fetcher

_TICKER_RE = re.compile(r"^00\d{3}A$")
_CACHE: dict = {}          # ticker -> (ts, result)；同一個 warm instance 內 60 秒重用，避免連點打爆投信官網
_TTL = 60
_TPE = timezone(timedelta(hours=8))


def _fetch_one(ticker: str):
    hit = _CACHE.get(ticker)
    if hit and time.time() - hit[0] < _TTL:
        return ticker, hit[1]
    try:
        rows = issuers.REGISTRY[ticker](ticker, None) or []
        if not rows:
            res = {"error": "官網暫無資料"}
        else:
            date = max(r["date"] for r in rows)
            res = {"date": date, "rows": [[r["stockid"], r["stockname"], r["qshare"]] for r in rows if r["date"] == date]}
    except Exception as e:  # noqa: BLE001  單一投信失敗不影響其他檔
        res = {"error": f"{type(e).__name__}: {str(e)[:120]}"}
    _CACHE[ticker] = (time.time(), res)
    return ticker, res


def collect(tickers):
    want = [t for t in dict.fromkeys(tickers) if _TICKER_RE.match(t) and t in issuers.REGISTRY][:40]
    with ThreadPoolExecutor(max_workers=8) as ex:
        funds = dict(ex.map(_fetch_one, want))
    return {"fetchedAt": datetime.now(_TPE).isoformat(timespec="seconds"), "funds": funds}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        qs = parse_qs(urlparse(self.path).query)
        tickers = [t.strip().upper() for t in ",".join(qs.get("tickers", [])).split(",") if t.strip()]
        body = json.dumps(collect(tickers), ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
