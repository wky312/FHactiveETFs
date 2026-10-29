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


def _next_weekdays(n: int, start: str | None = None) -> list:
    """今天（或 start）之後的 n 個平日 —— 用公告日查詢的來源要往**後**掃。"""
    from datetime import datetime as _dt, timedelta as _td
    d = _dt.strptime(start or today_tpe(), "%Y-%m-%d")
    out = []
    while len(out) < n:
        d += _td(days=1)
        if d.weekday() < 5:
            out.append(d.date())
    return out


# ── 海外主動式ETF：持股是外國股（彭博式「TSLA US」），不可套 is_tw_stock ────────────────
# 上游 active-etf-tracker 只服務台股型，所有 fetcher 都用 _filter_tw 把非台股列丟掉。
# 00998a-web 的海外族群曝險/個股軌跡要的就是那些外國股（lib/exchangeMap.ts 吃的正是彭博式
# 代碼），所以這三檔走 ticker-aware 的過濾。
# 00986A（台新全球龍頭）不在這裡：台新的 ETFSeriesDetail 頁對海外檔結構不同，
# _TAISHIN_ROW_RE 只match到 4 檔台股、權重合計 12% —— 不完整的持股比沒有更糟，
# 所以不註冊它（CMoney 恢復前這檔沒有持股來源）。
_OVERSEAS_TICKERS = {"00983A", "00402A", "00989A", "00997A"}
_FOREIGN_RE = re.compile(r"^[A-Z0-9][A-Z0-9 .\-]{0,15}$")


def _ok_code(sid: str, ticker: str) -> bool:
    sid = (sid or "").strip().upper()
    if is_tw_stock(sid):
        return True
    return bool(ticker in _OVERSEAS_TICKERS and _FOREIGN_RE.match(sid))


def _filter_rows(rows: list[dict], ticker: str) -> list[dict]:
    return [r for r in rows if _ok_code(r["stockid"], ticker) and r["qshare"] > 0]


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
        need = max(v for v in ci.values() if v is not None)
        for row in tbl.get("Rows") or []:
            if len(row) <= need:      # 安聯偶發回欄數不齊的列（Table[0] 就是 4 欄的空白列）
                continue
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
_JPM_CUSIP = {"00401A": "TW00000401A1", "00989A": "TW00000989A5"}


@register("00401A", "00989A")
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
        if not _ok_code(sid, ticker):
            continue
        out.append(mk_row(h.get("navDate") or today_tpe(), sid,
                          h.get("securityDescription"), h.get("shares"), h.get("marketValuePercent")))
    return _filter_rows(out, ticker)


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
# 00408A 的頁面 ID＝183，由 00998a-web 查申贖端點時對出來（FundDetail.aspx?ID= 與
# Get_BuySellA 的 pStrFundID 同一組號碼）；上游 active-etf-tracker 只登記了 00994A。
_FSITC_ID = {"00994A": "182", "00408A": "183"}


@register("00994A", "00408A")
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
_CAPITAL_FUND = {"00982A": "399", "00992A": "500", "00997A": "502", "00415A": "504"}


@register("00982A", "00992A", "00997A", "00415A")
def capital(ticker: str, date: str | None = None) -> list[dict]:
    s = _session("https://www.capitalfund.com.tw/")
    s.headers["Content-Type"] = "application/json"
    res = _post(s, "https://www.capitalfund.com.tw/CFWeb/api/etf/buyback",
                data=json.dumps({"fundId": _CAPITAL_FUND[ticker]}), timeout=30)
    res.raise_for_status()
    data = (res.json() or {}).get("data") or {}
    stocks = data.get("stocks") or []
    # 海外檔（00997A）：date1 是清單生效日（下一交易日），clamp 到今天會落在週末/錯的日子；
    # pcf.date2 才是持股所屬交易日（2026-10-04 實測 date1=10/05、date2=10/01）。
    d2 = str((data.get("pcf") or {}).get("date2") or "")[:10] if ticker in _OVERSEAS_TICKERS else ""
    out = []
    for h in stocks:
        sid = str(h.get("stocNo") or "").strip().upper()
        if not _ok_code(sid, ticker):
            continue
        out.append(mk_row(d2 or h.get("date1") or today_tpe(), sid, h.get("stocName"),
                          h.get("share"), h.get("weight")))
    return _filter_rows(out, ticker)


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
    # 持股日：取頁面上**所有**日期的最大值，再交給 mk_row clamp 到最近一個平日。
    # ⚠ 原本寫「<= 今天的最大日期」會壞：頁面最新的那個日期其實是**次一公告日**（實測
    #   2026-10-03 當天 00987A/00986A 的頁面只有 2025-12-16 / 2025-12-30 / 2026-10-05），
    #   未來日被濾掉後就退回**成立日**，把當天的持股標成去年（實測污染過 00987A 的存檔）。
    #   取最大值 + mk_row 的 clamp 才是對的：公告日永遠是次一交易日，clamp 回最近平日即資料日。
    dates = re.findall(r"20\d{2}-\d{2}-\d{2}", html)
    ddate = max(dates) if dates else today_tpe()
    out = []
    for sid, name, share, weight in _TAISHIN_ROW_RE.findall(html):
        sid = sid.strip().upper()
        if not is_tw_stock(sid):
            continue
        out.append(mk_row(ddate, sid, name, share, weight))
    return _filter_tw(out)


