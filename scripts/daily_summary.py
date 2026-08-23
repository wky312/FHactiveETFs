#!/usr/bin/env python3
"""
Daily holdings summary: fetch fhtrust data, render HTML, screenshot, send via Pushover.
Runs Mon-Fri at 17:15 TST via GitHub Actions.
"""

import os
import re
import sys
import time
import asyncio
import requests
from datetime import datetime, timedelta, date
import pytz

TZ = pytz.timezone('Asia/Taipei')


def load_sector_map() -> dict:
    """Parse lib/sectorGroups.ts BUILTIN_GROUPS to build a stockid -> sector name
    lookup. Reads the .ts source directly (not a duplicated copy) so the Pushover
    report never drifts from the tab=sector page's tagging."""
    path = os.path.join(os.path.dirname(__file__), '..', 'lib', 'sectorGroups.ts')
    try:
        with open(path, encoding='utf-8') as f:
            content = f.read()
    except OSError:
        return {}
    mapping = {}
    for m in re.finditer(r"name:\s*'([^']+)',\s*codes:\s*\[([^\]]*)\]", content):
        name = m.group(1)
        for code in re.findall(r"'(\d+)'", m.group(2)):
            mapping[code] = name
    return mapping


SECTOR_MAP = load_sector_map()

FHTRUST_ASSETS = 'https://www.fhtrust.com.tw/api/assets'
FHTRUST_PCF    = 'https://www.fhtrust.com.tw/api/ETFPcf'

ETFS = [
    {'ticker': '00991A', 'name': '復華主動式ETF', 'fundId': 'ETF23', 'yfTicker': '00991A.TW'},
    # 00409A 成立 2026/08/20、掛牌 2026/09/02。掛牌前復華每日持股 detail 是空的、PCF 全 null →
    # find_trading_day_with_data 回 (None, None)、process_etf 直接 skip（不推播、不影響 00991A 的
    # sent_any 判定）；資料一開始公布就會自己接上。
    {'ticker': '00409A', 'name': '復華全球未來50主動式ETF', 'fundId': 'ETF26', 'yfTicker': '00409A.TW'},
]

# 單位數注意商品：主管機關要求成立以來平均單位數不得低於發行時單位數之一半。
# listing_units 只作為文件用途（門檻換算在網站 lib/unitWatch.ts 做），此處只負責每日存檔 qIssue。
UNIT_WATCH_PRODUCTS = [
    {'ticker': '00986D', 'fundId': 'ETF25', 'listing_date': date(2026, 4, 15), 'listing_units': 230_677_000.0},
]

PUSHOVER_TOKEN     = os.environ.get('PUSHOVER_TOKEN', '')
PUSHOVER_USER      = os.environ.get('PUSHOVER_USER', '')
SUPABASE_URL       = os.environ.get('SUPABASE_URL', '')
SUPABASE_SERVICE_KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')


# ── Helpers ──────────────────────────────────────────────────────────────────

def date_to_api(d: date) -> str:
    return d.strftime('%Y/%m/%d')

def api_to_date(s: str) -> date:
    """反向於 date_to_api：把 API 回傳的 'YYYY/MM/DD' 字串轉回 date。"""
    return datetime.strptime(str(s), '%Y/%m/%d').date()

def parse_num(v) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    return float(str(v).replace(',', '').replace('%', '') or 0)


def get_with_retry(url, *, headers=None, timeout=20, attempts=3, backoff=2.0):
    """GET with retry on transient connection errors (e.g. fhtrust's intermittent
    RemoteDisconnected, which on 2026-06-22 closed every connection and silently
    skipped the whole run). Raises the last exception if all attempts fail."""
    last = None
    for i in range(attempts):
        try:
            return requests.get(url, headers=headers, timeout=timeout)
        except requests.exceptions.RequestException as e:
            last = e
            if i < attempts - 1:
                time.sleep(backoff * (i + 1))
    raise last


# ── TWSE official trading calendar (authoritative cross-check) ────────────────
# FMTQIK lists ONLY real trading days for a month, so it is the source of truth for
# "was the market open on date D?". Used to catch any data source that echoes a
# non-trading day's basket (e.g. Fubon replaying the prior day) before we publish it.

_TWSE_CAL_CACHE: dict[str, set] = {}

