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

# holdingsLag = 該檔持股「本來就會落後幾個交易日」，只給 is_stale 判斷要不要打 ⚠️ 用。
ETFS = [
    {'ticker': '00991A', 'name': '復華主動式ETF', 'fundId': 'ETF23', 'yfTicker': '00991A.TW',
     'holdingsLag': 0},
    # 00409A 成立 2026/08/20、掛牌 2026/09/02。掛牌前復華每日持股 detail 是空的、PCF 全 null →
    # find_trading_day_with_data 回 (None, None)、process_etf 直接 skip（不推播、不影響 00991A 的
    # sent_any 判定）；資料一開始公布就會自己接上。
    # 海外檔的持股 T+1 才公告：今天(T)拿到 T-1、對比 T-2 是正常的，別再打 ⚠️（holdingsLag=1）。
    {'ticker': '00409A', 'name': '復華全球未來50主動式ETF', 'fundId': 'ETF26', 'yfTicker': '00409A.TW',
     'holdingsLag': 1},
]

# 單位數注意商品：主管機關要求成立以來平均單位數不得低於發行時單位數之一半。
# listing_units 只作為文件用途（門檻換算在網站 lib/unitWatch.ts 做），此處只負責每日存檔 qIssue。
UNIT_WATCH_PRODUCTS = [
    {'ticker': '00986D', 'fundId': 'ETF25', 'listing_date': date(2026, 4, 15), 'listing_units': 230_677_000.0},
]

PUSHOVER_TOKEN     = os.environ.get('PUSHOVER_TOKEN', '')
PUSHOVER_USER      = os.environ.get('PUSHOVER_USER', '')
# Email 副本（與 Pushover 同內容、同時機）。三個都設齊才會寄，缺任一個就靜默跳過，
# 不影響 Pushover——email 是附加通道，不該讓它的設定問題把主推播拖下水。
GMAIL_USER         = os.environ.get('GMAIL_USER', '')
# Google 產生的應用程式密碼是「abcd efgh ijkl mnop」這種帶空格的顯示格式，直接貼進 secret
# 很常連空白一起帶進來 → 去掉所有空白字元（含不小心夾帶的換行）。
GMAIL_APP_PASSWORD = re.sub(r'\s+', '', os.environ.get('GMAIL_APP_PASSWORD', ''))
REPORT_EMAIL_TO    = os.environ.get('REPORT_EMAIL_TO', '')   # 可逗號分隔多個收件者
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