# ---------------------------------------------------------------------------
# 永豐（00410A）：申購買回清單頁本身就含成分股籃的「證券代碼/證券名稱/股數/權重」表
# （sitc.sinopac.com/SinopacEtfs/Etfs/Pcf/{代號}）。試過 Holding/Portfolio/Asset/Detail
# 等路徑全 404 —— 永豐沒有獨立的持股頁，持股就在 PCF 頁裡。
# ⚠ 只有最新一期（任何日期參數都無效，同它的申贖）。資料日在「資料日期：YYYY/MM/DD」。
# ---------------------------------------------------------------------------
@register("00410A")
def sinopac(ticker: str, date: str | None = None) -> list[dict]:
    s = _session("https://sitc.sinopac.com/")
    res = _get(s, f"https://sitc.sinopac.com/SinopacEtfs/Etfs/Pcf/{ticker}", timeout=30)
    res.raise_for_status()
    html = res.text
    m = re.search(r"資料日期：(\d{4}/\d{1,2}/\d{1,2})", html)
    nav_date = norm_date(m.group(1)) if m else today_tpe()
    # 只取「股票」那張表（頁面還有現金/其他資產的區塊）
    seg = html.split("證券代碼", 1)
    if len(seg) < 2:
        return []
    body = seg[1].split("</table>", 1)[0]
    out: list[dict] = []
    for row in re.findall(r"<tr>\s*<td>([^<]*)</td>\s*<td>([^<]*)</td>\s*<td>([^<]*)</td>\s*<td>([^<]*)</td>\s*</tr>", body):
        sid = row[0].strip().upper()
        if not is_tw_stock(sid):
            continue
        out.append(mk_row(nav_date, sid, row[1], row[2], row[3]))
    return _filter_tw(out)


# ---------------------------------------------------------------------------
# 中信（00406A/00995A）：**不需要 Playwright**（2026-10-03 更正上游的結論）。
# POST /API/home/AuthToken 取 token → POST /API/etf/ETFHoldingWeight?token=<enc>
# body **必須帶 `StartDate`**：少了它回 "SqlDateTime 溢位"（看起來像壞掉，其實是缺參數），
# 而且欄位名只有 StartDate 有效（Date / DataDate 都一樣溢位）。
# 回 Data.FundAssetsDetail[Code=='STOCK'].Data[]{code_,name_,qty_,weights_}，
# 資料日在 Data.FundAssets[0].資料日期。FID：E0038=00406A、E0036=00995A。
# ---------------------------------------------------------------------------
_CTBC_FID = {"00406A": "E0038", "00995A": "E0036", "00983A": "E0034"}


@register("00406A", "00995A", "00983A")
def ctbc(ticker: str, date: str | None = None) -> list[dict]:
    import urllib.parse
    base = "https://www.ctbcinvestments.com.tw/API"
    s = _session("https://www.ctbcinvestments.com.tw/Etf/Combination")
    s.headers["Content-Type"] = "application/json; charset=utf-8"
    tr = _post(s, f"{base}/home/AuthToken?token=www.ctbcinvestments.com",
               data=json.dumps({"token": "www.ctbcinvestments.com"}), timeout=25)
    token = ((tr.json() or {}).get("Data") or {}).get("token")
    if not token:
        return []
    et = urllib.parse.quote(token, safe="")
    body = {"FID": _CTBC_FID[ticker], "StartDate": date or today_tpe()}
    res = _post(s, f"{base}/etf/ETFHoldingWeight?token={et}", data=json.dumps(body), timeout=30)
    res.raise_for_status()
    D = ((res.json() or {}).get("Data") or {})
    fa = D.get("FundAssets") or []
    nav_date = norm_date((fa[0].get("資料日期") if fa else None) or today_tpe())
    out: list[dict] = []
    for grp in D.get("FundAssetsDetail") or []:
        if str(grp.get("Code") or "").upper() != "STOCK":
            continue
        for r in grp.get("Data") or []:
            sid = str(r.get("code_") or "").strip().upper()
            if not _ok_code(sid, ticker):
                continue
            out.append(mk_row(nav_date, sid, r.get("name_") or "", r.get("qty_"), r.get("weights_")))
    return _filter_rows(out, ticker)


# ---------------------------------------------------------------------------
# 安聯（00984A/00993A）：**也不需要 Playwright**（2026-10-03 更正上游的結論）。
# GET /webapi/api/AntiForgery/GetAntiForgeryToken 建 session（requests.Session 自動收 cookie）
# → POST /webapi/api/Fund/GetFundAssets body **`{"FundID": "E000x"}`**（⚠ 是 FundID 不是
# FundNo —— FundNo/fundNo/FundCode 全部回「查無資料」，這就是上游以為得走 DOM 的原因）。
# 回 Entries.Data.FundAsset.NavDate ＋ Entries.Data.Table[]：Table 有兩張，**不要寫死索引**，
# 用 _col_idx 挑含「股票代號/股數」的那張（另一張是期貨/空白列）。
# ---------------------------------------------------------------------------
_ALLIANZ_FUNDID = {"00984A": "E0001", "00993A": "E0002", "00402A": "E0003"}