def _twse_trading_days(year: int, month: int):
    """Return set[date] of TWSE trading days in the month, or None if unreachable."""
    key = f'{year}{month:02d}'
    if key in _TWSE_CAL_CACHE:
        return _TWSE_CAL_CACHE[key]
    try:
        url = f'https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date={key}01&response=json'
        r = get_with_retry(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
        d = r.json()
        if d.get('stat') != 'OK':
            return None
        days = set()
        for row in d.get('data', []):
            roc = str(row[0]).split('/')  # 'YYY/MM/DD' (ROC year)
            days.add(date(int(roc[0]) + 1911, int(roc[1]), int(roc[2])))
        _TWSE_CAL_CACHE[key] = days
        return days
    except Exception as e:
        print(f'  TWSE calendar fetch error {key}: {e}')
        return None


def is_twse_trading_day(d: date):
    """True / False per TWSE; None if TWSE unreachable (caller must not hard-block on None)."""
    days = _twse_trading_days(d.year, d.month)
    return None if days is None else (d in days)


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


def is_stale(reported_date: date, today: date) -> tuple[bool, date | None]:
    """回傳 (是否為非最新交易日資料, 最新交易日應為的日期或 None)。
    expected 為 None（TWSE 行事曆連不到）時一律不視為 stale——呼叫端不可誤報。"""
    expected = latest_expected_trading_day(today)
    return (expected is not None and reported_date < expected), expected


# ── API fetchers ──────────────────────────────────────────────────────────────

def fetch_holdings(date_str: str, fund_id: str):
    """Return {'date': str, 'holdings': [...]} or None."""
    url = f'{FHTRUST_ASSETS}?fundID={fund_id}&qDate={requests.utils.quote(date_str)}'
    try:
        r = get_with_retry(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
        data = r.json()
        fund = (data.get('result') or [None])[0]
        if not fund:
            return None
        # 尚未公布的日期上游回的是 dDate=null、detail=[] 的空殼，不是錯誤。當成有效結果的話
        # find_trading_day_with_data 會停在今天，build_diff_rows 拿空的今天對完整的昨天會把
        # 每一檔算成清倉 → 推播一張全紅的假摘要。視同無資料才對。
        if not fund.get('dDate') or not fund.get('detail'):
            return None
        holdings = [
            {
                'stockid':          str(item.get('stockid', '')),
                'stockname':        str(item.get('stockname', '')),
                'qshare':           parse_num(item.get('qshare', 0)),
                'mvalue':           parse_num(item.get('mvalue', 0)),
                'prate_addaccint':  parse_num(item.get('prate_addaccint', 0)),
            }
            for item in fund.get('detail', [])
        ]
        return {'date': fund.get('dDate', date_str), 'holdings': holdings}
    except Exception as e:
        print(f'  holdings fetch error ({date_str}): {e}')
        return None


def fetch_pcf(target: date, fund_id: str):
    """Return {'aum': float, 'pnav': float} for the given actBuyValDate, or None."""
    target_str = date_to_api(target)
    for offset in range(5):
        pcf_date = date_to_api(target + timedelta(days=offset))
        try:
            url = f'{FHTRUST_PCF}?fundID={fund_id}&pcfDate={requests.utils.quote(pcf_date)}'
            r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
            data = r.json()
            d = (data.get('result') or [None])[0] if data.get('result') else data
            if not d or not d.get('actBuyValDate'):
                continue
            if str(d['actBuyValDate']) != target_str:
                continue
            return {
                'aum':  parse_num(d.get('nav', 0)) / 1e8,
                'pnav': parse_num(d.get('pnav', 0)),
            }
        except:
            continue
    return None


def fetch_units(target: date, fund_id: str) -> float | None:
    """Return units outstanding (qIssue) for the exact given date, or None (non-trading day /
    no data yet). Unlike fetch_pcf's actBuyValDate (settlement-lagged), qIssue is keyed by
    postDate == the requested pcfDate — confirmed via manual probe against ETF25 2026-07."""
    target_str = date_to_api(target)
    try:
        url = f'{FHTRUST_PCF}?fundID={fund_id}&pcfDate={requests.utils.quote(target_str)}'
        r = get_with_retry(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
        data = r.json()
        d = (data.get('result') or [None])[0] if data.get('result') else data
        if not d or not d.get('postDate') or str(d['postDate']) != target_str:
            return None
        units = parse_num(d.get('qIssue', 0))
        return units or None
    except Exception as e:
        print(f'  unit fetch error ({target_str}): {e}')
        return None


def write_unit_watch_to_supabase(rows: list):
    """rows: [{'date': date, 'ticker': str, 'units': float}, ...]. Upsert into unit_watch."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        print('  Supabase credentials not set, skipping unit_watch DB write.')
        return
    if not rows:
        return
    try:
        from supabase import create_client
        client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        payload = [
            {'date': str(r['date']), 'ticker': r['ticker'], 'units': round(float(r['units']), 2)}
            for r in rows
        ]
        client.table('unit_watch').upsert(payload, on_conflict='date,ticker').execute()
        print(f'  ✓ Supabase: upserted {len(payload)} unit_watch row(s)')
    except Exception as e:
        print(f'  Supabase unit_watch write error: {e}')
        import traceback; traceback.print_exc()


def process_unit_watch(today: date) -> bool:
    """Fetch and store the most recent trading day's units outstanding for monitored products."""
    print('\n[單位數注意商品]')
    rows = []
    for p in UNIT_WATCH_PRODUCTS:
        d = today
        found = False
        for _ in range(6):  # walk back through weekends/holidays
            if d.weekday() < 5:
                units = fetch_units(d, p['fundId'])
                if units is not None:
                    rows.append({'date': d, 'ticker': p['ticker'], 'units': units})
                    print(f'  {p["ticker"]} {d}: {units:,.0f} 單位')
                    found = True
                    break
            d -= timedelta(days=1)
        if not found:
            print(f'  {p["ticker"]}: 無法取得資料')
    write_unit_watch_to_supabase(rows)
    return bool(rows)


def fetch_etf_price(yf_ticker: str) -> dict | None:
    """Fetch ETF market price and previous close from Yahoo Finance."""
    try:
        import yfinance as yf
        ticker = yf.Ticker(yf_ticker)
        fi = ticker.fast_info
        price      = fi.last_price
        prev_close = fi.previous_close
        if not price:
            return None
        return {'price': price, 'prev_close': prev_close}
    except Exception as e:
        print(f'  yfinance {yf_ticker}: {e}')
        return None


# ── Peer ETF data fetchers ────────────────────────────────────────────────────

PEER_ETFS = [
    # 台股主動式ETF（規模百億以上＋擦邊三檔；key 皆為該投信 PCF API 的基金識別碼）
    {'ticker': '00991A', 'name': '復華991', 'source': 'fhtrust',  'key': 'ETF23',  'group': 'tw_active'},
    {'ticker': '00981A', 'name': '統一981', 'source': 'ezmoney',  'key': '49YTW',  'group': 'tw_active'},
    {'ticker': '00403A', 'name': '統一403', 'source': 'ezmoney',  'key': '63YTW',  'group': 'tw_active'},
    {'ticker': '00982A', 'name': '群益982', 'source': 'capital',  'key': '399',    'group': 'tw_active'},
    {'ticker': '00992A', 'name': '群益992', 'source': 'capital',  'key': '500',    'group': 'tw_active'},
    {'ticker': '00405A', 'name': '富邦405', 'source': 'fubon',    'key': '00405A', 'group': 'tw_active'},
    {'ticker': '00407A', 'name': '凱基407', 'source': 'kgi',     'key': 'J024',   'group': 'tw_active'},
    {'ticker': '00400A', 'name': '國泰400', 'source': 'cathay',  'key': 'EA',     'group': 'tw_active'},
    {'ticker': '00980A', 'name': '野村980', 'source': 'nomura',  'key': '00980A', 'group': 'tw_active'},
    {'ticker': '00406A', 'name': '中信406', 'source': 'ctbc',    'key': 'E0038',  'group': 'tw_active'},
    {'ticker': '00999A', 'name': '野村999', 'source': 'nomura',  'key': '00999A', 'group': 'tw_active'},
    {'ticker': '00985A', 'name': '野村985', 'source': 'nomura',  'key': '00985A', 'group': 'tw_active'},
    {'ticker': '00993A', 'name': '安聯993', 'source': 'allianz', 'key': 'E0002',  'group': 'tw_active'},
    {'ticker': '00984A', 'name': '安聯984', 'source': 'allianz', 'key': 'E0001',  'group': 'tw_active'},
    # 海外主動式ETF（step 3：逐家官方申贖來源；復華無官方來源 → CMoney 推算）
    {'ticker': '00983A', 'name': '中信ARK創新',  'source': 'ctbc',    'key': 'E0034',  'group': 'overseas'},
    {'ticker': '00986A', 'name': '台新全球龍頭', 'source': 'tsit',    'key': '00986A', 'group': 'overseas'},
    {'ticker': '00988A', 'name': '統一全球創新', 'source': 'ezmoney', 'key': '61YTW',  'group': 'overseas'},
    {'ticker': '00990A', 'name': '元大AI新經濟', 'source': 'yuanta',  'key': '00990A', 'group': 'overseas'},
    {'ticker': '00997A', 'name': '群益美國增長', 'source': 'capital', 'key': '502',    'group': 'overseas'},
    {'ticker': '00998A', 'name': '復華全球金融', 'source': 'cmoney',  'key': '00998A', 'group': 'overseas'},
    {'ticker': '00402A', 'name': '安聯美國科技', 'source': 'allianz', 'key': 'E0003',  'group': 'overseas'},
]

EZMONEY_HOST = 'www.ezmoney.com.tw'
CAPITAL_HOST = 'www.capitalfund.com.tw'


def _get_ezmoney_session(fund_code: str) -> requests.Session:
    s = requests.Session()
    s.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    s.get(f'https://{EZMONEY_HOST}/', timeout=15)
    s.get(f'https://{EZMONEY_HOST}/ETF/Transaction/PCF?fundCode={fund_code}', timeout=15)
    return s


def _roc_date(d: date) -> str:
    """Convert Gregorian date to ROC format YYY/MM/DD."""
    return f'{d.year - 1911}/{d.month:02d}/{d.day:02d}'


def _parse_tran_date(raw) -> str | None:
    """Parse ezmoney TranDate from ISO string or .NET /Date(ms)/ format → YYYY-MM-DD."""
    if not raw:
        return None
    s = str(raw)
    # ISO format: "2026-06-01T00:00:00"
    if 'T' in s:
        return s[:10]
    # .NET ticks: "/Date(1780243200000)/"
    import re
    m = re.search(r'Date\((\d+)\)', s)
    if m:
        ms = int(m.group(1))
        # Add 8 hours to convert UTC to Taiwan time before extracting date
        from datetime import timezone, timezone as tz
        dt = datetime.fromtimestamp((ms + 8 * 3600 * 1000) / 1000, tz=timezone.utc)
        return dt.strftime('%Y-%m-%d')
    return None


def fetch_ezmoney_day(fund_code: str, transaction_date: date,
                      session: requests.Session | None = None) -> dict | None:
    """Return {'netSub': float, 'aum': float} for given transaction date, or None.
    Tries announcement offsets +1..+4 days to handle weekends and holidays."""
    try:
        s = session or _get_ezmoney_session(fund_code)
        target_str = str(transaction_date)  # YYYY-MM-DD
        for offset in range(1, 5):
            announce = transaction_date + timedelta(days=offset)
            payload = {'fundCode': fund_code, 'date': _roc_date(announce), 'specificDate': True}
            try:
                r = s.post(
                    f'https://{EZMONEY_HOST}/ETF/Transaction/GetPCF',
                    json=payload,
                    headers={'X-Requested-With': 'XMLHttpRequest',
                             'Referer': f'https://{EZMONEY_HOST}/ETF/Transaction/PCF?fundCode={fund_code}'},
                    timeout=25,
                )
            except Exception:
                continue
            if r.status_code != 200 or 'application/json' not in r.headers.get('content-type', ''):
                continue
            pcf = r.json().get('pcf', [])
            if not pcf:
                continue
            tran_date = _parse_tran_date(pcf[0].get('TranDate'))
            if not tran_date or tran_date != target_str:
                continue
            get = lambda code: next((parse_num(p['Amount']) for p in pcf if p.get('PCFCode','').upper() == code), 0)
            diff_unit = get('DIFF_UNIT')
            p_unit    = get('P_UNIT')
            nav       = get('NAV')
            if p_unit == 0:
                continue
            return {'netSub': (diff_unit * p_unit) / 1e8, 'aum': nav / 1e8}
        return None
    except Exception as e:
        print(f'  ezmoney {fund_code} {transaction_date}: {e}')
        return None


def _next_biz_day(d: date) -> date:
    nd = d + timedelta(days=1)
    while nd.weekday() >= 5:
        nd += timedelta(days=1)
    return nd


def fetch_capital_day(fund_id: str, transaction_date: date) -> dict | None:
    """Return {'netSub': float, 'aum': float} for given transaction date, or None."""
    try:
        s = requests.Session()
        s.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        s.get(f'https://{CAPITAL_HOST}/', timeout=15)
        # 公告落差不是固定 +1：台股基金(399/500) date2 = 公告日−1 交易日，海外基金(502 主動群益
        # 美國增長) 是 −2。寫死 _next_biz_day() 只對台股成立，海外永遠對不上 → 往後掃 5 個營業日，
        # 以 API 自報的 date2 對齊（date2 隨公告日遞增，越過目標日就提早收工）。
        announce = transaction_date
        for _ in range(5):
            announce = _next_biz_day(announce)
            r = s.post(
                f'https://{CAPITAL_HOST}/CFWeb/api/etf/buyback',
                json={'fundId': fund_id, 'date': str(announce)},
                headers={'Referer': f'https://{CAPITAL_HOST}/etf/transaction/buyback'},
                timeout=20,
            )
            if r.status_code != 200:
                continue
            pcf = (r.json().get('data') or {}).get('pcf') or {}   # 無資料時 data 是 null，不是 {}
            date2 = pcf.get('date2')
            if not date2:
                continue
            if date2 > str(transaction_date):
                return None
            if date2 != str(transaction_date):
                continue
            dis_unit = parse_num(pcf.get('disUnit', 0))
            p_unit   = parse_num(pcf.get('pUnit', 0))
            nav      = parse_num(pcf.get('nav', 0))
            if p_unit == 0:
                return None
            return {'netSub': (dis_unit * p_unit) / 1e8, 'aum': nav / 1e8}
        return None
    except Exception as e:
        print(f'  capital {fund_id} {transaction_date}: {e}')
        return None


def fetch_fhtrust_peer_day(fund_id: str, transaction_date: date) -> dict | None:
    """Fetch net subscription for fhtrust ETF from PCF data."""
    result = fetch_pcf(transaction_date, fund_id)
    if not result:
        return None
    # aum from PCF; netSub from ScaleDay pattern: need actBuyVal × qDiff
    # For peer table we only use aum here; netSub from etf-scale logic not repeated
    return {'aum': result['aum'], 'netSub': None}  # netSub requires scale API separately


FUBON_HOST = 'websys.fsit.com.tw'


def _fubon_field(html: str, label: str) -> str | None:
    import re
    m = re.search(rf'>{re.escape(label)}</p>\s*<p>([^<]*)</p>', html)
    return m.group(1).strip() if m else None


def _fubon_num(v) -> float:
    """Parse Fubon value strings: strip NT$/commas, treat parens/minus as negative."""
    if not v:
        return 0.0
    import re
    neg = '(' in v or '−' in v or '-' in v
    s = re.sub(r'[^0-9.]', '', v.replace('NT$', ''))
    n = float(s) if s else 0.0
    return -n if neg else n


def fetch_fubon_day(stk_id: str, transaction_date: date) -> dict | None:
    """Return {'netSub': float, 'aum': float} for given trade date, or None.
    Fubon PCF page selects a date purely via &ddate=YYYYMMDD (a GET), no postback.
    netSub = 與前日已發行單位差異數 × 每申購基數實際申購總價金 ÷ 每申購基數單位數 ÷ 1e8."""
    try:
        import re
        ddate = transaction_date.strftime('%Y%m%d')
        url = (f'https://{FUBON_HOST}/FubonETF/Trade/Pcf.aspx'
               f'?stkId={stk_id}&ddate={ddate}&lan=TW')
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        try:
            r = requests.get(url, headers=headers, timeout=20)
        except requests.exceptions.SSLError:
            # Fubon's TLS cert lacks a Subject Key Identifier, which strict OpenSSL 3.x
            # rejects (curl/Node and older OpenSSL accept it). Keep verification on
            # everywhere it works; only fall back to unverified for this known-malformed
            # cert on a read-only public page.
            import urllib3
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
            r = requests.get(url, headers=headers, timeout=20, verify=False)
        if r.status_code != 200:
            return None
        html = r.text
        # The 每申購基數實際申購總價金 label is prefixed with the *authoritative* trade date
        # (e.g. "2026/06/18 每申購基數實際申購總價金"). Fubon's page does NOT validate the
        # requested ddate: querying a non-trading day silently replays the previous
        # trading day's basket with only the displayed date swapped. That prefix is the
        # only field that still reveals the real date, so use it to reject the echo.
        td_m    = re.search(r'(\d{4}/\d{2}/\d{2})\s*每申購基數實際申購總價金', html)
        trade_date = td_m.group(1) if td_m else None
        req_slash  = transaction_date.strftime('%Y/%m/%d')
        if trade_date and trade_date != req_slash:
            # Authoritative date ≠ requested day → non-trading day echo → no real data.
            return None
        act_m   = re.search(r'每申購基數實際申購總價金</p>\s*<p>([^<]*)</p>', html)
        q_diff  = _fubon_num(_fubon_field(html, '與前日已發行單位差異數'))
        cu      = _fubon_num(_fubon_field(html, '每申購/買回基數之受益權單位數'))
        nav     = _fubon_num(_fubon_field(html, '基金淨資產價值'))
        act_val = _fubon_num(act_m.group(1).strip() if act_m else None)
        # cu/nav are 0 on non-trading days and before listing → no data.
        if cu == 0 or nav == 0:
            return None
        return {'netSub': (q_diff * act_val) / cu / 1e8, 'aum': nav / 1e8}
    except Exception as e:
        print(f'  fubon {stk_id} {transaction_date}: {e}')
        return None


# ── 海外主動式ETF 申贖 fetchers（step 3：逐家官方來源；TS 對應 lib/*Scale.ts）─────────

def _pcf_num(v) -> float:
    """PCF 數字字串：去千分位、括號/負號視為負。"""
    if v is None:
        return 0.0
    import re
    s = str(v)
    neg = '(' in s or '−' in s or '-' in s
    cleaned = re.sub(r'[^0-9.]', '', s)
    n = float(cleaned) if cleaned else 0.0
    return -n if neg else n


def _get_lax(url, headers=None, timeout=20):
    """GET 容忍 tsit / yuantaetfs / pocket.tw 那種缺 Subject Key Identifier 的（無害）TLS 憑證——
    Python 3.14 / 新版 runner 的嚴格 OpenSSL 3.x 會擋，curl/Node 接受。先驗證、SSLError 才對這些
    唯讀公開頁退回 verify=False（與 fetch_fubon_day 同策略，見 [[project_00998a_web]]）。"""
    headers = headers or {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    try:
        return requests.get(url, headers=headers, timeout=timeout)
    except requests.exceptions.SSLError:
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        return requests.get(url, headers=headers, timeout=timeout, verify=False)


def _post_lax(url, data=None, json_body=None, headers=None, timeout=25):
    """POST 版的 _get_lax（凱基 www.kgifund.com.tw 同樣缺 Subject Key Identifier）。"""
    kw = {'headers': headers or {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'},
          'timeout': timeout}
    if data is not None:
        kw['data'] = data
    if json_body is not None:
        kw['json'] = json_body
    try:
        return requests.post(url, **kw)
    except requests.exceptions.SSLError:
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        return requests.post(url, **kw, verify=False)


def _ann_days(transaction_date: date, n: int = 5) -> list:
    """交易日之後的 n 個營業日 —— 各家 PCF 的「公告日」候選。

    多數投信的 PCF 端點是**用公告日查詢**、內容才是前一（或前幾）交易日的資料：
    國內股票型多為 T+1 公告，海外型可能落後 2-3 個交易日。因此凡是用公告日查詢的
    來源，一律逐一試候選公告日，再用回應裡的「資料日」欄位對齊 transaction_date，
    不可假設固定位移（踩過：安聯/中信/台新原本直接把交易日當查詢日，整欄晚一天）。
    """
    out, cur = [], transaction_date
    while len(out) < n:
        cur += timedelta(days=1)
        if cur.weekday() < 5:
            out.append(cur)
    return out


def fetch_tsit_day(ticker: str, transaction_date: date) -> dict | None:
    """台新投信 00986A：GET HTML（<th>label</th><td>value</td>）。
    DataDate 是**公告日**；資料日藏在「YYYY/M/D每基數實際申購總價金」標籤前綴。"""
    try:
        import re
        for ann in _ann_days(transaction_date):
            url = (f'https://www.tsit.com.tw/ETF/Home/Pcf/{ticker}'
                   f'?FundType=&DataDate={ann.isoformat()}')
            r = _get_lax(url, timeout=20)
            if r.status_code != 200:
                continue
            html = r.text
            def field(label):
                m = re.search(rf'<th>{re.escape(label)}[^<]*</th>\s*<td>([^<]*)</td>', html)
                return m.group(1).strip() if m else None
            m = re.search(r'<th>(\d{4})/(\d{1,2})/(\d{1,2})每基數實際申購總價金', html)
            if not m:
                continue
            if date(int(m.group(1)), int(m.group(2)), int(m.group(3))) != transaction_date:
                continue
            diff = _pcf_num(field('與前日已發行單位差異數'))
            nav  = _pcf_num(field('基金淨資產價值'))
            pnav = _pcf_num(field('每受益權單位淨資產價值'))
            if nav == 0 or pnav == 0:
                return None
            return {'netSub': (diff * pnav) / 1e8, 'aum': nav / 1e8}
        return None
    except Exception as e:
        print(f'  tsit {ticker} {transaction_date}: {e}')
        return None


def fetch_ctbc_day(fid: str, transaction_date: date) -> dict | None:
    """中信投信 00406A/00983A：先取 token → POST Buyback。
    StartDate 是**公告日**，回傳的「淨值日期」才是資料日（海外型可落後 2-3 個交易日）。"""
    try:
        import urllib.parse
        base = 'https://www.ctbcinvestments.com.tw/API'
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Content-Type': 'application/json; charset=utf-8',
            'Referer': 'https://www.ctbcinvestments.com.tw/Etf/Buyback',
        }
        tr = requests.post(f'{base}/home/AuthToken?token=www.ctbcinvestments.com',
                           json={'token': 'www.ctbcinvestments.com'}, headers=headers, timeout=20)
        token = tr.json().get('Data', {}).get('token')
        if not token:
            return None
        et = urllib.parse.quote(token, safe='')
        target = transaction_date.strftime('%Y/%m/%d')
        for ann in _ann_days(transaction_date):
            r = requests.post(f'{base}/etf/Buyback?token={et}',
                              json={'FID': fid, 'StartDate': ann.isoformat()},
                              headers=headers, timeout=20)
            if r.status_code != 200:
                continue
            rows = r.json().get('Data', {}).get('Data') or []
            if not rows:
                continue
            row = rows[0]
            if str(row.get('淨值日期') or '')[:10] != target:
                continue
            diff = _pcf_num(row.get('與前日已發行單位差異數'))
            nav  = _pcf_num(row.get('基金淨資產價值'))
            pnav = _pcf_num(row.get('每受益權單位淨資產價值'))
            if nav == 0 or pnav == 0:
                return None
            return {'netSub': (diff * pnav) / 1e8, 'aum': nav / 1e8}
        return None
    except Exception as e:
        print(f'  ctbc {fid} {transaction_date}: {e}')
        return None


def fetch_allianz_day(fund_no: str, transaction_date: date) -> dict | None:
    """安聯投信 00984A/00993A/00402A：XSRF 兩步（Session 自動帶 cookie）→ POST GetFundTradeInfo。
    Date 是**公告日**，資料日在回應的 CNavDt（與野村同一套系統，欄位名一致）。"""
    try:
        base = 'https://etf.allianzgi.com.tw/webapi/api'
        s = requests.Session()
        s.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        s.get(f'{base}/AntiForgery/GetAntiForgeryToken', timeout=20)
        token = s.cookies.get('X-XSRF-TOKEN')
        if not token:
            return None
        for ann in _ann_days(transaction_date):
            r = s.post(f'{base}/Fund/GetFundTradeInfo',
                       json={'FundNo': fund_no, 'Date': ann.isoformat()},
                       headers={'X-XSRF-TOKEN': token, 'Content-Type': 'application/json'}, timeout=20)
            if r.status_code != 200:
                continue
            j = r.json()
            if j.get('StatusCode') != 0:
                continue
            e = j.get('Entries') or {}
            if str(e.get('CNavDt') or '')[:10] != transaction_date.isoformat():
                continue
            nav = parse_num(e.get('CAnceNav', 0) or 0)
            if nav == 0:
                return None
            diff = parse_num(e.get('CAnceIssuesDiff', 0) or 0)
            totalav = parse_num(e.get('CAnceTotalAv', 0) or 0)
            return {'netSub': (diff * nav) / 1e8, 'aum': totalav / 1e8}
        return None
    except Exception as e:
        print(f'  allianz {fund_no} {transaction_date}: {e}')
        return None


def fetch_nomura_day(fund_no: str, transaction_date: date) -> dict | None:
    """野村投信 00980A/00985A/00999A：POST GetFundTradeInfo（與安聯同系統）。
    Date 是**公告日**，CNavDtStr 才是資料日。"""
    try:
        target = transaction_date.strftime('%Y/%m/%d')
        for ann in _ann_days(transaction_date):
            r = _post_lax(
                'https://www.nomurafunds.com.tw/API/ETFAPI/api/Fund/GetFundTradeInfo',
                json_body={'Type': 1, 'Keyword': '', 'FundNo': fund_no,
                           'Date': ann.strftime('%Y/%m/%d')},
                headers={'Content-Type': 'application/json',
                         'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                         'Referer': 'https://www.nomurafunds.com.tw/ETFWEB/pcf'})
            if r.status_code != 200:
                continue
            e = (r.json() or {}).get('Entries') or {}
            nav_dt = str(e.get('CNavDtStr') or str(e.get('CNavDt') or '')[:10].replace('-', '/'))
            if nav_dt != target:
                continue
            nav = parse_num(e.get('CAnceNav', 0) or 0)
            av  = parse_num(e.get('CAnceTotalAv', 0) or 0)
            if nav == 0 or av == 0:
                return None
            return {'netSub': parse_num(e.get('CAnceIssuesDiff', 0) or 0) * nav / 1e8,
                    'aum': av / 1e8}
        return None
    except Exception as e:
        print(f'  nomura {fund_no} {transaction_date}: {e}')
        return None


def _cathay_assets(fund_code: str, d: date) -> dict | None:
    """國泰單日規模/已發行單位數。非交易日回 result=null；**未來日期會回退到最新一日**，
    所以一律驗 preDate == 查詢日才採用。"""
    r = _get_lax(f'https://cwapi.cathaysite.com.tw/api/ETF/GetETFAssets'
                 f'?FundCode={fund_code}&SearchDate={d.isoformat()}', timeout=20)
    if r.status_code != 200:
        return None
    res = (r.json() or {}).get('result')
    if not res or str(res.get('preDate') or '').replace('/', '-') != d.isoformat():
        return None
    units = parse_num(res.get('fundOutstandingShares') or 0)
    nav   = parse_num(res.get('fundNav') or 0)
    pnav  = parse_num(res.get('fundPerNav') or 0)
    if units == 0 or nav == 0 or pnav == 0:
        return None
    return {'units': units, 'nav': nav, 'pnav': pnav}


def fetch_cathay_day(fund_code: str, transaction_date: date) -> dict | None:
    """國泰投信 00400A：官網沒有公開「與前日已發行單位差異數」→ 用已發行單位數差推算
    netSub =（當日單位數 − 前一交易日單位數）× 當日每單位淨值（同 00998A 的 CMoney 推算法）。"""
    try:
        cur = _cathay_assets(fund_code, transaction_date)
        if not cur:
            return None
        prev, d = None, transaction_date
        for _ in range(10):
            d -= timedelta(days=1)
            if d.weekday() >= 5:
                continue
            prev = _cathay_assets(fund_code, d)
            if prev:
                break
        if not prev:
            return None
        return {'netSub': (cur['units'] - prev['units']) * cur['pnav'] / 1e8,
                'aum': cur['nav'] / 1e8}
    except Exception as e:
        print(f'  cathay {fund_code} {transaction_date}: {e}')
        return None


def fetch_kgi_day(fund_id: str, transaction_date: date) -> dict | None:
    """凱基投信 00407A：POST RedemptionVC 回一段 HTML 片段。queryDate 是**公告日**，
    資料日在「(YYYY/MM/DD)每受益權單位淨資產價值(元)」的括號前綴。"""
    try:
        import re, html as _html
        target = transaction_date.strftime('%Y/%m/%d')
        for ann in _ann_days(transaction_date):
            r = _post_lax('https://www.kgifund.com.tw/Fund/RedemptionVC',
                          data={'fundID': fund_id, 'queryDate': ann.isoformat()},
                          headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                                   'X-Requested-With': 'XMLHttpRequest',
                                   'Referer': f'https://www.kgifund.com.tw/Fund/RedemptionList?fundNo={fund_id}'})
            if r.status_code != 200:
                continue
            text = _html.unescape(re.sub(r'<[^>]+>', '|',
                                         re.sub(r'<script.*?</script>', '', r.text, flags=re.S)))
            cells = [c.strip() for c in text.split('|') if c.strip()]
            def value_after(pred):
                for i, c in enumerate(cells):
                    if pred(c):
                        return cells[i + 1] if i + 1 < len(cells) else None
                return None
            pnav_raw = value_after(lambda c: c.startswith(f'({target})') and '每受益權單位淨資產價值' in c)
            if pnav_raw is None:
                continue
            pnav = _pcf_num(pnav_raw)
            nav  = _pcf_num(value_after(lambda c: c.startswith('基金淨資產價值')))
            diff = _pcf_num(value_after(lambda c: c.startswith('與前日已發行單位差異數')))
            if nav == 0 or pnav == 0:
                return None
            return {'netSub': (diff * pnav) / 1e8, 'aum': nav / 1e8}
        return None
    except Exception as e:
        print(f'  kgi {fund_id} {transaction_date}: {e}')
        return None


def fetch_yuanta_day(ticker: str, transaction_date: date) -> dict | None:
    """元大投信 00990A：查公告日(交易日+1..+5)，以回傳 trandate==交易日 對齊。"""
    try:
        target = transaction_date.strftime('%Y%m%d')
        for offset in range(1, 6):
            ann = transaction_date + timedelta(days=offset)
            if ann.weekday() >= 5:
                continue
            url = ('https://etfapi.yuantaetfs.com/ectranslation/api/bridge'
                   f'?APIType=ETFAPI&CompanyName=YUANTAFUNDS&FuncId=PCF/Daily'
                   f'&ticker={ticker}&date={ann.strftime("%Y%m%d")}')
            r = _get_lax(url, timeout=20)
            if r.status_code != 200:
                continue
            pcf = (r.json() or {}).get('PCF')
            if not pcf or str(pcf.get('trandate')) != target:
                continue
            nav = parse_num(pcf.get('nav', 0) or 0)
            if nav == 0:
                return None
            return {'netSub': (parse_num(pcf.get('issuesdiff', 0) or 0) * nav) / 1e8,
                    'aum': parse_num(pcf.get('totalav', 0) or 0) / 1e8}
        return None
    except Exception as e:
        print(f'  yuanta {ticker} {transaction_date}: {e}')
        return None


def fetch_cmoney_day(assign_id: str, transaction_date: date) -> dict | None:
    """復華 00998A 無官方申贖 → CMoney 規模/淨值序列推算 netSub = Δunits × nav。"""
    try:
        import urllib.parse
        api = 'https://www.pocket.tw/api/cm/MobileService/ashx/GetDtnoData.ashx'
        def series(dtno, major):
            mj = f';MajorTable={major}' if major else ''
            ps = f'AssignID={assign_id};DTRange=500;MTPeriod=0;DTMode=0;DTOrder=1{mj}'
            url = f'{api}?action=getdtnodata&DtNo={dtno}&ParamStr={urllib.parse.quote(ps)}&FilterNo=0'
            r = _get_lax(url, timeout=20)
            return (r.json() or {}).get('Data', []) if r.status_code == 200 else []
        aum_by = {str(x[0]): parse_num(x[7]) for x in series('60465380', '')}
        nav_by = {str(x[0]): parse_num(x[2]) for x in series('61498322', 'M708')}
        dates = sorted(d for d in aum_by if d in nav_by and nav_by[d] > 0)
        target = transaction_date.strftime('%Y%m%d')
        if target not in dates:
            return None
        idx = dates.index(target)
        if idx == 0:
            return None
        nav = nav_by[target]
        units_t = aum_by[target] * 1e8 / nav
        prev = dates[idx - 1]
        units_p = aum_by[prev] * 1e8 / nav_by[prev]
        return {'netSub': ((units_t - units_p) * nav) / 1e8, 'aum': aum_by[target]}
    except Exception as e:
        print(f'  cmoney {assign_id} {transaction_date}: {e}')
        return None


def fetch_all_peer_data(transaction_date: date) -> list:
    """Fetch net subscription data for all peer ETFs on the given date."""
    # Build shared ezmoney session once for all ezmoney ETFs
    ezmoney_etfs = [e for e in PEER_ETFS if e['source'] == 'ezmoney']
    ezmoney_session = None
    if ezmoney_etfs:
        try:
            ezmoney_session = _get_ezmoney_session(ezmoney_etfs[0]['key'])
        except Exception as e:
            print(f'  ezmoney session error: {e}')

    results = []
    for etf in PEER_ETFS:
        data = None
        if etf['source'] == 'ezmoney':
            data = fetch_ezmoney_day(etf['key'], transaction_date, session=ezmoney_session)
        elif etf['source'] == 'capital':
            data = fetch_capital_day(etf['key'], transaction_date)
        elif etf['source'] == 'fubon':
            data = fetch_fubon_day(etf['key'], transaction_date)
        elif etf['source'] == 'tsit':
            data = fetch_tsit_day(etf['key'], transaction_date)
        elif etf['source'] == 'ctbc':
            data = fetch_ctbc_day(etf['key'], transaction_date)
        elif etf['source'] == 'allianz':
            data = fetch_allianz_day(etf['key'], transaction_date)
        elif etf['source'] == 'yuanta':
            data = fetch_yuanta_day(etf['key'], transaction_date)
        elif etf['source'] == 'nomura':
            data = fetch_nomura_day(etf['key'], transaction_date)
        elif etf['source'] == 'cathay':
            data = fetch_cathay_day(etf['key'], transaction_date)
        elif etf['source'] == 'kgi':
            data = fetch_kgi_day(etf['key'], transaction_date)
        elif etf['source'] == 'cmoney':
            data = fetch_cmoney_day(etf['key'], transaction_date)
        elif etf['source'] == 'fhtrust':
            # For fhtrust, netSub comes from PCF DIFF_UNIT calculation
            # Use fhtrust PCF API (same as etf-scale)
            target_str = date_to_api(transaction_date)
            for offset in range(5):
                pcf_date = date_to_api(transaction_date + timedelta(days=offset))
                try:
                    url = f'{FHTRUST_PCF}?fundID={etf["key"]}&pcfDate={requests.utils.quote(pcf_date)}'
                    r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
                    d = r.json()
                    d = (d.get('result') or [None])[0] if d.get('result') else d
                    if not d or str(d.get('actBuyValDate', '')) != target_str:
                        continue
                    act_buy_val = parse_num(d.get('actBuyVal', 0))
                    q_diff      = parse_num(d.get('qDiff', 0))
                    nav         = parse_num(d.get('nav', 0))
                    data = {
                        'netSub': act_buy_val * q_diff / 500000 / 1e8,
                        'aum':    nav / 1e8,
                    }
                    break
                except:
                    continue
        results.append({**etf, 'data': data})
    return results


def build_peer_html(peer_results: list, transaction_date: date) -> str:
    rows_html = ''
    # 每日報告維持原本只列台股主動式ETF；海外群組只寫進 DB 給網頁分頁用，不混進這封報告。
    for etf in peer_results:
        if etf.get('group', 'tw_active') != 'tw_active':
            continue
        d = etf['data']
        if d and d['netSub'] is not None:
            ns = d['netSub']
            color = '#C00000' if ns > 0 else '#1A6B45' if ns < 0 else '#6B6460'
            sign  = '+' if ns > 0 else ''
            ns_str = f'{sign}{ns:.2f}'
            aum_str = f'{d["aum"]:.2f} 億' if d.get('aum') else '—'
        else:
            ns_str = '—'
            color  = '#BBBBBB'
            aum_str = '—'
        rows_html += f'''
        <tr style="border-bottom:1px solid #EEE9E4;">
          <td style="padding:8px 14px;font-size:13px;color:#1C1C1E;font-weight:600;">{etf["ticker"]}</td>
          <td style="padding:8px 14px;font-size:12px;color:#6B6460;">{etf["name"]}</td>
          <td style="padding:8px 14px;text-align:right;font-family:monospace;font-size:13px;font-weight:700;color:{color};">{ns_str}</td>
          <td style="padding:8px 14px;text-align:right;font-family:monospace;font-size:12px;color:#6B6460;">{aum_str}</td>
        </tr>'''

    return f'''<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>*{{margin:0;padding:0;box-sizing:border-box;}}body{{font-family:"Noto Sans TC","Segoe UI",Arial,sans-serif;background:#fff;padding:20px;width:520px;}}</style>
</head><body>
  <div style="border-left:4px solid #C00000;padding-left:12px;margin-bottom:16px;">
    <div style="font-size:17px;font-weight:700;color:#1C1C1E;">同業申贖觀測</div>
    <div style="font-size:12px;color:#6B6460;margin-top:3px;">{transaction_date}　單位：億元</div>
  </div>
  <table style="width:100%;border-collapse:collapse;border:1px solid #E8E3DF;border-radius:8px;overflow:hidden;">
    <thead>
      <tr style="background:#1C1C1E;">
        <th style="padding:9px 14px;color:#fff;font-size:11px;text-align:left;">代碼</th>
        <th style="padding:9px 14px;color:#fff;font-size:11px;text-align:left;">名稱</th>
        <th style="padding:9px 14px;color:#fff;font-size:11px;text-align:right;">淨申贖(億)</th>
        <th style="padding:9px 14px;color:#fff;font-size:11px;text-align:right;">規模</th>
      </tr>
    </thead>
    <tbody>{rows_html}</tbody>
  </table>
  <div style="margin-top:10px;font-size:11px;color:#6B6460;text-align:right;">
    正值=淨申購（紅）　負值=淨贖回（綠）　生成時間：{datetime.now(TZ).strftime('%Y/%m/%d %H:%M')} TST
  </div>
</body></html>'''


def find_trading_day_with_data(start: date, fund_id: str, max_lookback: int = 10):
    """Walk back from `start` (skipping weekends) until holdings data is found."""
    d = start
    for _ in range(max_lookback):
        if d.weekday() < 5:  # Mon–Fri
            result = fetch_holdings(date_to_api(d), fund_id)
            if result:
                return d, result
        d -= timedelta(days=1)
    return None, None


# ── Diff logic ────────────────────────────────────────────────────────────────

def build_diff_rows(base_holdings, cmp_holdings):
    """Return only changed rows, sorted by 異動金額 descending."""
    curr_map = {(h['stockid'] or h['stockname']): h for h in base_holdings}
    prev_map = {(h['stockid'] or h['stockname']): h for h in cmp_holdings}
    keys = set(curr_map) | set(prev_map)

    rows = []
    for key in keys:
        c, p = curr_map.get(key), prev_map.get(key)
        if   c and not p:              status = 'new'
        elif not c:                    status = 'removed'
        elif c['qshare'] > p['qshare']: status = 'increased'
        elif c['qshare'] < p['qshare']: status = 'decreased'
        else:                          continue  # unchanged

        c_price = c['mvalue'] / c['qshare'] if c and c['qshare'] > 0 else None
        p_price = p['mvalue'] / p['qshare'] if p and p['qshare'] > 0 else None
        if   c and p and c_price: diff_amount = c_price * (c['qshare'] - p['qshare'])
        elif c and c_price:       diff_amount = c['mvalue']
        elif p and p_price:       diff_amount = -p['mvalue']
        else:                     diff_amount = None

        stockid = (c or p)['stockid']
        rows.append({
            'stockid':    stockid,
            'stockname':  (c or p)['stockname'],
            'sector':     SECTOR_MAP.get(stockid, ''),
            'status':     status,
            'curr_q':     c['qshare']           if c else None,
            'prev_q':     p['qshare']           if p else None,
            'diff_q':     (c['qshare'] - p['qshare']) if c and p else None,
            'curr_p':     c['prate_addaccint']  if c else None,
            'prev_p':     p['prate_addaccint']  if p else None,
            'diff_p':     (c['prate_addaccint'] - p['prate_addaccint']) if c and p else None,
            'diff_amount': diff_amount,
        })

    rows.sort(key=lambda r: -(r['diff_amount'] or 0))
    return rows


# ── Formatters ────────────────────────────────────────────────────────────────

def fn(n, dec=0):
    return '—' if n is None else f'{n:,.{dec}f}'

def fd(n, dec=0):
    if n is None: return ''
    s = f'{abs(n):,.{dec}f}'
    return f'+{s}' if n > 0 else f'−{s}' if n < 0 else '0'

def fp(n):
    return '—' if n is None else f'{n:.3f}%'

def fdp(n):
    if n is None: return ''
    s = f'{abs(n):.3f}'
    return f'+{s}%' if n > 0 else f'−{s}%' if n < 0 else '0%'

def famt(n):
    if n is None: return '—'
    wan = n / 10000
    if abs(wan) < 0.05: return '0'
    s = f'{abs(wan):,.1f}'
    return f'+{s}' if wan > 0 else f'−{s}'

def diff_color(n):
    if n is None or n == 0: return '#6B6460'
    return '#C00000' if n > 0 else '#1A6B45'


# ── HTML generation ───────────────────────────────────────────────────────────

SC = {
    'new':       {'bg': '#FFF5F5', 'bbg': '#FFE8E8', 'bc': '#C00000', 'bb': '#FFCDD2', 'label': '新倉'},
    'increased': {'bg': '#FFFAFA', 'bbg': '#FFF0F0', 'bc': '#C00000', 'bb': '#FFE0E0', 'label': '加碼'},
    'decreased': {'bg': '#F5FBF5', 'bbg': '#E8F5EC', 'bc': '#1A6B45', 'bb': '#C8E6C9', 'label': '減碼'},
    'removed':   {'bg': '#EEF8EE', 'bbg': '#D8EEDC', 'bc': '#1A6B45', 'bb': '#A5D6A7', 'label': '清倉'},
}


def build_html(etf, base_data, cmp_data, curr_pcf, prev_pcf, rows, etf_price=None):
    bs = str(base_data['date'])[5:]
    cs = str(cmp_data['date'])[5:]

    counts = {s: sum(1 for r in rows if r['status'] == s) for s in SC}
    total  = sum(counts.values())

    # Scale / price card values
    aum_val = f"{curr_pcf['aum']:.2f} 億" if curr_pcf else '—'
    if curr_pcf and prev_pcf:
        da = curr_pcf['aum'] - prev_pcf['aum']
        aum_diff  = fd(da, 2) + ' 億'
        aum_color = diff_color(da)
    else:
        aum_diff = '—'; aum_color = '#6B6460'

    # ETF market price (replaces pnav)
    if etf_price and etf_price.get('price'):
        ep = etf_price['price']
        ec = etf_price.get('prev_close')
        price_val = f"{ep:.2f}"
        if ec:
            dp = ep - ec
            pct = dp / ec * 100
            sign = '+' if dp > 0 else '−' if dp < 0 else ''
            price_diff = f"{sign}{abs(dp):.2f}"
            price_diff_sub = f"({sign}{abs(pct):.2f}%)"
            price_diff_color = diff_color(dp)
        else:
            price_diff = '—'; price_diff_sub = ''; price_diff_color = '#6B6460'
        price_color = '#1C1C1E'
    else:
        price_val = '—'; price_diff = '—'; price_diff_sub = ''
        price_color = price_diff_color = '#6B6460'

    def card4(items):
        cells = ''
        for i, (label, val, color, sub) in enumerate(items):
            br = 'border-right:1px solid #EEE9E4;' if i < 3 else ''
            sub_html = f'<div style="font-size:13px;font-weight:600;color:{color};font-family:monospace;margin-top:2px;">{sub}</div>' if sub else ''
            cells += f'''<div style="padding:12px 16px;{br}">
              <div style="font-size:11px;color:#6B6460;font-weight:500;margin-bottom:4px;">{label}</div>
              <div style="font-size:20px;font-weight:700;color:{color};font-family:monospace;line-height:1.1;">{val}</div>
              {sub_html}
            </div>'''
        return f'<div style="display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #EEE9E4;border-radius:8px;overflow:hidden;margin-bottom:12px;background:#FAFAF9;">{cells}</div>'

    scale_cards = card4([
        (f'基金規模 ({bs})',       aum_val,    '#1C1C1E',         ''),
        (f'規模變化 (vs {cs})',    aum_diff,   aum_color,         ''),
        (f'ETF 股價 ({bs})',       price_val,  price_color,       ''),
        ('股價變化',               price_diff, price_diff_color,  price_diff_sub),
    ])

    stat_cards = card4([
        ('新增持倉', counts['new'],       '#C00000', ''),
        ('加碼',     counts['increased'], '#C00000', ''),
        ('減碼',     counts['decreased'], '#1A6B45', ''),
        ('清倉',     counts['removed'],   '#1A6B45', ''),
    ])

    if rows:
        tbody = ''
        for r in rows:
            sc = SC[r['status']]
            pq_c = '#BBBBBB' if r['status'] == 'removed' else '#1C1C1E'
            cq_c = '#BBBBBB' if r['status'] == 'new'     else '#1C1C1E'
            pp_c = '#BBBBBB' if r['status'] == 'removed' else '#1C1C1E'
            cp_c = '#BBBBBB' if r['status'] == 'new'     else '#1C1C1E'
            tbody += f'''<tr style="background:{sc['bg']};border-bottom:1px solid #EEE9E4;">
              <td style="padding:7px 8px;font-family:monospace;font-size:12px;color:#6B6460;text-align:center;white-space:nowrap;">{r['stockid'] or '—'}</td>
              <td style="padding:7px 8px;font-size:13px;color:#1C1C1E;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">{r['stockname']}</td>
              <td style="padding:7px 8px;font-family:monospace;font-size:12px;color:{pq_c};text-align:right;">{fn(r['prev_q'])}</td>
              <td style="padding:7px 8px;font-family:monospace;font-size:12px;color:{cq_c};text-align:right;">{fn(r['curr_q'])}</td>
              <td style="padding:7px 8px;font-family:monospace;font-size:12px;color:{diff_color(r['diff_q'])};font-weight:600;text-align:right;">{fd(r['diff_q'])}</td>
              <td style="padding:7px 8px;font-family:monospace;font-size:12px;color:{diff_color(r['diff_amount'])};font-weight:600;text-align:right;">{famt(r['diff_amount'])}</td>
              <td style="padding:7px 8px;font-family:monospace;font-size:12px;color:{pp_c};text-align:right;">{fp(r['prev_p'])}</td>
              <td style="padding:7px 8px;font-family:monospace;font-size:12px;color:{cp_c};text-align:right;">{fp(r['curr_p'])}</td>
              <td style="padding:7px 8px;font-family:monospace;font-size:12px;color:{diff_color(r['diff_p'])};font-weight:600;text-align:right;">{fdp(r['diff_p'])}</td>
              <td style="padding:7px 8px;text-align:center;"><span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600;background:{sc['bbg']};color:{sc['bc']};border:1px solid {sc['bb']};">{sc['label']}</span></td>
              <td style="padding:7px 8px;font-size:12px;color:#6B6460;white-space:nowrap;">{r['sector'] or ''}</td>
            </tr>'''
    else:
        tbody = '<tr><td colspan="11" style="text-align:center;padding:28px;color:#AAA;font-size:13px;">當日無持股異動</td></tr>'

    thead = f'''<thead><tr>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:center;white-space:nowrap;">代碼</th>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:left;white-space:nowrap;">名稱</th>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:right;white-space:nowrap;">持股 ({cs})</th>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:right;white-space:nowrap;">持股 ({bs})</th>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:right;white-space:nowrap;">持股變化</th>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:right;white-space:nowrap;">異動金額(萬)</th>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:right;white-space:nowrap;">佔比% ({cs})</th>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:right;white-space:nowrap;">佔比% ({bs})</th>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:right;white-space:nowrap;">佔比變化</th>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:center;white-space:nowrap;">操作</th>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:left;white-space:nowrap;">產業族群</th>
    </tr></thead>'''

    now_str = datetime.now(TZ).strftime('%Y/%m/%d %H:%M')
    return f'''<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>*{{margin:0;padding:0;box-sizing:border-box;}}body{{font-family:"Noto Sans TC","Segoe UI",Arial,sans-serif;background:#fff;padding:20px;width:1020px;}}</style>
</head><body>
  <div style="border-left:4px solid #C00000;padding-left:12px;margin-bottom:16px;">
    <div style="font-size:18px;font-weight:700;color:#1C1C1E;">{etf['ticker']} {etf['name']}</div>
    <div style="font-size:13px;color:#6B6460;margin-top:3px;">當日摘要　{base_data['date']} vs {cmp_data['date']}</div>
  </div>
  {scale_cards}
  {stat_cards}
  <div style="border:1px solid #E8E3DF;border-radius:8px;overflow:hidden;">
    <table style="width:100%;border-collapse:collapse;">{thead}<tbody>{tbody}</tbody></table>
  </div>
  <div style="margin-top:10px;font-size:11px;color:#6B6460;text-align:right;">資料來源：復華投信　生成時間：{now_str} TST</div>
</body></html>'''


# ── Screenshot ────────────────────────────────────────────────────────────────

async def screenshot_html(html: str) -> bytes:
    from playwright.async_api import async_playwright
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await browser.new_page(viewport={'width': 1020, 'height': 800})
        await page.set_content(html, wait_until='load')
        h = await page.evaluate('document.body.scrollHeight')
        await page.set_viewport_size({'width': 1020, 'height': h + 40})
        img = await page.screenshot(full_page=True)
        await browser.close()
    return img


# ── Pushover ──────────────────────────────────────────────────────────────────

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


def send_pushover_text(title: str, message: str, priority: int = 0):
    """Text-only Pushover (no image) — used to surface a run that produced nothing,
    so an upstream outage is never again a silent green build."""
    try:
        r = requests.post(
            'https://api.pushover.net/1/messages.json',
            data={'token': PUSHOVER_TOKEN, 'user': PUSHOVER_USER,
                  'title': title, 'message': message, 'priority': priority},
            timeout=30,
        )
        if r.json().get('status') != 1:
            print(f'  failure-alert Pushover error: {r.text}')
        else:
            print(f'  ✓ Pushover sent (alert): {title}')
    except Exception as e:
        print(f'  failure-alert send error: {e}')


# ── Main ──────────────────────────────────────────────────────────────────────

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

    # base_date 是搜尋迴圈「走到」的日期；base_data['date']（dDate）才是 API 實際回傳、
    # 真正會顯示/使用的日期——兩者可能不同（官網回放前一交易日的內容），
    # 所以 stale 判斷與 stale_note 都要用「API 實際回報的日期」而非搜尋迴圈的 base_date。
    reported_date = api_to_date(base_data['date'])
    stale, expected = is_stale(reported_date, today)
    if stale:
        print(f'  ⚠ 資料非最新：reported_date={reported_date}，最新交易日應為 {expected}')

    curr_pcf  = fetch_pcf(base_date, fid)
    prev_pcf  = fetch_pcf(cmp_date,  fid)
    etf_price = fetch_etf_price(etf.get('yfTicker', ''))

    rows = build_diff_rows(base_data['holdings'], cmp_data['holdings'])
    html = build_html(etf, base_data, cmp_data, curr_pcf, prev_pcf, rows, etf_price)

    img = await screenshot_html(html)

    bs    = str(base_data['date'])[5:]
    cs    = str(cmp_data['date'])[5:]
    total = len(rows)
    stale_note = f'\n⚠️ 官網尚未更新，此為 {reported_date} 資料（最新交易日應為 {expected}）' if stale else ''
    send_pushover(
        title   = f'{"⚠️ " if stale else ""}{etf["ticker"]} 當日摘要 {bs}',
        message = f'vs {cs}　共 {total} 筆異動{stale_note}',
        image_bytes = img,
        priority = 1 if stale else 0,
    )
    return True


def write_peer_to_supabase(peer_results: list, transaction_date: date):
    """Upsert peer redemption data to Supabase. Silently skips if credentials missing."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        print('  Supabase credentials not set, skipping DB write.')
        return
    try:
        from supabase import create_client
        client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        rows = [
            {
                'date':    str(transaction_date),
                'ticker':  etf['ticker'],
                'net_sub': round(float(etf['data']['netSub']), 6),
                'aum':     round(float(etf['data']['aum']),    6),
                'group':   etf.get('group', 'tw_active'),
            }
            for etf in peer_results
            if etf.get('data')
            and etf['data'].get('netSub') is not None
            and etf['data'].get('aum')    is not None
        ]
        if rows:
            # Must name the conflict target, else an existing (date,ticker) makes the
            # whole batch fail with 23505 — which is why newly-added tickers (e.g.
            # 00405A) never landed: they rode in a batch alongside already-stored rows.
            client.table('peer_redemption').upsert(rows, on_conflict='date,ticker').execute()
            print(f'  ✓ Supabase: upserted {len(rows)} rows for {transaction_date}')
        else:
            print('  No valid rows to write to Supabase.')
    except Exception as e:
        print(f'  Supabase write error: {e}')
        import traceback; traceback.print_exc()


def _peer_has_data(peer_results: list) -> bool:
    return any(e.get('data') and e['data'].get('netSub') is not None for e in peer_results)


def find_peer_base_date(today: date, max_back: int = 8):
    """Fallback base date for the peer table that does NOT depend on fhtrust.

    The happy path borrows fhtrust's latest holdings date as the peer transaction
    date, but on 2026-06-22 fhtrust was unreachable and dragged the (independent)
    peer section down with it. Here we walk back weekdays from yesterday and use the
    most recent day for which the peer sources themselves return data — so a fhtrust
    outage no longer suppresses 統一/群益/富邦. Returns (date, peer_results) or (None, None)."""
    d = today - timedelta(days=1)
    for _ in range(max_back):
        # Skip weekends and TWSE-confirmed non-trading days (None = TWSE unreachable,
        # in which case we don't block — fall through to the per-source date guards).
        if d.weekday() < 5 and is_twse_trading_day(d) is not False:
            results = fetch_all_peer_data(d)
            if _peer_has_data(results):
                return d, results
        d -= timedelta(days=1)
    return None, None


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

    stale, expected = is_stale(base_date, today)
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


# 海外檔的 PCF 是交易日之後 1～2 個交易日才公告（統一/群益 +2、元大 +1、CMoney 序列也跟著公告日
# 才更新），但 process_peer_redemption 只查「當天」→ 這些檔每天都拿到 None、從來沒進過 DB
# （2026-07-27 那次 12 檔只寫進 9 筆，缺的正是 00988A/00990A/00998A）。
# 這裡改成逐檔往回找「最新一筆已公告」的交易日，各自以自己的日期寫入；主鍵 (date,ticker) 的
# upsert 天然冪等，每天重跑只會補上新公告的那天。
OVERSEAS_LOOKBACK_WEEKDAYS = 6

_OVERSEAS_FETCHERS = {
    'ezmoney': fetch_ezmoney_day,
    'capital': fetch_capital_day,
    'ctbc':    fetch_ctbc_day,
    'tsit':    fetch_tsit_day,
    'allianz': fetch_allianz_day,
    'yuanta':  fetch_yuanta_day,
    'cmoney':  fetch_cmoney_day,
}


def process_overseas_redemption(today: date) -> int:
    """補海外主動式ETF 的申贖（只寫 DB，不推播）。回傳成功寫入的檔數。"""
    print('\n[海外同業申贖：補最新已公告交易日]')
    written = 0
    for etf in PEER_ETFS:
        if etf.get('group') != 'overseas':
            continue
        fetcher = _OVERSEAS_FETCHERS.get(etf['source'])
        if fetcher is None:
            print(f'  {etf["ticker"]}: 無對應抓取器（{etf["source"]}），略過')
            continue

        # 從「今天」往回掃：投信下午就會把隔日生效的清單掛出來（統一 49YTW 16:40 已能查到
        # 當日 TranDate），所以 T 日本身也可能有資料，不能從 T-1 才開始。
        candidates, d = [], today
        while len(candidates) < OVERSEAS_LOOKBACK_WEEKDAYS:
            if d.weekday() < 5:
                candidates.append(d)
            d -= timedelta(days=1)

        for d in candidates:
            if is_twse_trading_day(d) is False:   # None = TWSE 連不到，照抓
                continue
            data = fetcher(etf['key'], d)
            if data and data.get('netSub') is not None and data.get('aum') is not None:
                write_peer_to_supabase([{**etf, 'data': data}], d)
                print(f'  {etf["ticker"]} {d}: netSub={data["netSub"]:+.2f}億 aum={data["aum"]:.2f}億')
                written += 1
                break
        else:
            print(f'  {etf["ticker"]}: 近 {OVERSEAS_LOOKBACK_WEEKDAYS} 個工作日查無已公告資料')
    return written


async def main():
    if not PUSHOVER_TOKEN or not PUSHOVER_USER:
        sys.exit('ERROR: PUSHOVER_TOKEN and PUSHOVER_USER must be set.')

    test_date_raw = os.environ.get('TEST_DATE', '').strip()
    if test_date_raw:
        # 手動測試單一日期的 00991A 進出場摘要：只送這一則 Pushover，
        # 不動 peer_redemption / unit_watch / overseas（避免重寫已正確的 DB 資料、
        # 重複推播同業申贖）。
        test_date = datetime.strptime(test_date_raw, '%Y-%m-%d').date()
        print(f'TEST_DATE (TST): {test_date}')
        await process_etf(ETFS[0], test_date)
        return

    today = datetime.now(TZ).date()
    print(f'Date (TST): {today}')

    sent_any = False

    for etf in ETFS:
        try:
            sent_any = bool(await process_etf(etf, today)) or sent_any
        except Exception as e:
            print(f'  ERROR: {e}')
            import traceback; traceback.print_exc()

    try:
        sent_any = bool(await process_peer_redemption(today)) or sent_any
    except Exception as e:
        print(f'  Peer redemption ERROR: {e}')
        import traceback; traceback.print_exc()

    # 單位數注意商品：獨立於 sent_any（不發 Pushover），失敗也不影響上面兩區塊的告警邏輯。
    try:
        process_unit_watch(today)
    except Exception as e:
        print(f'  Unit watch ERROR: {e}')
        import traceback; traceback.print_exc()

    # 海外檔的公告落後當天，必須另外補（不推播，只寫 DB 給網頁分頁用）。
    try:
        process_overseas_redemption(today)
    except Exception as e:
        print(f'  Overseas redemption ERROR: {e}')
        import traceback; traceback.print_exc()

    if not sent_any:
        # Every section produced nothing (e.g. all data sources unreachable). Don't let
        # this be a silent green build — alert, and exit non-zero so the run shows red.
        send_pushover_text(
            '⚠️ 每日摘要無資料',
            f'{today} 排程已執行但未取得任何資料（資料源可能暫時無法連線）。'
            f'可至 GitHub Actions 手動重新觸發 daily_summary。',
            priority=1,
        )
        sys.exit('No data produced this run — see logs above.')


if __name__ == '__main__':
    asyncio.run(main())