def is_stale(reported_date: date, today: date, lag_days: int = 0) -> tuple[bool, date | None]:
    """回傳 (是否為非最新交易日資料, 這檔「應該要有」的最新資料日或 None)。

    lag_days = 這檔基金的持股本來就會落後幾個交易日。**海外檔與國內檔的差別就在這裡**：
    國內檔(00991A) T 日下午就掛出 T 日持股，lag_days=0；海外檔(00409A) 要 T+1 才公告，
    所以今天(T)拿到 T-1 的資料是正常的、不是官網沒更新，lag_days=1——只有連 T-1 都沒有
    （停在 T-2 以前）才該告警。
    expected 為 None（TWSE 行事曆連不到）時一律不視為 stale——呼叫端不可誤報。"""
    expected = latest_expected_trading_day(today)
    if expected is None:
        return False, None
    for _ in range(lag_days):
        prev = latest_expected_trading_day(expected - timedelta(days=1))
        if prev is None:
            return False, expected
        expected = prev
    return reported_date < expected, expected


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
    # 復華官方 PCF 現在有回 actBuyValDate（2026-08-23 實測 ETF24 完整），不必再用 CMoney 推算
    # （CMoney 用「規模÷淨值」還原單位數，有 ±0.01 億取整噪音，且規模以公告日標記會錯位）。
    {'ticker': '00998A', 'name': '復華全球金融', 'source': 'fhtrust', 'key': 'ETF24', 'group': 'overseas'},
    # 2026/09/02 掛牌（復華自家海外第二檔）。官方 PCF 形狀同 ETF24，直接沿用 fetch_fhtrust_day。
    # since = 這檔最早查得到的 actBuyValDate：ETFPcf 從掛牌日(09/02)才開始有 postDate，掛牌前的
    # pcfDate 全回 null；09/02 那筆自報的交易日是 08/31 → 08-31 以前不列入補洞的 expected。
    {'ticker': '00409A', 'name': '復華全球未來50', 'source': 'fhtrust', 'key': 'ETF26', 'group': 'overseas',
     'since': '2026-08-31'},
    {'ticker': '00402A', 'name': '安聯美國科技', 'source': 'allianz', 'key': 'E0003',  'group': 'overseas'},
    # 2026-08-26 補：原本漏掉是沒試過，不是真的沒來源——摩根投信一樣有 CMoney 規模/淨值序列。
    # 2026-08-26 修：摩根投信官網其實有官方 PCF(product-data API)，不用只靠 CMoney 反推——
    # 只是這支 API 沒有依日期查詢的能力，只回「目前最新一筆」，抓不到時才退回 CMoney
    # 反推頂著(見 fetch_jpmorgan_estimate，標記 is_estimate=True)。
    {'ticker': '00989A', 'name': '摩根美國科技', 'source': 'jpmorgan', 'key': 'TW00000989A5', 'group': 'overseas'},
    # 2026/08/26 掛牌（統一投信，上櫃）。fundCode 由 ezmoney PCF 頁的 fundCode↔代號配對查得。
    # since = 這檔「最早查得到申贖」的交易日（ezmoney 掛牌前兩天就掛得出 PCF）。補洞用它排除
    # 掛牌前的日期——否則每個舊交易日都會因為少這一檔而被判成缺漏、每天重抓一輪全部（實例：
    # 2026-08-26 那次 run 標了 8 天、一筆都補不了，卻把 job 從 10 分鐘推過 15 分鐘 timeout）。
    {'ticker': '00411A', 'name': '統一前沿科技', 'source': 'ezmoney', 'key': '64YTW',  'group': 'overseas',
     'since': '2026-08-24'},
    # 熱門ETF（被動式大型 ETF，2026-09-12 新增）。口徑與主動式群組完全一致：
    #   netSub = 單位數淨變動 × 每受益權單位淨值、aum = 基金淨資產價值，都取自各家官方 PCF。
    # ⚠ since 一律 2026-01-01：使用者只要今年以來的紀錄，DB 裡主動式那批卻是 2025-12-08 起。
    #   不設 since 的話 12 月那幾天會永遠被判成缺漏，每天的補洞邏輯都要白抓一輪（同 00411A 的教訓）。
    # ⚠ 0050 於 2026-06-18 一拆四：netSub 是「同一天的單位數差 × 同一天的每單位淨值」，
    #   拆分前後各自自洽，不需要（也不可以）再另外做還原調整。
    {'ticker': '0050',  'name': '元大台灣50',      'source': 'yuanta',  'key': '0050',  'group': 'hot',
     'since': '2026-01-01'},
    {'ticker': '0056',  'name': '元大高股息',      'source': 'yuanta',  'key': '0056',  'group': 'hot',
     'since': '2026-01-01'},
    {'ticker': '00878', 'name': '國泰永續高股息',  'source': 'cathay',  'key': 'CN',    'group': 'hot',
     'since': '2026-01-01'},
    {'ticker': '00919', 'name': '群益台灣精選高息', 'source': 'capital', 'key': '195',   'group': 'hot',
     'since': '2026-01-01'},
    # 復華自家兩檔被動式：fundID 由官網 /api/fundList 逐筆的 fundID ↔ etf002（＝股票代號）對出來
    # （ETF21=00929 復華台灣科技優息、ETF07=00712 復華富時不動產；同一份表 ETF23=00991A 可自我驗證）。
    {'ticker': '00929', 'name': '復華台灣科技優息', 'source': 'fhtrust', 'key': 'ETF21', 'group': 'hot',
     'since': '2026-01-01'},
    {'ticker': '00712', 'name': '復華富時不動產',  'source': 'fhtrust', 'key': 'ETF07', 'group': 'hot',
     'since': '2026-01-01'},
    # 槓桿型（元大台灣50正2）。PCF 形狀與 0050/0056 完全相同，直接沿用 fetch_yuanta_day。
    {'ticker': '00631L', 'name': '元大台灣50正2', 'source': 'yuanta',  'key': '00631L', 'group': 'hot',
     'since': '2026-01-01'},
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
    DataDate 是**公告日**；資料日藏在「YYYY/M/D每基數實際申購總價金」標籤前綴。

    台新的頁面不像其他 5 家投信會另外帶一個「預估發行受益權單位數」欄位——它只有單一一組
    數字，用 DataDate 往回推 2 個交易日當資料日。但實測這個 DataDate 可以查到「還沒到」的
    未來日期（例如今天查明天），也就是說要湊到 transaction_date 對得上，有時得查一個還沒
    真正發生的公告日——這種情況下這筆數字還沒經過真正的「今天」，穩妥起見一併標記
    is_estimate=True（即使實測過從未被事後修正，仍比照其他 5 家的謹慎作法處理）。"""
    try:
        import re
        today_tw = datetime.now(TZ).date()
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
            return {'netSub': (diff * pnav) / 1e8, 'aum': nav / 1e8, 'is_estimate': ann > today_tw}
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


# ── 海外主動式ETF 申贖『預估值』fetchers ─────────────────────────────────────
# 官方申購買回清單除了「已正式確定」的那一天，通常還會多帶一個「預估發行受益權單位數」
# 欄位（各家命名不同：中信/統一 PRE_OUT_UNIT、元大 preunit、安聯 CAnceTotalIssuesT1、
# 群益 totUnita），連同它自己的日期戳一起發布——這代表「目前為止已知、還沒正式定案」
# 的最新總單位數。用它減掉已確定的「已發行受益權單位總數」、乘上最新一筆已知的
# 每受益權單位淨資產價值，可以在正式值公告前先抓出一個概算的淨申贖，回傳的 dict 帶
# is_estimate=True 標記；正式值出來後 process_overseas_estimate_confirm() 會覆蓋掉它。
# 復華(fhtrust) 也有：preQIssue / preQIssueDate（2026-09-02 複查推翻舊結論，見
# fetch_fhtrust_estimate）。台新(tsit) 的頁面則是真的只有單一一組數字（實測欄位只到
# 「每現金申購單位約當市值」），摩根(jpmorgan) 官方 PCF 又不能指定日期——這兩家改用
# CMoney 規模/淨值反推頂著（fetch_jpmorgan_estimate），台新則只能等公告。

def _parse_flex_slash_date(s: str) -> date | None:
    """解析 'YYY/MM/DD' 格式日期，年份可能是民國(如 115/08/24)或西元(如 2026/08/24)。"""
    s = (s or '').strip()
    m = re.match(r'^(\d{2,4})/(\d{1,2})/(\d{1,2})', s)
    if not m:
        return None
    y = int(m.group(1))
    if y < 1000:
        y += 1911
    try:
        return date(y, int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


ESTIMATE_ANNOUNCE_LOOKAHEAD = 3   # 含今天，往後掃幾個「公告日」


def _announce_candidates(today: date, n: int = ESTIMATE_ANNOUNCE_LOOKAHEAD) -> list:
    """公告日候選：今天 + 之後 n-1 個營業日（今天非平日就從下一個營業日起算）。"""
    days = [today] if today.weekday() < 5 else []
    d = today
    while len(days) < n:
        d = _next_biz_day(d)
        days.append(d)
    return days


def _newest_estimate(fetch_one, today: date | None = None) -> dict | None:
    """對每個公告日候選各抓一次，回「自報日期最新」的那筆預估。

    ⚠️ 為什麼不能只查今天：各家投信在當天下午就會把**次一公告日**的清單掛出來，而那份
    清單裡的預估欄位對應的才是**今天**。實測 2026-08-26 16:15——
      元大 00990A：date=08/26 → predate=08/25；date=08/27 → predate=08/26（已經掛出來了）
      統一 00411A：date=08/26 → ValueDate=08/25；date=08/27 當下還沒掛（約 17:00 後才有）
    只查 today 的話，預估序列會**固定落後一個交易日**，永遠拿不到當天的數字。
    抓到「今天」的預估就提早收工，不用把候選掃完。
    """
    today = today or date.today()
    best = None
    for ann in _announce_candidates(today):
        try:
            p = fetch_one(ann)
        except Exception:
            p = None
        if not p or not p.get('date'):
            continue
        # 防未來日：實測 5 家都只到「次一公告日」為止、預估日不超過今天，但群益的
        # buyback 就有過「date1 是下一交易日」的前科，寧可 clamp 也不要讓網站/推播跳未來日。
        if p['date'] > today:
            print(f'  ⚠ 預估日 {p["date"]} 超過今天 {today}，忽略（公告日候選 {ann}）')
            continue
        if best is None or p['date'] > best['date']:
            best = p
            if best['date'] >= today:   # 已是最新可能的一天，沒必要再往後掃
                break
    return best


def fetch_ctbc_estimate(fid: str) -> dict | None:
    """中信投信 00406A/00983A：讀「預估發行受益權單位數(DATE)」概算尚未定案那天。"""
    return _newest_estimate(lambda ann: _ctbc_estimate_at(fid, ann))


def _ctbc_estimate_at(fid: str, ann: date) -> dict | None:
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
        r = requests.post(f'{base}/etf/Buyback?token={et}',
                          json={'FID': fid, 'StartDate': ann.isoformat()},
                          headers=headers, timeout=20)
        if r.status_code != 200:
            return None
        rows = r.json().get('Data', {}).get('Data') or []
        if not rows:
            return None
        row = rows[0]
        est_date = _parse_flex_slash_date(row.get('預估發行受益權單位數DATE'))
        pnav = _pcf_num(row.get('每受益權單位淨資產價值'))
        if not est_date or pnav == 0:
            return None
        est_units = _pcf_num(row.get('預估發行受益權單位數'))
        cur_units = _pcf_num(row.get('已發行受益權單位總數'))
        return {'date': est_date, 'netSub': (est_units - cur_units) * pnav / 1e8,
                'aum': est_units * pnav / 1e8, 'is_estimate': True}
    except Exception as e:
        print(f'  ctbc-estimate {fid}: {e}')
        return None


def fetch_ezmoney_estimate(fund_code: str, session: requests.Session | None = None) -> dict | None:
    """統一投信 00988A/00411A：GetPCF 裡的 PRE_OUT_UNIT 概算尚未定案那天。"""
    try:
        s = session or _get_ezmoney_session(fund_code)
    except Exception as e:
        print(f'  ezmoney-estimate {fund_code}: {e}')
        return None
    return _newest_estimate(lambda ann: _ezmoney_estimate_at(s, fund_code, ann))


def _ezmoney_estimate_at(s: requests.Session, fund_code: str, ann: date) -> dict | None:
    try:
        payload = {'fundCode': fund_code, 'date': _roc_date(ann), 'specificDate': True}
        r = s.post(f'https://{EZMONEY_HOST}/ETF/Transaction/GetPCF', json=payload,
                   headers={'X-Requested-With': 'XMLHttpRequest',
                            'Referer': f'https://{EZMONEY_HOST}/ETF/Transaction/PCF?fundCode={fund_code}'},
                   timeout=25)
        if r.status_code != 200 or 'application/json' not in r.headers.get('content-type', ''):
            return None
        pcf = r.json().get('pcf', [])
        if not pcf:
            return None
        get = lambda code: next((p for p in pcf if p.get('PCFCode', '').upper() == code), None)
        pre = get('PRE_OUT_UNIT')
        if not pre:
            return None
        est_date = _parse_flex_slash_date(pre.get('ValueDate'))
        pnav = parse_num((get('P_UNIT') or {}).get('Amount', 0))
        if not est_date or pnav == 0:
            return None
        est_units = parse_num(pre.get('Amount', 0))
        cur_units = parse_num((get('OUT_UNIT') or {}).get('Amount', 0))
        return {'date': est_date, 'netSub': (est_units - cur_units) * pnav / 1e8,
                'aum': est_units * pnav / 1e8, 'is_estimate': True}
    except Exception as e:
        print(f'  ezmoney-estimate {fund_code}: {e}')
        return None


def fetch_yuanta_estimate(ticker: str) -> dict | None:
    """元大投信 00990A：讀 preunit/predate 概算尚未定案那天。"""
    return _newest_estimate(lambda ann: _yuanta_estimate_at(ticker, ann))


def _yuanta_estimate_at(ticker: str, ann: date) -> dict | None:
    try:
        url = ('https://etfapi.yuantaetfs.com/ectranslation/api/bridge'
               f'?APIType=ETFAPI&CompanyName=YUANTAFUNDS&FuncId=PCF/Daily'
               f'&ticker={ticker}&date={ann.strftime("%Y%m%d")}')
        r = _get_lax(url, timeout=20)
        if r.status_code != 200:
            return None
        pcf = (r.json() or {}).get('PCF')
        if not pcf:
            return None
        predate_raw = str(pcf.get('predate') or '')
        if len(predate_raw) != 8:
            return None
        est_date = date(int(predate_raw[:4]), int(predate_raw[4:6]), int(predate_raw[6:8]))
        nav = parse_num(pcf.get('nav', 0) or 0)
        if nav == 0:
            return None
        est_units = parse_num(pcf.get('preunit', 0) or 0)
        cur_units = parse_num(pcf.get('osunit', 0) or 0)
        return {'date': est_date, 'netSub': (est_units - cur_units) * nav / 1e8,
                'aum': est_units * nav / 1e8, 'is_estimate': True}
    except Exception as e:
        print(f'  yuanta-estimate {ticker}: {e}')
        return None


def fetch_allianz_estimate(fund_no: str) -> dict | None:
    """安聯投信 00402A：讀 CAnceTotalIssuesT1(Date) 概算尚未定案那天。"""
    return _newest_estimate(lambda ann: _allianz_estimate_at(fund_no, ann))


def _allianz_estimate_at(fund_no: str, ann: date) -> dict | None:
    try:
        base = 'https://etf.allianzgi.com.tw/webapi/api'
        s = requests.Session()
        s.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        s.get(f'{base}/AntiForgery/GetAntiForgeryToken', timeout=20)
        token = s.cookies.get('X-XSRF-TOKEN')
        if not token:
            return None
        r = s.post(f'{base}/Fund/GetFundTradeInfo',
                   json={'FundNo': fund_no, 'Date': ann.isoformat()},
                   headers={'X-XSRF-TOKEN': token, 'Content-Type': 'application/json'}, timeout=20)
        if r.status_code != 200:
            return None
        j = r.json()
        if j.get('StatusCode') != 0:
            return None
        e = j.get('Entries') or {}
        est_date_raw = str(e.get('CAnceTotalIssuesT1Date') or '')[:10]
        nav = parse_num(e.get('CAnceNav', 0) or 0)
        if not est_date_raw or nav == 0:
            return None
        est_date = date.fromisoformat(est_date_raw)
        est_units = parse_num(e.get('CAnceTotalIssuesT1', 0) or 0)
        cur_units = parse_num(e.get('CAnceTotalIssues', 0) or 0)
        return {'date': est_date, 'netSub': (est_units - cur_units) * nav / 1e8,
                'aum': est_units * nav / 1e8, 'is_estimate': True}
    except Exception as e:
        print(f'  allianz-estimate {fund_no}: {e}')
        return None


def fetch_capital_estimate(fund_id: str) -> dict | None:
    """群益投信 00997A：讀 totUnita/date3 概算尚未定案那天。"""
    return _newest_estimate(lambda ann: _capital_estimate_at(fund_id, ann))


def _capital_estimate_at(fund_id: str, ann: date) -> dict | None:
    try:
        s = requests.Session()
        s.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        s.get(f'https://{CAPITAL_HOST}/', timeout=15)
        r = s.post(f'https://{CAPITAL_HOST}/CFWeb/api/etf/buyback',
                  json={'fundId': fund_id, 'date': str(ann)},
                  headers={'Referer': f'https://{CAPITAL_HOST}/etf/transaction/buyback'}, timeout=20)
        if r.status_code != 200:
            return None
        pcf = (r.json().get('data') or {}).get('pcf') or {}
        date3 = pcf.get('date3')
        pnav = parse_num(pcf.get('pUnit', 0))
        if not date3 or pnav == 0:
            return None
        est_date = date.fromisoformat(date3)
        est_units = parse_num(pcf.get('totUnita', 0))
        cur_units = parse_num(pcf.get('totUnit', 0))
        return {'date': est_date, 'netSub': (est_units - cur_units) * pnav / 1e8,
                'aum': est_units * pnav / 1e8, 'is_estimate': True}
    except Exception as e:
        print(f'  capital-estimate {fund_id}: {e}')
        return None


def _xlsx_sheet1_label_values(content: bytes) -> dict:
    """最小 xlsx 讀取器（只用 stdlib zipfile/xml，不加 openpyxl 依賴）：讀第一個工作表
    A/B 兩欄組成的 label→value 字典。摩根 PCF 的 excel 匯出裡數字也是走 sharedStrings
    存字串，不需要另外分辨型別。"""
    import io
    import zipfile
    import xml.etree.ElementTree as ElementTree
    ns = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
    def safe_parse(xml_bytes: bytes):
        # 這裡解析的是我們自己向摩根投信官網請求來的 xlsx（信任來源，不是使用者上傳內容），
        # 但還是擋掉 DOCTYPE/ENTITY 宣告當一道低成本保險，避免 XXE／entity expansion——
        # 正常的 xlsx sheet XML 本來就不會有這兩種宣告。
        if b'<!DOCTYPE' in xml_bytes[:500] or b'<!ENTITY' in xml_bytes[:500]:
            raise ValueError('unexpected DOCTYPE/ENTITY in xlsx XML part')
        return ElementTree.fromstring(xml_bytes)

    z = zipfile.ZipFile(io.BytesIO(content))
    shared: list[str] = []
    if 'xl/sharedStrings.xml' in z.namelist():
        root = safe_parse(z.read('xl/sharedStrings.xml'))
        for si in root.findall(f'{ns}si'):
            shared.append(''.join(t.text or '' for t in si.iter(f'{ns}t')))
    sheet = safe_parse(z.read('xl/worksheets/sheet1.xml'))
    out: dict[str, str] = {}
    for row in sheet.iter(f'{ns}row'):
        a = b = None
        for c in row.findall(f'{ns}c'):
            col = ''.join(ch for ch in (c.get('r') or '') if ch.isalpha())
            v = c.find(f'{ns}v')
            if v is None or v.text is None:
                continue
            val = shared[int(v.text)] if c.get('t') == 's' else v.text
            if col == 'A':
                a = val
            elif col == 'B':
                b = val
        if a is not None and b is not None:
            out[a] = b
    return out


def fetch_jpmorgan_day(cusip: str, transaction_date: date) -> dict | None:
    """摩根投信 00989A：官方申購買回清單「歷史資料查詢下載」excel 端點（頁面上「公告日期
    (點選最近一個月日期下載歷史資料)」那個功能，同網域另一支端點，可依日期查詢——比原本
    以為的 product-data API(無日期參數)更好用），資料日一樣藏在「YYYY/MM/DD 每受益權單位
    淨資產價值(元)」標籤前綴。實測固定是查詢日往回推 2 個交易日，但跟其他家一律用
    _ann_days() 逐一試候選查詢日、比對回應裡的資料日，不寫死位移。只保留約一個月內的資料，
    更早查詢會 404（頁面上「最近一個月」字樣屬實）。"""
    for ann in _ann_days(transaction_date):
        try:
            url = ('https://am.jpmorgan.com/FundsMarketingHandler/excel'
                   f'?type=m12_pcf&cusip={cusip}&country=tw&role=twetf&locale=zh-TW&date={ann.isoformat()}')
            r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
            if r.status_code != 200:
                continue
            pairs = _xlsx_sheet1_label_values(r.content)
            pnav = None
            matched = False
            for k, v in pairs.items():
                m = re.match(r'^(\d{4})/(\d{1,2})/(\d{1,2})\s*每受益權單位淨資產價值', k)
                if m:
                    if date(int(m.group(1)), int(m.group(2)), int(m.group(3))) == transaction_date:
                        pnav = _pcf_num(v)
                        matched = True
                    break
            if not matched or pnav is None or pnav == 0:
                continue
            diff = _pcf_num(pairs.get('與前日已發行單位差異數'))
            nav  = _pcf_num(pairs.get('基金淨資產價值(元)'))
            if nav == 0:
                continue
            return {'netSub': (diff * pnav) / 1e8, 'aum': nav / 1e8}
        except Exception as e:
            print(f'  jpmorgan {cusip} {ann}: {e}')
            continue
    return None


# cusip → CMoney AssignID（給 fetch_jpmorgan_estimate 用；目前只有 00989A 一檔）。
JPMORGAN_CUSIP_TO_TICKER = {'TW00000989A5': '00989A'}


def fetch_jpmorgan_estimate(cusip: str) -> dict | None:
    """摩根 00989A：官方 PCF 沒有依日期查詢的能力，抓不到「還沒公告那天」的正式值時，
    用 CMoney 規模/淨值反推最新一個交易日的概算值頂著（邏輯同 fetch_cmoney_day，但這裡
    要的是「最新一筆」而非「指定某天」），標記 is_estimate=True。等 fetch_jpmorgan_day
    之後跟上進度、抓到同一天的正式值，process_overseas_estimate_confirm 會自動覆蓋掉。"""
    try:
        assign_id = JPMORGAN_CUSIP_TO_TICKER.get(cusip, cusip)
        import urllib.parse
        api = 'https://www.pocket.tw/api/cm/MobileService/ashx/GetDtnoData.ashx'
        def series(dtno, major):
            mj = f';MajorTable={major}' if major else ''
            ps = f'AssignID={assign_id};DTRange=10;MTPeriod=0;DTMode=0;DTOrder=1{mj}'
            url = f'{api}?action=getdtnodata&DtNo={dtno}&ParamStr={urllib.parse.quote(ps)}&FilterNo=0'
            r = _get_lax(url, timeout=20)
            return (r.json() or {}).get('Data', []) if r.status_code == 200 else []
        aum_by = {str(x[0]): parse_num(x[7]) for x in series('60465380', '')}
        nav_by = {str(x[0]): parse_num(x[2]) for x in series('61498322', 'M708')}
        dates = sorted(d for d in aum_by if d in nav_by and nav_by[d] > 0)
        if len(dates) < 2:
            return None
        target, prev = dates[-1], dates[-2]
        nav = nav_by[target]
        units_t = aum_by[target] * 1e8 / nav
        units_p = aum_by[prev] * 1e8 / nav_by[prev]
        return {
            'date': date(int(target[:4]), int(target[4:6]), int(target[6:8])),
            'netSub': ((units_t - units_p) * nav) / 1e8,
            'aum': aum_by[target],
            'is_estimate': True,
        }
    except Exception as e:
        print(f'  jpmorgan-estimate {cusip}: {e}')
        return None


def fetch_fhtrust_estimate(fund_id: str) -> dict | None:
    """復華 00998A/00409A：ETFPcf 的 preQIssue(預估發行受益權單位數) 概算尚未定案那天。

    ⚠️ 2026-09-02 訂正：原本以為復華的 PCF 沒有預估欄位，其實一直都有 preQIssueDate /
    preQIssue——只是**台股檔(ETF23) 一律回 '-'**（它 T+1 就公告正式值，本來就不需要預估），
    只有海外檔(ETF24/ETF26) 才給值，早期只拿台股檔試才看不出來。少了這支，兩檔復華海外
    ETF 的資料日會固定比其他家慢一天（別人是 T、它是 T-1）。
    """
    return _newest_estimate(lambda ann: _fhtrust_estimate_at(fund_id, ann))


def _fhtrust_estimate_at(fund_id: str, ann: date) -> dict | None:
    try:
        url = f'{FHTRUST_PCF}?fundID={fund_id}&pcfDate={requests.utils.quote(date_to_api(ann))}'
        r = get_with_retry(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
        d = r.json()
        d = (d.get('result') or [None])[0] if d.get('result') else d
        if not d:
            return None
        est_date = _parse_flex_slash_date(str(d.get('preQIssueDate') or ''))
        pnav     = _pcf_num(d.get('pnav'))
        if not est_date or pnav == 0:
            return None
        est_units = _pcf_num(d.get('preQIssue'))
        cur_units = _pcf_num(d.get('qIssue'))
        if est_units <= 0:
            return None
        return {'date': est_date, 'netSub': (est_units - cur_units) * pnav / 1e8,
                'aum': est_units * pnav / 1e8, 'is_estimate': True}
    except Exception as e:
        print(f'  fhtrust-estimate {fund_id} {ann}: {e}')
        return None


_OVERSEAS_ESTIMATE_FETCHERS = {
    'ctbc':     fetch_ctbc_estimate,
    'ezmoney':  fetch_ezmoney_estimate,
    'yuanta':   fetch_yuanta_estimate,
    'allianz':  fetch_allianz_estimate,
    'capital':  fetch_capital_estimate,
    'jpmorgan': fetch_jpmorgan_estimate,
    'fhtrust':  fetch_fhtrust_estimate,
}


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


def fetch_fhtrust_day(fund_id: str, transaction_date: date) -> dict | None:
    """復華官方申購買回清單（PCF）→ 指定交易日的 {netSub(億), aum(億)}，查無回 None。

    netSub = (qDiff ÷ 每基數單位數) × actBuyVal
           = 單位數淨變動換算成幾個申購買回基數 × 每基數實際申購總價金。

    **交易日一律以 API 自報的 actBuyValDate 為準，不可用「公告日 − N」去推**：
    台股檔（ETF23）的 actBuyValDate 落後公告日 1 個交易日，海外檔（ETF24）落後 2 個，
    寫死推算會整檔對不上而靜靜回 None。這裡改成從交易日往後掃公告日候選、比對自報日期。

    ETF24（海外）實測：查詢的 pcfDate 可以是「還沒真正發生」的未來日期（例如今天查明天，
    就能拿到「昨天」的正式值）——這種情況下數字還沒經過真正的「今天」，比照 fetch_tsit_day
    標記 is_estimate=True。ETF23（台股）不會踩到這個情況（今天查今天就夠、查明天永遠是
    None），所以這條判斷對它是無害的 no-op。

    掃 14 個日曆日、掃過頭就提早收工：T+2 交易日碰上春節（連休 9 天）要 11 個日曆日才等到
    公告，原本寫死 8 天會讓海外檔（ETF24/ETF26/ETF07=00712）在年假前最後一個交易日靜靜漏掉。
    actBuyValDate 隨 pcfDate 單調遞增，所以一旦回來的自報日期已經越過目標日就不可能再對上，
    直接收工——非交易日的查詢因此反而比原本更省請求，不是單純把上限拉高。
    """
    target_str = date_to_api(transaction_date)
    today_tw = datetime.now(TZ).date()
    for offset in range(14):
        pcf_date_obj = transaction_date + timedelta(days=offset)
        pcf_date = date_to_api(pcf_date_obj)
        try:
            url = f'{FHTRUST_PCF}?fundID={fund_id}&pcfDate={requests.utils.quote(pcf_date)}'
            r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
            d = r.json()
            d = (d.get('result') or [None])[0] if d.get('result') else d
            if not d or not d.get('actBuyValDate'):
                continue
            if str(d['actBuyValDate']) > target_str:
                return None      # 已經掃過頭：目標日當天沒有申購買回清單（多半是休市日）
            if str(d['actBuyValDate']) != target_str:
                continue
            return {
                'netSub': parse_num(d.get('actBuyVal', 0)) * parse_num(d.get('qDiff', 0)) / 500000 / 1e8,
                'aum':    parse_num(d.get('nav', 0)) / 1e8,
                'is_estimate': pcf_date_obj > today_tw,
            }
        except Exception:
            continue
    return None


def fetch_all_peer_data(transaction_date: date, etfs: list | None = None) -> list:
    """Fetch net subscription data for all peer ETFs on the given date.

    etfs=None → 全部 PEER_ETFS（每日排程用）。回補只針對某幾檔時傳子集進來，
    否則加一組新觀測群就得把整個觀測群重抓一遍（見 backfill 的 ONLY_TICKERS）。
    """
    etfs = etfs if etfs is not None else PEER_ETFS
    # Build shared ezmoney session once for all ezmoney ETFs
    ezmoney_etfs = [e for e in etfs if e['source'] == 'ezmoney']
    ezmoney_session = None
    if ezmoney_etfs:
        try:
            ezmoney_session = _get_ezmoney_session(ezmoney_etfs[0]['key'])
        except Exception as e:
            print(f'  ezmoney session error: {e}')

    results = []
    for etf in etfs:
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
        elif etf['source'] == 'jpmorgan':
            data = fetch_jpmorgan_day(etf['key'], transaction_date)
        elif etf['source'] == 'fhtrust':
            data = fetch_fhtrust_day(etf['key'], transaction_date)
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

# 三則通知各自推 Pushover（手機通知一則一件事比較合理），但 email 合併成一封寄出——
# 同一分鐘收到三封機器人信太吵。各段先進 buffer，main() 收尾時再一次寄。
_EMAIL_SECTIONS: list = []


def queue_email_section(title: str, message: str, image_bytes: bytes | None = None):
    """把一則通知排進當日的 email 摘要（不立刻寄）。"""
    _EMAIL_SECTIONS.append({'title': title, 'message': message, 'image': image_bytes})


def send_email_digest(subject: str, sections: list) -> bool:
    """把多段通知寄成一封 email。未設定 Gmail/收件者就靜默略過，回 False。

    各段 message 沿用 Pushover 的格式（`html=1`，含 <b> 之類的標籤、以 \n 斷行），
    換行轉 <br> 後直接當 HTML；截圖以 CID 內嵌（每段一個獨立 cid），
    另附純文字 part 當退路。
    """
    recipients = [a.strip() for a in REPORT_EMAIL_TO.split(',') if a.strip()]
    if not (GMAIL_USER and GMAIL_APP_PASSWORD and recipients and sections):
        return False
    try:
        import smtplib, ssl
        from email.message import EmailMessage

        msg = EmailMessage()
        msg['Subject'] = subject
        msg['From'] = f'復華主動式ETF 每日摘要 <{GMAIL_USER}>'
        msg['To'] = ', '.join(recipients)

        plain, html = [], []
        for i, sec in enumerate(sections):
            plain.append(f'{sec["title"]}\n{re.sub(r"<[^>]+>", "", sec["message"])}')
            img = f'<p><img src="cid:report{i}" style="max-width:100%;"></p>' if sec.get('image') else ''
            html.append(
                f'<h2 style="font-size:16px;border-left:4px solid #C00000;padding-left:10px;'
                f'margin:28px 0 10px;">{sec["title"]}</h2>'
                f'<div style="font-size:14px;line-height:1.8;">{sec["message"].replace(chr(10), "<br>")}</div>'
                f'{img}'
            )
        msg.set_content('\n\n────────────\n\n'.join(plain))
        msg.add_alternative(
            '<html><body style="font-family:\'Noto Sans TC\',\'Segoe UI\',Arial,sans-serif;color:#1C1C1E;">'
            + '<hr style="border:none;border-top:1px solid #E8E3DF;margin:24px 0;">'.join(html)
            + '</body></html>',
            subtype='html',
        )
        # add_related 要掛在 html 那個 part 上，否則 cid 參照不到、收信是空框
        html_part = msg.get_payload()[-1]
        for i, sec in enumerate(sections):
            if sec.get('image'):
                html_part.add_related(sec['image'], maintype='image', subtype='png',
                                      cid=f'<report{i}>', filename=f'section{i}.png')

        with smtplib.SMTP_SSL('smtp.gmail.com', 465, context=ssl.create_default_context(), timeout=60) as smtp:
            smtp.login(GMAIL_USER, GMAIL_APP_PASSWORD)
            smtp.send_message(msg)
        print(f'  ✓ Email sent: {subject}（{len(sections)} 段）→ {", ".join(recipients)}')
        return True
    except Exception as e:
        # email 失敗絕不能影響主流程（Pushover 早就個別送出去了）
        print(f'  email send error: {e}')
        # 534 5.7.9 = 拿一般登入密碼去登入開了兩階段驗證的帳號；535 5.7.8 = 應用程式密碼本身錯。
        if '5.7.9' in str(e) or 'Application-specific password' in str(e):
            print('  ↳ GMAIL_APP_PASSWORD 目前不是「應用程式密碼」。請到 '
                  'https://myaccount.google.com/apppasswords 產生 16 碼密碼後重設此 secret。')
        elif '5.7.8' in str(e):
            print('  ↳ 應用程式密碼被拒絕（可能已撤銷或打錯），請重新產生一組。')
        return False


def flush_email_digest(today: date) -> bool:
    """把本輪累積的通知寄成一封 email；沒有任何段落就跳過。"""
    if not _EMAIL_SECTIONS:
        return False
    warn = any(sec['title'].lstrip().startswith('⚠️') for sec in _EMAIL_SECTIONS)
    subject = f'{"⚠️ " if warn else ""}復華主動式ETF 每日摘要 {today:%m/%d}'
    ok = send_email_digest(subject, list(_EMAIL_SECTIONS))
    _EMAIL_SECTIONS.clear()
    return ok


def notify(title: str, message: str, image_bytes: bytes | None = None, priority: int = 0):
    """Pushover 立刻送出（主通道）；email 那份先排進摘要，等 main() 收尾一次寄。"""
    if image_bytes is not None:
        send_pushover(title, message, image_bytes, priority)
    else:
        send_pushover_text(title, message, priority)
    queue_email_section(title, message, image_bytes)


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
    stale, expected = is_stale(reported_date, today, etf.get('holdingsLag', 0))
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
    # expected 已經把該檔的 holdingsLag 算進去了，所以是「這檔應該要有的資料日」，
    # 不是「最新交易日」——海外檔兩者本來就差一天。
    stale_note = f'\n⚠️ 官網尚未更新，此為 {reported_date} 資料（應更新到 {expected}）' if stale else ''
    notify(
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
                'is_estimate': bool(etf['data'].get('is_estimate', False)),
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
        notify(
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
    notify(
        title       = f'{"⚠️ " if stale else ""}同業申贖觀測 {base_date}',
        # 熱門ETF（被動式）只入庫給網站分頁看，不進這封推播——它是「同業」觀測，
        # 混進 0050/0056 這種被動大型 ETF 會讓訊息長度翻倍又改變語意。
        message     = '淨申贖：' + '　'.join(
            f'{e["ticker"]} {e["data"]["netSub"]:+.2f}億' if e['data'] and e['data']['netSub'] is not None else f'{e["ticker"]} —'
            for e in peer_results if e.get('group') != 'hot'
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

# source → 單日抓取器。**新增來源一定要同步登記在這裡**：漏登記不會報錯，只會在補洞／海外
# 回補時印一行「無對應抓取器」然後靜靜跳過（2026-08-23 的 fhtrust 就是這樣漏掉的）。
_SOURCE_FETCHERS = {
    'fhtrust':  fetch_fhtrust_day,
    'ezmoney':  fetch_ezmoney_day,
    'capital':  fetch_capital_day,
    'ctbc':     fetch_ctbc_day,
    'tsit':     fetch_tsit_day,
    'allianz':  fetch_allianz_day,
    'yuanta':   fetch_yuanta_day,
    'cmoney':   fetch_cmoney_day,
    'jpmorgan': fetch_jpmorgan_day,
    # 以下只有台股組在用，海外組沒有任何一檔走這幾家（行為不變，只是補齊給補洞用）
    'fubon':    fetch_fubon_day,
    'nomura':   fetch_nomura_day,
    'cathay':   fetch_cathay_day,
    'kgi':      fetch_kgi_day,
}

_OVERSEAS_FETCHERS = _SOURCE_FETCHERS


def fetch_peer_day(etf: dict, transaction_date: date, ezmoney_session=None) -> dict | None:
    """依 etf['source'] 抓單一檔、單一交易日；查無或來源未登記回 None。"""
    fetcher = _SOURCE_FETCHERS.get(etf['source'])
    if fetcher is None:
        print(f'  ⚠ {etf["ticker"]}: 無對應抓取器（{etf["source"]}），略過')
        return None
    if etf['source'] == 'ezmoney':
        return fetch_ezmoney_day(etf['key'], transaction_date, session=ezmoney_session)
    return fetcher(etf['key'], transaction_date)


def pick_latest_point(official: dict | None, estimate: dict | None) -> dict | None:
    """在「正式值」與「預估值」之間挑一筆當作最新可得。

    日期較新者勝；**同一天以正式值優先**——估計值本來就是要被正式值覆蓋的，
    元大(T+1)常常同一天兩者都拿得到，這時報估計值會是無謂的降級。
    """
    if official is None:
        return estimate
    if estimate is None:
        return official
    return estimate if estimate['date'] > official['date'] else official


def process_overseas_redemption(today: date) -> dict:
    """補海外主動式ETF 的申贖（只寫 DB，不推播）。

    回傳 {ticker: {'date','netSub','aum','is_estimate'}} —— 每檔「本輪取得的最新一筆」，
    給 process_overseas_peer_push 共用；否則推播要再打一次各家投信 API，白白多一輪請求。
    """
    print('\n[海外同業申贖：補最新已公告交易日]')
    latest: dict = {}
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

        official = None
        for d in candidates:
            if is_twse_trading_day(d) is False:   # None = TWSE 連不到，照抓
                continue
            data = fetcher(etf['key'], d)
            if data and data.get('netSub') is not None and data.get('aum') is not None:
                write_peer_to_supabase([{**etf, 'data': data}], d)
                print(f'  {etf["ticker"]} {d}: netSub={data["netSub"]:+.2f}億 aum={data["aum"]:.2f}億')
                # is_estimate 以抓取器自報的為準，不可寫死 False：fetch_fhtrust_day 用「未來的
                # pcfDate」拿到的那筆本來就還沒定案（自報 is_estimate=True），寫死會讓 DB 標
                # 估計值、推播卻不打 *，兩邊對不起來。
                official = {**data, 'date': d, 'is_estimate': bool(data.get('is_estimate'))}
                break
        else:
            print(f'  {etf["ticker"]}: 近 {OVERSEAS_LOOKBACK_WEEKDAYS} 個工作日查無已公告資料')

        # 正式值查無資料時（或即使查得到，還有更新一天的預估值時），補一筆「預估」列——
        # 用申購買回清單裡的「預估發行受益權單位數」概算，標記 is_estimate=True。
        # 不能蓋掉已經是正式值的列，只在該日期還沒有資料、或該日期原本也是估計值時才寫入。
        est_point = None
        est_fetcher = _OVERSEAS_ESTIMATE_FETCHERS.get(etf['source'])
        if est_fetcher:
            est = est_fetcher(etf['key'])
            if est and est.get('netSub') is not None and est.get('aum') is not None:
                est_point = est
                existing = _fetch_existing_peer_row(str(est['date']), etf['ticker'])
                if existing is None or existing.get('is_estimate'):
                    write_peer_to_supabase([{**etf, 'data': est}], est['date'])
                    print(f'  {etf["ticker"]} {est["date"]} (預估): netSub={est["netSub"]:+.2f}億 aum={est["aum"]:.2f}億')

        best = pick_latest_point(official, est_point)
        if best:
            latest[etf['ticker']] = best
    return latest


def _fetch_existing_peer_row(date_str: str, ticker: str) -> dict | None:
    """讀單一 (date,ticker) 列的 is_estimate 狀態；查不到或 Supabase 未設定回 None。"""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        return None
    try:
        from supabase import create_client
        client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        res = (client.table('peer_redemption').select('is_estimate')
               .eq('date', date_str).eq('ticker', ticker).limit(1).execute())
        return res.data[0] if res.data else None
    except Exception as e:
        print(f'  讀取既有列失敗 {ticker} {date_str}: {e}')
        return None


ESTIMATE_CONFIRM_LOOKBACK_DAYS = 21   # 日曆天，寬鬆涵蓋連假；只挑目前還標 is_estimate 的列覆核


def process_overseas_estimate_confirm(today: date) -> int:
    """把還標 is_estimate=true 的列，重試正式來源；正式值出來就覆蓋掉估計值
    （upsert 以 (date,ticker) 為主鍵，天然冪等）。"""
    print('\n[海外同業申贖：估計值 → 正式值 覆核]')
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        print('  Supabase credentials not set, skipping.')
        return 0
    try:
        from supabase import create_client
        client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        start = today - timedelta(days=ESTIMATE_CONFIRM_LOOKBACK_DAYS)
        res = (client.table('peer_redemption').select('date, ticker')
               .eq('is_estimate', True).gte('date', str(start)).execute())
        pending = res.data or []
    except Exception as e:
        print(f'  讀取待覆核列表失敗（{e}），略過')
        return 0
    if not pending:
        print('  目前沒有待覆核的估計值。')
        return 0

    by_ticker: dict = {}
    for row in pending:
        by_ticker.setdefault(row['ticker'], []).append(row['date'])

    confirmed = 0
    for etf in PEER_ETFS:
        dates = by_ticker.get(etf['ticker'])
        if not dates:
            continue
        fetcher = _OVERSEAS_FETCHERS.get(etf['source'])
        if fetcher is None:
            continue
        for d_str in dates:
            d = date.fromisoformat(d_str)
            data = fetcher(etf['key'], d)
            if data and data.get('netSub') is not None and data.get('aum') is not None:
                # 抓回來的仍是估計值（fhtrust 用未來 pcfDate 拿到的那種）就不能算覆核成功——
                # 寫成正式值會讓它從此離開待覆核名單，永久留著一個沒定案的數字。
                if data.get('is_estimate'):
                    continue
                write_peer_to_supabase([{**etf, 'data': {**data, 'is_estimate': False}}], d)
                print(f'  {etf["ticker"]} {d}: 估計值 → 正式值 netSub={data["netSub"]:+.2f}億')
                confirmed += 1
    if not confirmed:
        print(f'  {len(pending)} 筆估計值仍未有正式值公告。')
    return confirmed


# ── 第三張表：海外主動式ETF 申購買回（Pushover）─────────────────────────────
# ⚠️ 海外檔沒有「今天的今天」可抓：以統一 00411A 實測，今天(公告日)掛出來的清單裡，
#    正式值 TranDate 是 T-2、預估值 ValueDate 是 T-1，T 日本身要等明天才會以預估值出現。
#    所以這張表一律以「每檔各自最新可得的那一天」為準，並把資料日印在表上；
#    預估值標 *，等正式值公告後 process_overseas_estimate_confirm 會覆蓋 DB。
# 依投信分群、同一家排在一起（復華 → 統一 → 元大），復華自家固定最前、00409A 置頂。
# 不用規模排序：同一家的兩檔擺在一起才看得出該投信整體是進是出。
OVERSEAS_PUSH_TICKERS = ['00409A', '00998A', '00988A', '00411A', '00990A']


def build_overseas_peer_html(points: dict, today: date) -> str:
    """points = {ticker: {'date','netSub','aum','is_estimate'}}（process_overseas_redemption 回傳）"""
    rows_html = ''
    for tk in OVERSEAS_PUSH_TICKERS:
        etf = next((e for e in PEER_ETFS if e['ticker'] == tk), None)
        if etf is None:
            continue
        p = points.get(tk)
        if p and p.get('netSub') is not None:
            ns = p['netSub']
            color = '#C00000' if ns > 0 else '#1A6B45' if ns < 0 else '#6B6460'
            star = '<span style="color:#B08F6E;">*</span>' if p.get('is_estimate') else ''
            ns_str  = f'{"+" if ns > 0 else ""}{ns:.2f}{star}'
            aum_str = f'{p["aum"]:.2f} 億' if p.get('aum') is not None else '—'
            date_str = str(p['date'])[5:]
        else:
            ns_str, color, aum_str, date_str = '—', '#BBBBBB', '—', '—'
        rows_html += f'''
        <tr style="border-bottom:1px solid #EEE9E4;">
          <td style="padding:8px 14px;font-size:13px;color:#1C1C1E;font-weight:600;">{etf["ticker"]}</td>
          <td style="padding:8px 14px;font-size:12px;color:#6B6460;">{etf["name"]}</td>
          <td style="padding:8px 14px;text-align:center;font-family:monospace;font-size:12px;color:#6B6460;">{date_str}</td>
          <td style="padding:8px 14px;text-align:right;font-family:monospace;font-size:13px;font-weight:700;color:{color};">{ns_str}</td>
          <td style="padding:8px 14px;text-align:right;font-family:monospace;font-size:12px;color:#6B6460;">{aum_str}</td>
        </tr>'''

    return f'''<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>*{{margin:0;padding:0;box-sizing:border-box;}}body{{font-family:"Noto Sans TC","Segoe UI",Arial,sans-serif;background:#fff;padding:20px;width:560px;}}</style>
</head><body>
  <div style="border-left:4px solid #C00000;padding-left:12px;margin-bottom:16px;">
    <div style="font-size:17px;font-weight:700;color:#1C1C1E;">海外主動式ETF 申購買回</div>
    <div style="font-size:12px;color:#6B6460;margin-top:3px;">{today}　單位：億元</div>
  </div>
  <table style="width:100%;border-collapse:collapse;border:1px solid #E8E3DF;border-radius:8px;overflow:hidden;">
    <thead>
      <tr style="background:#1C1C1E;">
        <th style="padding:9px 14px;color:#fff;font-size:11px;text-align:left;">代碼</th>
        <th style="padding:9px 14px;color:#fff;font-size:11px;text-align:left;">名稱</th>
        <th style="padding:9px 14px;color:#fff;font-size:11px;text-align:center;">資料日</th>
        <th style="padding:9px 14px;color:#fff;font-size:11px;text-align:right;">淨申贖(億)</th>
        <th style="padding:9px 14px;color:#fff;font-size:11px;text-align:right;">規模</th>
      </tr>
    </thead>
    <tbody>{rows_html}</tbody>
  </table>
  <div style="margin-top:10px;font-size:11px;color:#6B6460;line-height:1.7;">
    正值=淨申購（紅）　負值=淨贖回（綠）　<span style="color:#B08F6E;">*</span>=預估值（用申購買回清單的「預估發行受益權單位數」概算，正式公告後會更新）<br>
    海外基金 PCF 為交易日 +1～+2 個交易日才公告，故資料日必然落後今天；各檔落差不同，以表上資料日為準。<br>
    生成時間：{datetime.now(TZ).strftime('%Y/%m/%d %H:%M')} TST
  </div>
</body></html>'''


async def process_overseas_peer_push(today: date, points: dict) -> bool:
    """海外主動式ETF 申購買回推播。points 由 process_overseas_redemption 回傳，不重打 API。"""
    print('\n[海外主動式ETF 申購買回：推播]')
    usable = {tk: points[tk] for tk in OVERSEAS_PUSH_TICKERS
              if points.get(tk) and points[tk].get('netSub') is not None}
    if not usable:
        print('  三檔都沒有可用資料，略過推播。')
        return False

    html = build_overseas_peer_html(points, today)
    img  = await screenshot_html(html)

    parts, dates = [], set()
    for tk in OVERSEAS_PUSH_TICKERS:
        p = points.get(tk)
        if p and p.get('netSub') is not None:
            parts.append(f'{tk} {p["netSub"]:+.2f}億{"*" if p.get("is_estimate") else ""}')
            dates.add(str(p['date']))
        else:
            parts.append(f'{tk} —')
    date_note = f'資料日 {sorted(dates)[0]}' if len(dates) == 1 else f'資料日 {sorted(dates)[0]}~{sorted(dates)[-1]}'
    est_note = '\n* = 預估值（正式值公告後會更新）' if any(p.get('is_estimate') for p in usable.values()) else ''
    notify(
        title       = f'海外主動式ETF 申購買回 {today.strftime("%m/%d")}',
        message     = f'{date_note}\n' + '　'.join(parts) + est_note,
        image_bytes = img,
    )
    return True


# ── 近期補洞 ────────────────────────────────────────────────────────────────
# process_peer_redemption 每次只寫「一個 base_date」（＝復華當下已公布持股的那一天），
# process_overseas_redemption 每檔也只寫「最近一筆已公告」的那一天。兩者都沒有回頭看的機制，
# 所以只要有一天沒寫成，那個交易日就永久留白：
#   ① 排程當天被 cancel / 失敗（實例：2026-08-19 那次 run 是 cancelled → tw_active 缺 08-19）
#   ② 復華 17:20 還沒掛出當日持股 → base_date 退回前一天（那天已寫過），隔天又前進到新的一天，
#      中間被跳過的交易日再也沒人補（實例：tw_active 缺 08-07、08-13）
#   ③ 海外檔 PCF 要 T+1～T+2 才公告，寫入當下抓不到；等公告出來時排程早就往前走了
#      （實例：overseas 缺 08-18——實測那天 21/21 檔現在全部抓得到，純粹是沒人寫）
# 所以每天補跑一次：查最近 N 個交易日在 DB 裡「缺任何一檔有來源的 ticker」的日期，只補那些。
# upsert 以 (date,ticker) 為主鍵，重寫既有列是冪等的。
GAP_REPAIR_LOOKBACK = 15   # 交易日（改成逐檔補之後成本降下來了，視窗才敢拉長）
# 單輪最多抓幾筆 (date,ticker)。補洞排在 main 最後，撐爆 job 的 timeout 會連帶讓它自己
# 永遠跑不完（2026-08-27/28 兩次 run 就是這樣被 cancel 的）→ 寧可分幾天補完。
GAP_REPAIR_MAX_FETCHES = 60


def recent_trading_days(today: date, n: int) -> list:
    """回最近 n 個交易日，升冪。

    沿用 process_overseas_redemption 的判定慣例：`is_twse_trading_day` 回 None 代表
    TWSE 連不到，這時照收（寧可多補一天，也不要因為行事曆查不到就漏掉）。
    FMTQIK 只列已收盤結算的日子，所以「今天」通常還不在裡面而被排除——沒關係，
    視窗每天往前滑，明天就會納入。guard 防 TWSE 異常時無限迴圈。
    """
    days, d, guard = [], today, 0
    while len(days) < n and guard < n * 5:
        guard += 1
        if d.weekday() < 5 and is_twse_trading_day(d) is not False:
            days.append(d)
        d -= timedelta(days=1)
    return sorted(days)


def expected_tickers_on(d: date) -> set:
    """該交易日「理應有值」的 ticker：有接通來源、且已過該檔的 since（掛牌／首見日）。

    掛牌前的新檔永遠抓不到，算進 expected 會讓每個舊日期都被判成缺漏、每天白抓一輪。
    """
    return {
        e['ticker'] for e in PEER_ETFS
        if e.get('source') and not (e.get('since') and str(d) < e['since'])
    }


def find_peer_gaps(days: list, existing: set, expected_of) -> list:
    """純函式：回傳 [(date, {缺的 ticker})]，只列真的缺東西的日期。

    days        = [date]（升冪）
    existing    = {(date_str, ticker)} 已在 DB 的列
    expected_of = date -> {ticker}（見 expected_tickers_on；測試可直接餵 lambda）
    """
    gaps = []
    for d in days:
        have    = {t for (ds, t) in existing if ds == str(d)}
        missing = expected_of(d) - have
        if missing:
            gaps.append((d, missing))
    return gaps


def _fetch_existing_peer_keys(start: date, end: date):
    """讀 DB 已有的 (date,ticker)。Supabase 不可用回 None（呼叫端就整個跳過補洞）。"""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        print('  Supabase credentials not set, skipping gap repair.')
        return None
    try:
        from supabase import create_client
        client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        res = (client.table('peer_redemption')
               .select('date, ticker')
               .gte('date', str(start)).lte('date', str(end))
               .execute())
        return {(r['date'], r['ticker']) for r in res.data}
    except Exception as e:
        print(f'  gap repair: 讀取 Supabase 失敗（{e}），跳過')
        return None


def process_peer_gap_repair(today: date) -> int:
    """補最近 GAP_REPAIR_LOOKBACK 個交易日的缺漏（只寫 DB、不推播）。回傳補起來的天數。

    只抓「那天真的缺的那幾檔」——舊版對每個缺漏日都重跑一次 fetch_all_peer_data(23 檔)，
    通常只為了補 1～2 檔，一天的補洞就要 20 秒以上，是把 job 撐過 timeout 的主因。
    """
    print(f'\n[同業申贖：近 {GAP_REPAIR_LOOKBACK} 個交易日補洞]')
    days = recent_trading_days(today, GAP_REPAIR_LOOKBACK)
    existing = _fetch_existing_peer_keys(days[0], days[-1])
    if existing is None:
        return 0
    gaps = find_peer_gaps(days, existing, expected_tickers_on)
    if not gaps:
        print('  近期無缺漏。')
        return 0
    # 最新的那一兩天本來就會缺（海外檔 T+1～T+2 才公告），這是預期內、隔天會自己補上。
    total = sum(len(m) for _, m in gaps)
    print(f'  待補 {len(gaps)} 天 / {total} 筆：'
          + '，'.join(f'{d}({len(m)})' for d, m in gaps))

    by_ticker       = {e['ticker']: e for e in PEER_ETFS}
    ezmoney_session = None
    budget          = GAP_REPAIR_MAX_FETCHES
    repaired        = 0
    # 新的日期先補：舊洞多半是來源真的沒有資料，不該擋住今天剛公告的那筆。
    for d, missing in sorted(gaps, key=lambda g: g[0], reverse=True):
        if budget <= 0:
            break
        rows = []
        for ticker in sorted(missing):
            if budget <= 0:
                break
            etf = by_ticker.get(ticker)
            if etf is None:
                continue
            if etf['source'] == 'ezmoney' and ezmoney_session is None:
                try:
                    ezmoney_session = _get_ezmoney_session(etf['key'])
                except Exception as e:
                    print(f'  ezmoney session error: {e}')
            budget -= 1
            try:
                data = fetch_peer_day(etf, d, ezmoney_session)
            except Exception as e:
                print(f'  {d} {ticker}: 抓取失敗 {e}')
                continue
            if data and data.get('netSub') is not None and data.get('aum') is not None:
                rows.append({**etf, 'data': data})
        if rows:
            write_peer_to_supabase(rows, d)
            print(f'  {d}: 補上 '
                  + '　'.join(f'{r["ticker"]} {r["data"]["netSub"]:+.2f}億' for r in rows))
            repaired += 1
        else:
            print(f'  {d}: 尚無新資料可補（海外檔可能還沒公告）')
    if budget <= 0:
        print(f'  ⚠ 已用滿本輪 {GAP_REPAIR_MAX_FETCHES} 筆抓取上限，剩下的留給下一輪'
              f'（視窗每天往前滑，補得完）')
    return repaired


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
        flush_email_digest(test_date)
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

    # 先試著把還沒公告的估計值覆核成正式值，再抓當天的最新資料（含新的估計值）。
    try:
        process_overseas_estimate_confirm(today)
    except Exception as e:
        print(f'  Overseas estimate confirm ERROR: {e}')
        import traceback; traceback.print_exc()

    # 海外檔的公告落後當天，必須另外補（本身不推播，只寫 DB 給網頁分頁用）。
    overseas_latest: dict = {}
    try:
        overseas_latest = process_overseas_redemption(today)
    except Exception as e:
        print(f'  Overseas redemption ERROR: {e}')
        import traceback; traceback.print_exc()

    # 第三張表：海外主動式ETF 申購買回（見 OVERSEAS_PUSH_TICKERS）。直接用上一步的結果，不重打 API。
    try:
        sent_any = bool(await process_overseas_peer_push(today, overseas_latest)) or sent_any
    except Exception as e:
        print(f'  Overseas peer push ERROR: {e}')
        import traceback; traceback.print_exc()

    # 近期補洞：排程被 cancel、官網延遲公布、海外檔 T+1~T+2 公告，都會讓某個交易日永久留白。
    # 獨立於 sent_any（不推播），失敗也不影響上面的告警邏輯。
    try:
        process_peer_gap_repair(today)
    except Exception as e:
        print(f'  Peer gap repair ERROR: {e}')
        import traceback; traceback.print_exc()

    if not sent_any:
        # Every section produced nothing (e.g. all data sources unreachable). Don't let
        # this be a silent green build — alert, and exit non-zero so the run shows red.
        notify(
            '⚠️ 每日摘要無資料',
            f'{today} 排程已執行但未取得任何資料（資料源可能暫時無法連線）。'
            f'可至 GitHub Actions 手動重新觸發 daily_summary。',
            priority=1,
        )

    # 收尾：把本輪所有通知合併成一封 email 寄出（Pushover 早已個別送達，這裡失敗不影響）。
    try:
        flush_email_digest(today)
    except Exception as e:
        print(f'  Email digest ERROR: {e}')
        import traceback; traceback.print_exc()

    if not sent_any:
        sys.exit('No data produced this run — see logs above.')


if __name__ == '__main__':
    asyncio.run(main())