@register("00984A", "00993A", "00402A")
def allianz(ticker: str, date: str | None = None) -> list[dict]:
    b = "https://etf.allianzgi.com.tw/webapi/api"
    s = _session("https://etf.allianzgi.com.tw/")
    _get(s, f"{b}/AntiForgery/GetAntiForgeryToken", timeout=25)
    xsrf = s.cookies.get("X-XSRF-TOKEN") or ""
    res = _post(s, f"{b}/Fund/GetFundAssets",
                data=json.dumps({"FundID": _ALLIANZ_FUNDID[ticker]}),
                headers={**s.headers, "X-XSRF-TOKEN": xsrf, "Content-Type": "application/json"},
                timeout=30)
    res.raise_for_status()
    E = (((res.json() or {}).get("Entries") or {}).get("Data") or {})
    nav_date = norm_date(((E.get("FundAsset") or {}).get("NavDate")) or today_tpe())
    out: list[dict] = []
    for tbl in E.get("Table") or []:
        cols = [str((c or {}).get("Name") or "") for c in (tbl.get("Columns") or [])]
        ci = _col_idx(cols, code=("股票代號", "代號", "代碼"), name=("股票名稱", "名稱"),
                      sh=("股數", "持股數"), wt=("權重", "比重"))
        if ci["code"] is None or ci["sh"] is None:
            continue
        need = max(v for v in ci.values() if v is not None)
        for row in tbl.get("Rows") or []:
            if len(row) <= need:      # 安聯 Table[0] 是 4 欄空白列，欄數不齊要跳過
                continue
            sid = str(row[ci["code"]]).strip().upper()
            if not _ok_code(sid, ticker):
                continue
            out.append(mk_row(nav_date, sid,
                              str(row[ci["name"]]) if ci["name"] is not None else "",
                              row[ci["sh"]],
                              row[ci["wt"]] if ci["wt"] is not None else 0))
    return _filter_rows(out, ticker)


# ---------------------------------------------------------------------------
# 凱基（00407A）：持股就在申購買回清單的 HTML 片段裡（同永豐，沒有獨立持股頁）。
# POST www.kgifund.com.tw/Fund/RedemptionVC  form {fundID: 'J024', queryDate: <公告日>}
# ⚠ 整段回應是 **HTML entity 編碼**的（「權重(%)」會長成 &#x6B0A;&#x91CD;(%)），
#   不先 html.unescape 任何中文關鍵字比對都會 miss，看起來像「這頁沒有持股」。
# ⚠ <tr> 帶屬性（`<tr name="content" style="">`），regex 不可寫死 `<tr>`。
# 資料日在「(YYYY/MM/DD)每受益權單位淨資產價值」的括號前綴（同 daily_summary.fetch_kgi_day）。
# ---------------------------------------------------------------------------
_KGI_FUNDID = {"00407A": "J024"}


@register("00407A")
def kgi(ticker: str, date: str | None = None) -> list[dict]:
    import html as _html
    s = _session(f"https://www.kgifund.com.tw/Fund/RedemptionList?fundNo={_KGI_FUNDID[ticker]}")
    s.headers["X-Requested-With"] = "XMLHttpRequest"
    # queryDate 是**公告日**（T+1），要往後掃而不是往回：從今天起算會拿到上一期的籃子
    # （實測週六用 queryDate=2026-10-03 回 10/01 的，用 10/05 才回 10/02 的）。
    # 掃候選公告日、取「資料日最新」的那份；date 有給就只查那一天。
    cands = [date] if date else [today_tpe()] + [d.isoformat() for d in _next_weekdays(5)]   # 今天本身也是公告日（內容＝前一交易日持股）
    best_date, best_rows = "", []
    for ann in cands:
        res = _post(s, "https://www.kgifund.com.tw/Fund/RedemptionVC",
                    data={"fundID": _KGI_FUNDID[ticker], "queryDate": ann}, timeout=30)
        if res.status_code != 200:
            continue
        html = _html.unescape(res.text)
        m = re.search(r"\((\d{4}/\d{1,2}/\d{1,2})\)每受益權單位淨資產價值", html)
        if not m:
            continue
        nav_date = norm_date(m.group(1))
        if nav_date > today_tpe() or nav_date <= best_date:
            continue
        out: list[dict] = []
        for row in re.findall(
                r"<tr[^>]*>\s*<td[^>]*>([^<]*)</td>\s*<td[^>]*>([^<]*)</td>\s*"
                r"<td[^>]*>([^<]*)</td>\s*<td[^>]*>([^<]*)</td>\s*</tr>", html):
            sid = row[0].strip().upper()
            if not is_tw_stock(sid):
                continue
            out.append(mk_row(nav_date, sid, row[1], row[2], row[3]))
        if out:
            best_date, best_rows = nav_date, out
    return _filter_tw(best_rows)
