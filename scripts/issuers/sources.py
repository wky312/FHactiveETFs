"""非 Playwright 的官網持股 fetcher（JSON API + 兆豐 HTML）。

import 此模組會自動把各 fetcher 註冊進 issuers.REGISTRY。
各 fetcher 回最新一日（或指定 date）的台股個股持股列。
"""
from __future__ import annotations

import json
import re
import ssl

import requests
from requests.adapters import HTTPAdapter
from urllib3.poolmanager import PoolManager

from issuers import (
    is_tw_stock,
    mk_row,
    norm_date,
    recent_trading_days,
    register,
    today_tpe,
)

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def _session(referer: str | None = None) -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": _UA, "Accept": "application/json, text/plain, */*"})
    if referer:
        s.headers["Referer"] = referer
    return s


class _LegacySSLAdapter(HTTPAdapter):
    """部分投信站憑證缺 Subject Key Identifier，OpenSSL 3.x 嚴格模式會擋；放寬驗證等級。
    （同 cmoney.py 的處理；僅唯讀公開端點、host 為常數、回應經 STOCK_RE 嚴格驗證後才寫入。）"""

    def init_poolmanager(self, connections, maxsize, block=False, **kw):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        try:
            ctx.set_ciphers("DEFAULT@SECLEVEL=1")
        except ssl.SSLError:
            pass
        kw["ssl_context"] = ctx
        self.poolmanager = PoolManager(num_pools=connections, maxsize=maxsize, block=block, **kw)


def _req(s: requests.Session, method: str, url: str, **kw) -> requests.Response:
    """送出請求。**僅**針對「憑證鏈驗證失敗」（野村/第一金憑證缺 Subject Key Identifier，
    OpenSSL 3.x 嚴格模式會擋）退回不驗證重試；其他 SSL 問題照常拋出，不靜默吞掉。
    退回時關閉重導向、host 為常數、回應另經 STOCK_RE 嚴格驗證後才入庫（同 cmoney.py 既有處理）。"""
    try:
        return s.request(method, url, **kw)
    except requests.exceptions.SSLError as e:
        if "CERTIFICATE_VERIFY_FAILED" not in str(e):
            raise
        s.mount("https://", _LegacySSLAdapter())
        kw["verify"] = False
        kw["allow_redirects"] = False
        return s.request(method, url, **kw)


def _get(s: requests.Session, url: str, **kw) -> requests.Response:
    return _req(s, "GET", url, **kw)


def _post(s: requests.Session, url: str, **kw) -> requests.Response:
    return _req(s, "POST", url, **kw)


def _filter_tw(rows: list[dict]) -> list[dict]:
    return [r for r in rows if is_tw_stock(r["stockid"]) and r["qshare"] > 0]


# ---------------------------------------------------------------------------
# 野村（00980A/00985A/00999A）：POST GetFundAssets，body {"FundID": ticker}
# 回 Entries.Data.Table[0]{Columns,Rows} + Entries.Data.FundAsset.NavDate
# ---------------------------------------------------------------------------
@register("00980A", "00985A", "00999A")
def nomura(ticker: str, date: str | None = None) -> list[dict]:
    s = _session("https://www.nomurafunds.com.tw/")
    s.headers["Content-Type"] = "application/json"
    res = _post(
        s, "https://www.nomurafunds.com.tw/API/ETFAPI/api/Fund/GetFundAssets",
        data=json.dumps({"FundID": ticker}), timeout=30,
    )
    res.raise_for_status()
    data = ((res.json() or {}).get("Entries") or {}).get("Data") or {}
    nav_date = norm_date(((data.get("FundAsset") or {}).get("NavDate")) or today_tpe())
    tables = data.get("Table") or []
    out: list[dict] = []
    for tbl in tables:
        cols = [str(c) for c in (tbl.get("Columns") or [])]
        ci = _col_idx(cols, code=("代號", "代碼"), name=("名稱",), sh=("股數", "持股數"), wt=("權重", "比重", "比例"))
        if ci["code"] is None or ci["sh"] is None:
            continue
        for row in tbl.get("Rows") or []:
            sid = str(row[ci["code"]]).strip().upper()
            if not is_tw_stock(sid):
                continue
            out.append(mk_row(nav_date, sid,
                              str(row[ci["name"]]) if ci["name"] is not None else "",
                              row[ci["sh"]],
                              row[ci["wt"]] if ci["wt"] is not None else 0))
    return _filter_tw(out)


def _col_idx(cols, **groups):
    """依關鍵字在 Columns 找欄位 index。groups: code/name/sh/wt -> 關鍵字 tuple。"""
    idx = {k: None for k in groups}
    for i, c in enumerate(cols):
        for k, kws in groups.items():
            if idx[k] is None and any(kw in c for kw in kws):
                idx[k] = i
    return idx


# ---------------------------------------------------------------------------
# 摩根（00401A）：GET product-data?cusip=...；fundData.holdings.pcfEquityHoldings.data[]
# ---------------------------------------------------------------------------
_JPM_CUSIP = {"00401A": "TW00000401A1"}


@register("00401A")
def jpmorgan(ticker: str, date: str | None = None) -> list[dict]:
    cusip = _JPM_CUSIP[ticker]
    url = (f"https://am.jpmorgan.com/FundsMarketingHandler/product-data"
           f"?cusip={cusip}&country=tw&role=twetf&language=zh&userLoggedIn=false&version=9.11_1")
    res = _get(_session("https://am.jpmorgan.com/tw/zh/asset-management/twetf/"), url, timeout=30)
    res.raise_for_status()
    fd = (res.json() or {}).get("fundData") or {}
    holds = ((fd.get("holdings") or {}).get("pcfEquityHoldings") or {}).get("data") or []
    out = []
    for h in holds:
        sid = str(h.get("securityTicker") or "").strip().upper()
        if not is_tw_stock(sid):
            continue
        out.append(mk_row(h.get("navDate") or today_tpe(), sid,
                          h.get("securityDescription"), h.get("shares"), h.get("marketValuePercent")))
    return _filter_tw(out)


# ---------------------------------------------------------------------------
# 聯博（00404A）：GET .../{fundCode}/holdings?date=YYYY-MM-DD（需日期，往回試）
# domesticHoldings[].holdings[]{holdingCode,holdingShares,holdingPerc,asOfDate}
# ---------------------------------------------------------------------------
_AB_FUND = {"00404A": "TW00000404A5"}


@register("00404A")
def ab(ticker: str, date: str | None = None) -> list[dict]:
    fund = _AB_FUND[ticker]
    s = _session("https://www.abfunds.com.tw/")
    for d in ([date] if date else recent_trading_days(6)):
        url = (f"https://webapi.alliancebernstein.com/v2/funds/tw/zh-tw/investor/"
               f"{fund}/holdings?date={d}")
        try:
            res = _get(s, url, timeout=30)
            if res.status_code != 200:
                continue
            groups = (res.json() or {}).get("domesticHoldings") or []
        except (requests.RequestException, ValueError):
            continue
        out = []
        for g in groups:
            for h in g.get("holdings") or []:
                sid = str(h.get("holdingCode") or "").strip().upper()
                if not is_tw_stock(sid):
                    continue
                out.append(mk_row(h.get("asOfDate") or d, sid,
                                  h.get("holding"), h.get("holdingShares"), h.get("holdingPerc")))
        out = _filter_tw(out)
        if out:
            return out
    return []


# ---------------------------------------------------------------------------
# 第一金（00994A）：POST Get_hd，body {"pStrFundID":"182","pStrDate":""}（留空=當日）
# 回 {"d":"<json字串>"}；內層每筆 {sdate,A=代號,B=名稱,C=權重,D=股數}
# ---------------------------------------------------------------------------
_FSITC_ID = {"00994A": "182"}


@register("00994A")
def fsitc(ticker: str, date: str | None = None) -> list[dict]:
    s = _session("https://www.fsitc.com.tw/")
    s.headers["Content-Type"] = "application/json; charset=UTF-8"
    body = {"pStrFundID": _FSITC_ID[ticker], "pStrDate": date.replace("-", "/") if date else ""}
    res = _post(s, "https://www.fsitc.com.tw/WebAPI.aspx/Get_hd", data=json.dumps(body), timeout=30)
    res.raise_for_status()
    inner = (res.json() or {}).get("d")
    items = json.loads(inner) if isinstance(inner, str) else (inner or [])
    out = []
    for it in items:
        sid = str(it.get("A") or "").strip().upper()
        if not is_tw_stock(sid):
            continue
        out.append(mk_row(it.get("sdate") or today_tpe(), sid, it.get("B"), it.get("D"), it.get("C")))
    return _filter_tw(out)


# ---------------------------------------------------------------------------
# 國泰（00400A）：GET GetETFDetailStockList?FundCode=EA&SearchDate=YYYY-MM-DD
# result[]{stockCode,stockName,volumn,weights}
# ---------------------------------------------------------------------------
_CATHAY_CODE = {"00400A": "EA"}


@register("00400A")
def cathay(ticker: str, date: str | None = None) -> list[dict]:
    code = _CATHAY_CODE[ticker]
    s = _session("https://www.cathaysite.com.tw/")
    for d in ([date] if date else recent_trading_days(6)):
        url = (f"https://cwapi.cathaysite.com.tw/api/ETF/GetETFDetailStockList"
               f"?FundCode={code}&SearchDate={d}")
        try:
            res = _get(s, url, timeout=30)
            if res.status_code != 200:
                continue
            result = (res.json() or {}).get("result") or []
        except (requests.RequestException, ValueError):
            continue
        out = []
        for h in result:
            sid = str(h.get("stockCode") or "").strip().upper()
            if not is_tw_stock(sid):
                continue
            out.append(mk_row(d, sid, h.get("stockName"), h.get("volumn"), h.get("weights")))
        out = _filter_tw(out)
        if out:
            return out
    return []


# ---------------------------------------------------------------------------
# 復華（00991A）：GET fhtrust assets?fundID=ETF23&qDate=YYYY/MM/DD（需日期，往回試）
# result[0].dDate；result[0].detail[]{stockid,stockname,qshare,prate_addaccint,ftype}
# ---------------------------------------------------------------------------
_FHTRUST_FUND = {"00991A": "ETF23"}


@register("00991A")
def fhtrust(ticker: str, date: str | None = None) -> list[dict]:
    fund = _FHTRUST_FUND[ticker]
    s = _session("https://www.fhtrust.com.tw/")
    for d in ([date] if date else recent_trading_days(6)):
        qd = d.replace("-", "/")
        try:
            res = _get(s, f"https://www.fhtrust.com.tw/api/assets?fundID={fund}&qDate={qd}", timeout=30)
            if res.status_code != 200:
                continue
            result = (res.json() or {}).get("result") or []
        except (requests.RequestException, ValueError):
            continue
        if not result:
            continue
        obj = result[0]
        ddate = norm_date(obj.get("dDate") or d)
        out = []
        for h in obj.get("detail") or []:
            sid = str(h.get("stockid") or "").strip().upper()
            if not is_tw_stock(sid):
                continue
            out.append(mk_row(ddate, sid, h.get("stockname"), h.get("qshare"), h.get("prate_addaccint")))
        out = _filter_tw(out)
        if out:
            return out
    return []


# ---------------------------------------------------------------------------
# 兆豐（00996A）：GET etf_product.aspx?id=23（HTML），解析 common-table-item 配對
# ---------------------------------------------------------------------------
_MEGA_ID = {"00996A": "23"}
_ITEM_RE = re.compile(
    r'item-title">\s*([^<]+?)\s*</div>\s*<div class="item-content">\s*([^<]*?)\s*</div>',
    re.S,
)


@register("00996A")
def mega(ticker: str, date: str | None = None) -> list[dict]:
    s = _session("https://www.megafunds.com.tw/")
    s.headers["Accept"] = "text/html,application/xhtml+xml"
    res = _get(s, f"https://www.megafunds.com.tw/MEGA/etf/etf_product.aspx?id={_MEGA_ID[ticker]}", timeout=30)
    res.raise_for_status()
    html = res.text
    md = re.search(r"資料日期[^0-9]*(\d{4}/\d{1,2}/\d{1,2})", html)
    ddate = norm_date(md.group(1)) if md else today_tpe()

    pairs = _ITEM_RE.findall(html)
    out, cur = [], {}
    for title, content in pairs:
        if "股票代號" in title:
            if cur.get("sid"):
                out.append(cur)
            cur = {"sid": content.strip().upper()}
        elif "股票名稱" in title:
            cur["name"] = content.strip()
        elif "股數" in title:
            cur["qshare"] = content
        elif "權重" in title or "比重" in title:
            cur["prate"] = content
    if cur.get("sid"):
        out.append(cur)
    rows = [mk_row(ddate, c["sid"], c.get("name", ""), c.get("qshare", 0), c.get("prate", 0))
            for c in out if is_tw_stock(c.get("sid", ""))]
    return _filter_tw(rows)


# ---------------------------------------------------------------------------
# 統一（00981A/00403A）：POST GetPCF，body 民國日期 + specificDate:false
# asset[] 取 AssetCode=="ST" 的 Details[]{DetailCode,DetailName,Share,NavRate}；TranDate=基準日
# ---------------------------------------------------------------------------
_UNI_FUND = {"00981A": "49YTW", "00403A": "63YTW"}


def _roc(date: str) -> str:
    """'2026-06-18' -> 民國 '115/06/18'。"""
    y, m, d = date.split("-")
    return f"{int(y) - 1911}/{m}/{d}"


@register("00981A", "00403A")
def uni(ticker: str, date: str | None = None) -> list[dict]:
    s = _session("https://www.ezmoney.com.tw/ETF/Transaction/PCF")
    s.headers["Content-Type"] = "application/json; charset=utf-8"
    s.headers["X-Requested-With"] = "XMLHttpRequest"
    for d in ([date] if date else recent_trading_days(6)):
        body = {"fundCode": _UNI_FUND[ticker], "date": _roc(d), "specificDate": False}
        try:
            res = _post(s, "https://www.ezmoney.com.tw/ETF/Transaction/GetPCF",
                        data=json.dumps(body), timeout=30, allow_redirects=False)
            if res.status_code != 200 or "json" not in res.headers.get("Content-Type", "").lower():
                continue
            j = res.json() or {}
        except (requests.RequestException, ValueError):
            continue
        st = next((a for a in (j.get("asset") or []) if str(a.get("AssetCode")).upper() == "ST"), None)
        if not st:
            continue
        out = []
        for h in st.get("Details") or []:
            sid = str(h.get("DetailCode") or "").strip().upper()
            if not is_tw_stock(sid):
                continue
            out.append(mk_row(h.get("TranDate") or d, sid, h.get("DetailName"),
                              h.get("Share"), h.get("NavRate")))
        out = _filter_tw(out)
        if out:
            return out
    return []


# ---------------------------------------------------------------------------
# 群益（00982A/00992A）：POST buyback，body {"fundId":"399"}；data.stocks[]
# ---------------------------------------------------------------------------
_CAPITAL_FUND = {"00982A": "399", "00992A": "500"}


@register("00982A", "00992A")
def capital(ticker: str, date: str | None = None) -> list[dict]:
    s = _session("https://www.capitalfund.com.tw/")
    s.headers["Content-Type"] = "application/json"
    res = _post(s, "https://www.capitalfund.com.tw/CFWeb/api/etf/buyback",
                data=json.dumps({"fundId": _CAPITAL_FUND[ticker]}), timeout=30)
    res.raise_for_status()
    stocks = ((res.json() or {}).get("data") or {}).get("stocks") or []
    out = []
    for h in stocks:
        sid = str(h.get("stocNo") or "").strip().upper()
        if not is_tw_stock(sid):
            continue
        out.append(mk_row(h.get("date1") or today_tpe(), sid, h.get("stocName"),
                          h.get("share"), h.get("weight")))
    return _filter_tw(out)


# ---------------------------------------------------------------------------
# 富邦（00405A）：GET Assets.aspx?stkId=00405A&ddate=YYYY/MM/DD（HTML 表格）
# 表頭 股票代碼|股票名稱|股數|金額|權重；資料日期：YYYY/MM/DD
# ---------------------------------------------------------------------------
_FUBON_ROW_RE = re.compile(
    r'<td[^>]*class="tac"[^>]*>\s*(\d{4,6}[A-Z]?)\s*</td>\s*'
    r'<td[^>]*>\s*([^<]+?)\s*</td>\s*'
    r'<td[^>]*class="tar"[^>]*>\s*([\d,]+)\s*</td>\s*'
    r'<td[^>]*class="tar"[^>]*>\s*([\d,]+)\s*</td>\s*'
    r'<td[^>]*class="tar"[^>]*>\s*([\d.]+)\s*</td>',
    re.S,
)


@register("00405A")
def fubon(ticker: str, date: str | None = None) -> list[dict]:
    s = _session("https://websys.fsit.com.tw/FubonETF/")
    s.headers["Accept"] = "text/html,application/xhtml+xml"
    s = _session("https://websys.fsit.com.tw/FubonETF/")
    s.headers["Accept"] = "text/html,application/xhtml+xml"
    for d in ([date] if date else recent_trading_days(6)):
        url = (f"https://websys.fsit.com.tw/FubonETF/Trade/Assets.aspx"
               f"?stkId={ticker}&ddate={d.replace('-', '/')}&lan=TW")
        try:
            res = _get(s, url, timeout=30)
            if res.status_code != 200:
                continue
            html = res.text
        except requests.RequestException:
            continue
        md = re.search(r"資料日期[^0-9]*(\d{4}/\d{1,2}/\d{1,2})", html)
        ddate = norm_date(md.group(1)) if md else d
        out = []
        for sid, name, share, _amt, weight in _FUBON_ROW_RE.findall(html):
            sid = sid.strip().upper()
            if not is_tw_stock(sid):
                continue
            out.append(mk_row(ddate, sid, name, share, weight))
        out = _filter_tw(out)
        if out:
            return out
    return []


# ---------------------------------------------------------------------------
# 台新（00987A）：detail 頁 server-render HTML（持股表在初始 HTML，免 Playwright）
# <tr><td>6274 TT</td><td>台燿</td><td>130,000</td><td>6.69%</td></tr>；代號去 ' TT'
# ---------------------------------------------------------------------------
_TAISHIN_ROW_RE = re.compile(
    r"<tr[^>]*>\s*<td[^>]*>\s*(\d{4,6}[A-Z]?)(?:\s+[A-Z]{2,3})?\s*</td>\s*"
    r"<td[^>]*>\s*([^<]+?)\s*</td>\s*"
    r"<td[^>]*>\s*([\d,]+)\s*</td>\s*"
    r"<td[^>]*>\s*([\d.]+)\s*%?\s*</td>",
    re.S,
)


@register("00987A")
def taishin(ticker: str, date: str | None = None) -> list[dict]:
    s = _session("https://www.tsit.com.tw/")
    s.headers["Accept"] = "text/html,application/xhtml+xml"
    res = _get(s, f"https://www.tsit.com.tw/ETF/Home/ETFSeriesDetail/{ticker}", timeout=30)
    res.raise_for_status()
    html = res.text
    # 持股日：頁面上 <= 今天的最大日期（排除成立日 2025-12-16/上市日等較早日期）
    today = today_tpe()
    dates = [d for d in re.findall(r"20\d{2}-\d{2}-\d{2}", html) if d <= today]
    ddate = max(dates) if dates else today
    out = []
    for sid, name, share, weight in _TAISHIN_ROW_RE.findall(html):
        sid = sid.strip().upper()
        if not is_tw_stock(sid):
            continue
        out.append(mk_row(ddate, sid, name, share, weight))
    return _filter_tw(out)
