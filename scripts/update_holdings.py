#!/usr/bin/env python3
"""
每日持股存檔（git 當資料庫）。
對每檔主動式 ETF，把復華每日持股抓下來、精簡後存成 data/holdings/{fundId}.json。

- idempotent：已存在的日期跳過；空檔＝從 FLOOR 全回補，有檔＝只補「最後存檔日之後」的新日期。
- 僅依賴 requests；GitHub Actions 收盤後跑，產出由 workflow commit（不部署）。
"""

import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone

import requests

FHTRUST_ASSETS = 'https://www.fhtrust.com.tw/api/assets'
HEADERS = {'User-Agent': 'Mozilla/5.0'}

# 對應 lib/etfList.ts（00991A→ETF23、00998A→ETF24、00409A→ETF26）
# ETF26 成立 2026/08/20、掛牌 2026/09/02，掛牌前復華每日持股 detail 是空的 → fetch_day 回 None、
# 自動跳過，等官網開始公布逐檔持股就會自己接上（idempotent，不用改程式）。
FUND_IDS = ['ETF23', 'ETF24', 'ETF26']

# CMoney（pocket.tw 代理）來源：投信官網只給最新一天，CMoney 保留逐日歷史。
# fundId → CMoney AssignID（對齊 lib/cmoneyHoldings.ts 的 CMONEY_FUNDS）
CMONEY_FUNDS = {
    '00981A': '00981A',  # 主動統一台股增長（台股）
    # 海外主動式ETF（持股為外國股；復華 00998A 走 fhtrust=ETF24 不在此）
    '00983A': '00983A',  # 主動中信ARK創新
    '00986A': '00986A',  # 主動台新全球龍頭
    '00988A': '00988A',  # 主動統一全球創新
    '00411A': '00411A',  # 主動統一前沿科技（2026/08/26 掛牌）
    '00990A': '00990A',  # 主動元大AI新經濟
    '00402A': '00402A',  # 主動安聯美國科技
}

# 元大投信自家 API（同 lib/yuantaScale.ts 用的 etfapi.yuantaetfs.com）：CMoney 對 00990A 的揭露
# 落後元大官網 2-3 個交易日（2026-09-22 實測：CMoney 停 09/18、元大官網/API 已到 09/21）。
# 收在 CMoney 更新之後跑，官方資料覆蓋 CMoney 的同日舊值。
#
# 2026-09-23 更正：先前以為統一投信（00988A/00411A）官網跟 CMoney 一樣停在 09/18、沒有更新
# 來源可補——查錯了，見下方 EZMONEY_FUNDS，統一投信官網其實也有更新的逐日持股，只是查詢
# 端點 ezmoney.com.tw/ETF/Transaction/GetPCF 前面擋了防爬（單純 POST 或漏帶 fundCode 會被
# 導回原頁 HTML、狀態碼仍是 200，很容易誤判成「查了、資料跟 CMoney 一樣」）。
YUANTA_FUNDS = {
    '00990A': '00990A',  # fundId 與 ticker 相同
}
YUANTA_API = 'https://etfapi.yuantaetfs.com/ectranslation/api/bridge'

# 統一投信官網 PCF 查詢（同 lib/ezmoneyScale.ts 已驗證過、正式站在用的 cookie 流程）：
# CMoney 對 00988A/00411A 的揭露落後統一投信官網，用官網 GetPCF 補最新幾天，官方資料覆蓋
# CMoney 的同日舊值。防爬檢查需要「先 GET 首頁拿 __nxquid、再 GET 帶 fundCode 的 PCF 頁拿
# ASP.NET_SessionId」兩個 cookie 都有才會放行 POST，兩者缺一 POST 一樣回 200 但 body 是
# 原頁 HTML（不是查詢失敗，是被防爬導回，parse 時會因為抓不到 JSON 欄位而回 None 靜靜跳過，
# 不會誤植髒資料，但也不會警覺自己被擋——排查時要注意）。
#
# GetPCF 的 `date` 參數是「公告日」（通常 T+1，遇假日更晚），不是資料本身的交易日；要用回應
# 裡的 `TranDate` 才是實際持股日，兩者常常不同（比照 lib/ezmoneyScale.ts::fetchEzmoneyRange）。
EZMONEY_FUNDS = {
    '00988A': '61YTW',  # 主動統一全球創新，fundCode 是統一投信內部代號（非 ticker）
    '00411A': '64YTW',  # 主動統一前沿科技
    # 2026-10-03 補：CMoney（pocket.tw）自 2026-09-30/10-01 之間開始回
    # {"Error":{"Code":101,"Message":"Auth Failed"}}（而且 HTTP 200，所以每檔只是靜靜印「+0 天」、
    # workflow 照樣綠燈）。統一這兩檔台股的官網 GetPCF 一樣查得到逐日持股，實測可回溯到掛牌日
    # （63YTW 自 2026/05/11 共 101 天），直接改吃官網、不再依賴 CMoney。
    '00981A': '49YTW',  # 主動統一台股增長（fundCode 與申贖觀測同一個）
    '00403A': '63YTW',  # 主動統一升級50
}
EZMONEY_HOST = 'https://www.ezmoney.com.tw'
EZMONEY_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')


def _is_cash_row(sid: str, name: str) -> bool:
    """CMoney 持股夾帶的現金/操作列（C_NTD / DA_NTD / CASH …）非真實個股，排除。"""
    import re
    if re.search(r'_(NTD|USD|TWD|HKD|JPY|EUR|RMB|CNY)\d*$', sid, re.I):
        return True
    return bool(re.search(r'^(CASH|現金)$|AFTER DEDUCTING', name.strip(), re.I))
CMONEY_API = 'https://www.pocket.tw/api/cm/MobileService/ashx/GetDtnoData.ashx'
CMONEY_DTNO = '59449513'  # M722：日期/標的代號/標的名稱/權重(%)/持有數/單位

# 主動式 ETF 最早約 2025-05 上市，全回補的掃描下限（成立前的日期會回 null、自動跳過）
FLOOR = date(2025, 5, 1)

# 個別基金的回補下限（成立日）。晚成立的基金若沿用 FLOOR，每天都要空掃幾百個交易日才知道沒資料。
FUND_FLOORS = {
    'ETF26': date(2026, 8, 20),   # 00409A 復華全球未來50，成立 2026/08/20、掛牌 2026/09/02
    '00403A': date(2026, 5, 10),  # 主動統一升級50，掛牌 2026/05/12（統一官網最早回到 05/11）
}

OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'data', 'holdings')


def parse_num(v):
    if isinstance(v, (int, float)):
        return v
    return float(str(v).replace(',', '').replace('%', '') or 0)


def date_to_api(d: date) -> str:
    return d.strftime('%Y/%m/%d')


def api_to_date(s: str) -> date:
    y, m, d = s.split('/')
    return date(int(y), int(m), int(d))


def weekdays(start: date, end: date):
    cur = start
    while cur <= end:
        if cur.weekday() < 5:  # 0-4 = Mon-Fri
            yield cur
        cur += timedelta(days=1)


def fetch_day(fund_id: str, d: date):
    """回傳 (records, names_update) 或 None（非交易日/成立前/無資料）。"""
    try:
        r = requests.get(
            FHTRUST_ASSETS,
            params={'fundID': fund_id, 'qDate': date_to_api(d)},
            headers=HEADERS, timeout=20,
        )
        r.raise_for_status()
        fund = (r.json().get('result') or [None])[0]
        if not fund or not fund.get('detail'):
            return None
        records, names = [], {}
        for it in fund['detail']:
            sid = str(it.get('stockid') or '').strip()
            if not sid:
                continue
            records.append({
                'c': sid,
                'q': int(parse_num(it.get('qshare'))),
                'm': int(parse_num(it.get('mvalue'))),
                'p': round(parse_num(it.get('prate_addaccint')), 4),
            })
            names[sid] = str(it.get('stockname') or '')
        return (records, names) if records else None
    except Exception as e:
        print(f'  ! {fund_id} {date_to_api(d)} fetch error: {e}', file=sys.stderr)
        return None


def load(fund_id: str):
    path = os.path.join(OUT_DIR, f'{fund_id}.json')
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        data.setdefault('names', {})
        data.setdefault('days', {})
        return data
    return {'fundId': fund_id, 'names': {}, 'days': {}}


def save(fund_id: str, data: dict):
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f'{fund_id}.json')
    # 每天一行輸出（合法 JSON），讓每日 commit 的 git diff 只增少數行、delta 極小
    names = json.dumps(data['names'], ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    day_keys = sorted(data['days'])
    lines = ['{', f'"fundId":{json.dumps(fund_id)},', f'"names":{names},', '"days":{']
    for i, k in enumerate(day_keys):
        rec = json.dumps(data['days'][k], ensure_ascii=False, separators=(',', ':'))
        comma = ',' if i < len(day_keys) - 1 else ''
        lines.append(f'{json.dumps(k)}:{rec}{comma}')
    lines += ['}', '}']
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')


def update_fund(fund_id: str) -> int:
    data = load(fund_id)
    today = date.today()

    if data['days']:
        last = max(api_to_date(k) for k in data['days'])
        start = last + timedelta(days=1)
    else:
        start = FUND_FLOORS.get(fund_id, FLOOR)

    added = 0
    for d in weekdays(start, today):
        key = date_to_api(d)
        if key in data['days']:
            continue
        res = fetch_day(fund_id, d)
        if res:
            records, names = res
            data['days'][key] = records
            data['names'].update(names)
            added += 1
            print(f'  + {fund_id} {key}: {len(records)} holdings')
        time.sleep(0.15)  # 友善節流

    if added:
        save(fund_id, data)
    print(f'{fund_id}: +{added} 天，共 {len(data["days"])} 天')
    return added


def fetch_cmoney_days(assign_id: str, dt_range: int = 400):
    """從 CMoney 取整段逐日個股持股，回傳 (days, names)。
    days = { 'YYYY/MM/DD': [{c,q,m,p}] }、names = {sid:name}。市值 m 無資料填 0。"""
    param = (f'AssignID={assign_id};MTPeriod=0;DTMode=0;'
             f'DTRange={dt_range};DTOrder=1;MajorTable=M722;')
    params = {'action': 'getdtnodata', 'DtNo': CMONEY_DTNO, 'ParamStr': param, 'FilterNo': '0'}
    try:
        r = requests.get(CMONEY_API, params=params, headers=HEADERS, timeout=30)
    except requests.exceptions.SSLError:
        # pocket.tw 憑證缺 Subject Key Identifier，嚴格 OpenSSL 3.x 會拒；只對此唯讀公開 API 退回不驗證。
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        r = requests.get(CMONEY_API, params=params, headers=HEADERS, timeout=30, verify=False)
    r.raise_for_status()
    rows = r.json().get('Data') or []
    days, names = {}, {}
    for row in rows:
        ymd = str(row[0])
        date_key = f'{ymd[0:4]}/{ymd[4:6]}/{ymd[6:8]}'
        sid = str(row[1] or '').strip()
        name = str(row[2] or '').strip()
        if not sid or _is_cash_row(sid, name):
            continue
        days.setdefault(date_key, []).append({
            'c': sid,
            'q': int(parse_num(row[4])),       # 持有數（股）
            'm': 0,                            # CMoney 無市值
            'p': round(parse_num(row[3]), 4),  # 權重(%)
        })
        names[sid] = name
    return days, names


def update_cmoney_fund(fund_id: str, assign_id: str) -> int:
    """CMoney 一次回整段歷史 → 直接覆蓋補齊存檔（idempotent）。回傳新增天數。"""
    data = load(fund_id)
    before = len(data['days'])
    try:
        days, names = fetch_cmoney_days(assign_id)
    except Exception as e:
        print(f'  ! {fund_id} CMoney fetch error: {e}', file=sys.stderr)
        print(f'{fund_id}: +0 天（CMoney 失敗）')
        return 0
    data['days'].update(days)
    data['names'].update(names)
    added = len(data['days']) - before
    if added or days:
        save(fund_id, data)
    print(f'{fund_id}: +{added} 天，共 {len(data["days"])} 天（CMoney）')
    return added


def fetch_yuanta_days(ticker: str, since: date):
    """查 `since`（不含）之後到「今天+3」的每個交易日，回傳 (days, names)。
    `date` 查詢參數是基準日，回應的 `PCF.trandate` 才是實際資料日、常落後基準日 1 個交易日，
    所以要連未來日期一起查（同 lib/yuantaHoldings.ts::fetchYuantaHoldings 的處理）。"""
    days, names = {}, {}
    end = date.today() + timedelta(days=3)
    for d in weekdays(since + timedelta(days=1), end):
        params = {
            'APIType': 'ETFAPI', 'CompanyName': 'YUANTAFUNDS',
            'FuncId': 'PCF/Daily', 'ticker': ticker, 'date': date_to_api(d).replace('/', ''),
        }
        try:
            try:
                r = requests.get(YUANTA_API, params=params, headers=HEADERS, timeout=20)
            except requests.exceptions.SSLError:
                # etfapi.yuantaetfs.com 憑證缺 Subject Key Identifier，同 CMoney 那段處理，
                # 只對此唯讀公開端點退回不驗證。
                import urllib3
                urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
                r = requests.get(YUANTA_API, params=params, headers=HEADERS, timeout=20, verify=False)
            r.raise_for_status()
            j = r.json() or {}
        except Exception as e:
            print(f'  ! {ticker} yuanta {date_to_api(d)} fetch error: {e}', file=sys.stderr)
            continue
        pcf = j.get('PCF') or {}
        trandate = pcf.get('trandate')
        sw = ((j.get('FundWeights') or {}).get('StockWeights')) or []
        if not trandate or not sw:
            continue
        date_key = f'{str(trandate)[0:4]}/{str(trandate)[4:6]}/{str(trandate)[6:8]}'
        records = []
        for s in sw:
            sid = str(s.get('code') or '').strip()
            weight = parse_num(s.get('weights'))
            if not sid or weight <= 0:
                continue
            records.append({'c': sid, 'q': int(parse_num(s.get('qty'))), 'm': 0, 'p': round(weight, 4)})
            names[sid] = str(s.get('name') or '').strip()
        if records:
            days[date_key] = records
        time.sleep(0.15)
    return days, names


def update_yuanta_fund(fund_id: str, ticker: str) -> int:
    """用元大官網 API 補 CMoney 落後的最新幾天（見 YUANTA_FUNDS 註解）。回傳新增天數。"""
    data = load(fund_id)
    before = len(data['days'])
    last = max((api_to_date(k) for k in data['days']), default=FLOOR)
    try:
        days, names = fetch_yuanta_days(ticker, last)
    except Exception as e:
        print(f'  ! {fund_id} yuanta fetch error: {e}', file=sys.stderr)
        print(f'{fund_id}: +0 天（元大 API 失敗）')
        return 0
    data['days'].update(days)
    data['names'].update(names)
    added = len(data['days']) - before
    if days:
        save(fund_id, data)
    print(f'{fund_id}: +{added} 天，共 {len(data["days"])} 天（元大官網）')
    return added


def _net_date_to_taipei(raw) -> date | None:
    """解析 GetPCF 回應的日期欄位 → 台北日期。同一支 API 在不同次回應會混用兩種序列化格式
    （2026-09-23 實測交替出現，不是查詢參數決定的）：
      - ASP.NET JSON 格式 `/Date(ms)/`：ms 是 UTC epoch，本地已是台北 00:00 時刻，要 +8 小時
        換算才不會少算一天；負值是 .NET DateTime.MinValue 的序列化結果（查無該公告日資料）。
      - 純 ISO 字串 `2026-09-18T00:00:00`：已經是台北時間本身，直接取日期，不能再 +8 小時
        （會多算一天）。"""
    s = str(raw or '')
    m = re.search(r'/Date\((-?\d+)\)/', s)
    if m:
        ms = int(m.group(1))
        if ms < 0:
            return None
        return (datetime.fromtimestamp(ms / 1000, tz=timezone.utc) + timedelta(hours=8)).date()
    m = re.match(r'(\d{4})-(\d{2})-(\d{2})', s)
    if m:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return None


def _ezmoney_session(fund_code: str) -> requests.Session | None:
    """防爬需要的兩段式 cookie：先首頁拿 __nxquid，再帶 fundCode 的 PCF 頁拿
    ASP.NET_SessionId。缺一，後面 GetPCF 的 POST 一樣回 200，但 body 是原頁 HTML。"""
    s = requests.Session()
    s.headers.update({'User-Agent': EZMONEY_UA})
    try:
        s.get(f'{EZMONEY_HOST}/', timeout=20)
        s.get(f'{EZMONEY_HOST}/ETF/Transaction/PCF?fundCode={fund_code}', timeout=20)
        return s
    except Exception as e:
        print(f'  ! ezmoney {fund_code} session init error: {e}', file=sys.stderr)
        return None


def fetch_ezmoney_days(fund_code: str, since: date):
    """查 `since`（不含）之後到「今天+4」的每個公告日，回傳 (days, names)。
    `date` 查詢參數是公告日不是資料日，要讀回應的 TranDate 才是實際持股日（見 EZMONEY_FUNDS
    註解），同一個 TranDate 可能被好幾個公告日查詢命中（假日群聚），用 date_key 是否已存在跳過
    重複的那幾次。"""
    days: dict = {}
    names: dict = {}
    sess = _ezmoney_session(fund_code)
    if sess is None:
        return days, names

    end = date.today()
    for d in weekdays(since + timedelta(days=1), end + timedelta(days=4)):
        roc = f'{d.year - 1911}/{d.month:02d}/{d.day:02d}'
        try:
            r = sess.post(
                f'{EZMONEY_HOST}/ETF/Transaction/GetPCF',
                json={'fundCode': fund_code, 'date': roc, 'specificDate': True},
                headers={
                    'Content-Type': 'application/json; charset=utf-8',
                    'Accept': 'application/json, */*; q=0.01',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': f'{EZMONEY_HOST}/ETF/Transaction/PCF?fundCode={fund_code}',
                },
                timeout=20,
            )
            r.raise_for_status()
            j = r.json()
        except Exception as e:
            print(f'  ! {fund_code} ezmoney {roc} fetch error: {e}', file=sys.stderr)
            continue

        assets = j.get('asset') or []
        details = [row for a in assets if a.get('AssetCode') == 'ST' for row in (a.get('Details') or [])]
        if not details:
            continue
        tran_date = _net_date_to_taipei(details[0].get('TranDate'))
        if not tran_date or tran_date <= since or tran_date > end:
            continue
        date_key = date_to_api(tran_date)
        if date_key in days:
            continue

        records = []
        for row in details:
            sid = str(row.get('DetailCode') or '').strip()
            weight = parse_num(row.get('NavRate'))
            # 權重 0.00% 但仍有股數的零頭部位（1,000 股殘量）要留：軌跡看股數，濾掉會被畫成出清又買回。
            if not sid or (weight <= 0 and parse_num(row.get('Share')) <= 0):
                continue
            records.append({'c': sid, 'q': int(parse_num(row.get('Share'))), 'm': 0, 'p': round(weight, 4)})
            names[sid] = str(row.get('DetailName') or '').strip()
        if records:
            days[date_key] = records
        time.sleep(0.2)
    return days, names


def update_ezmoney_fund(fund_id: str, fund_code: str) -> int:
    """用統一投信官網 GetPCF 補 CMoney 落後的最新幾天（見 EZMONEY_FUNDS 註解）。回傳新增天數。"""
    data = load(fund_id)
    before = len(data['days'])
    # default 用 FUND_FLOORS：空檔的新基金若退回全域 FLOOR（2025-05），每天都要白掃幾百個
    # 公告日才知道掛牌前沒資料（同 update_cmoney_fund 的處理）。
    last = max((api_to_date(k) for k in data['days']), default=FUND_FLOORS.get(fund_id, FLOOR))
    try:
        days, names = fetch_ezmoney_days(fund_code, last)
    except Exception as e:
        print(f'  ! {fund_id} ezmoney fetch error: {e}', file=sys.stderr)
        print(f'{fund_id}: +0 天（統一投信官網失敗）')
        return 0
    data['days'].update(days)
    data['names'].update(names)
    added = len(data['days']) - before
    if days:
        save(fund_id, data)
    print(f'{fund_id}: +{added} 天，共 {len(data["days"])} 天（統一投信官網）')
    return added


# ── 各家投信官網持股（CMoney 的替代；scripts/issuers/ 是從 active-etf-tracker 移植的套件）──
# 2026-10-03：CMoney（pocket.tw）開始回 {"Error":{"Code":101,"Message":"Auth Failed"}} 且
# HTTP 200 —— 每檔只是靜靜印「+0 天」、workflow 照樣綠燈。改以各家投信官網為主要來源。
# ⚠ 這些 fetcher **一次只回最新一天**（簽名 fetch(ticker, date=None) -> list[Row]），所以存檔
#   是「從今天起逐日累積」，拿不回 CMoney 時代的歷史；要歷史得另外逐檔找支援日期參數的來源
#   （聯博/國泰/摩根/第一金的端點有 date 參數，其餘沒有）。
# ⚠ 名單刻意不含 00981A/00403A（走 EZMONEY_FUNDS，統一官網能回溯到掛牌日、比這裡更好）
#   與 00991A（走 fhtrust 官方、T 日下午就有）。
ISSUER_FUNDS = {
    '00400A': '國泰',   '00401A': '摩根',   '00404A': '聯博',   '00405A': '富邦',
    '00980A': '野村',   '00982A': '群益',   '00985A': '野村',   '00987A': '台新',
    '00992A': '群益',   '00994A': '第一金', '00996A': '兆豐',   '00999A': '野村',
    '00408A': '第一金',  # 2026-10-03 補：頁面 ID=183（上游只登記了 00994A=182）
    '00410A': '永豐',    # 持股就在申購買回清單頁裡（永豐沒有獨立持股頁，其他路徑全 404）
    # 2026-10-03：中信與安聯**都不需要 Playwright**（上游 active-etf-tracker 走 DOM 是因為
    # 沒試對 body 欄位：中信少帶 StartDate 會回「SqlDateTime 溢位」、安聯要用 FundID 不是 FundNo）。
    '00406A': '中信',   '00995A': '中信',
    '00984A': '安聯',   '00993A': '安聯',
    '00407A': '凱基',   # 持股在申購買回清單片段裡（⚠ 整段 HTML entity 編碼，要先 unescape）
    # 海外主動式ETF：持股是外國股（彭博式 'TSLA US'），走 sources.py 的 ticker-aware 過濾。
    # CMoney 失效後這三檔原本整個沒來源（存檔凍結在 09/29）。
    '00983A': '中信',   '00402A': '安聯',
    # 2026-10-04：00989A 摩根、00997A 群益原本只靠 CMoney（存檔從沒建過），CMoney 掛掉後連歷史都沒了；
    # 官網只給最新一天，從此開始逐日累積。
    '00989A': '摩根',   '00997A': '群益',
    '00415A': '群益',   # 2026-10-20 掛牌：群益官網 fundNo=504（與 00992A 同一支 fetcher）
    # 00986A 台新全球龍頭不在此：台新的頁面對海外檔結構不同，只解析到 4 檔/權重 12%。
}

# 官網持股「支援依日期查詢」的來源（2026-10-03 實測；其餘只回最新一天）：
#   00400A 國泰 SearchDate、00404A 聯博 ?date=、00405A 富邦 ddate — 要什麼日期就回什麼日期
#   00994A 第一金 pStrDate — **填日期反而回前一個交易日**（留空才是當日），所以不能用要求的
#          日期當 key，一律以 fetcher 自報的 date 為準（下面的回補迴圈本來就這樣做）。
# 其餘 8 檔（摩根/野村×3/群益×2/台新/兆豐）忽略日期參數、永遠回最新一天 → 無法回補。
ISSUER_DATE_CAPABLE = {'00400A', '00404A', '00405A', '00994A', '00408A', '00406A', '00995A', '00983A'}

_TWSE_CAL: dict[str, set] = {}


def twse_trading_days(year: int, month: int):
    """該月的 TWSE 交易日集合，連不到回 None。FMTQIK 只列真正開市的日子，是「那天有沒有開市」
    的權威來源（同 daily_summary._twse_trading_days）。未來日期一律不在裡面——它是盤後資料。"""
    key = f'{year}{month:02d}'
    if key in _TWSE_CAL:
        return _TWSE_CAL[key]
    try:
        r = requests.get(
            f'https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date={key}01&response=json',
            headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
        j = r.json()
        if j.get('stat') != 'OK':
            return None
        days = set()
        for row in j.get('data', []):
            roc = str(row[0]).split('/')
            days.add(date(int(roc[0]) + 1911, int(roc[1]), int(roc[2])))
        _TWSE_CAL[key] = days
        return days
    except Exception as e:
        print(f'  ! TWSE 行事曆 {key} 取得失敗: {e}', file=sys.stderr)
        return None


def update_issuer_fund(fund_id: str, label: str) -> int:
    """用投信官網抓最新一天持股並併進存檔。回傳新增天數。"""
    try:
        import issuers, issuers.sources  # noqa: F401  （import 即註冊 REGISTRY）
        fetcher = issuers.REGISTRY.get(fund_id)
    except Exception as e:
        print(f'  ! issuers 套件載入失敗: {e}', file=sys.stderr)
        return 0
    if fetcher is None:
        print(f'{fund_id}: +0 天（{label}官網無對應抓取器）')
        return 0
    # 重試兩次：野村一站掛三檔（00980A/00985A/00999A）連續請求時偶發連線失敗（實測 00999A
    # 單獨跑正常、排在第三個就斷）。上游 issuers._req 只對「憑證驗證失敗」退回重試，不處理
    # 這種暫時性錯誤 —— 不補這層，每天都可能無聲掉一檔一天。
    rows = None
    for attempt in range(3):
        try:
            rows = fetcher(fund_id)
            break
        except Exception as e:
            if attempt == 2:
                print(f'  ! {fund_id} {label}官網抓取失敗（已重試 3 次）: {e}', file=sys.stderr)
                print(f'{fund_id}: +0 天（{label}官網失敗）')
                return 0
            time.sleep(1.5 * (attempt + 1))
    if not rows:
        print(f'{fund_id}: +0 天（{label}官網回空）')
        return 0

    d = api_to_date(rows[0]['date'].replace('-', '/'))
    # ⚠ 通用防護：這些 fetcher 回的都是「最新一期」，日期不可能比今天早太多。抓到過期日期
    # 代表該站的日期解析壞了（實測台新把「次一公告日」濾掉後退回**成立日** 2025-12-30，
    # 於是今天的持股被標成去年、污染存檔）。超過 10 個日曆日就拒收並告警。
    if (date.today() - d).days > 10:
        print(f'{fund_id}: +0 天（{label}官網自報 {d} 離今天超過 10 天，疑似日期解析錯誤 → 拒收）')
        return 0
    # 非交易日一律不寫：群益/兆豐回的是「清單生效日＝下一交易日」，mk_row 已 clamp 到最近
    # 平日，但國定假日（例如中秋連假那四天）仍可能落在非交易日上 → 用 TWSE 行事曆擋掉。
    # 行事曆連不到時（回 None）照寫，不要因為「無法判斷」就漏掉一天。
    cal = twse_trading_days(d.year, d.month)
    if cal is not None and d not in cal:
        print(f'{fund_id}: +0 天（{label}官網自報 {d} 非 TWSE 交易日，略過）')
        return 0

    data = load(fund_id)
    key = date_to_api(d)
    if key in data['days']:
        print(f'{fund_id}: +0 天，共 {len(data["days"])} 天（{label}官網，{key} 已存在）')
        return 0

    records, names = [], {}
    for r in rows:
        sid = str(r.get('stockid') or '').strip()
        q = int(r.get('qshare') or 0)
        w = float(r.get('prate') or 0)
        if not sid or q <= 0:  # 權重 0 的零頭部位仍保留（見 update_ezmoney_fund）
            continue
        records.append({'c': sid, 'q': q, 'm': 0, 'p': round(w, 4)})
        names[sid] = str(r.get('stockname') or '').strip()
    if not records:
        print(f'{fund_id}: +0 天（{label}官網全列無效）')
        return 0
    # ⚠ 通用防護：權重合計過低＝解析只抓到一部分（實測台新對海外檔只 match 到 4 檔、合計
    # 12%）。主動式 ETF 幾乎滿倉，正常都在 85% 以上；低於 60% 一律拒收，不要讓半套持股
    # 進存檔（進去之後「收盤影響」的貢獻度會整檔失真，而且不會報錯）。
    total_w = sum(r['p'] for r in records)
    if total_w < 60:
        print(f'{fund_id}: +0 天（{label}官網權重合計僅 {total_w:.1f}%，疑似只解析到部分持股 → 拒收）')
        return 0

    data['days'][key] = records
    data['names'].update(names)
    save(fund_id, data)
    print(f'  + {fund_id} {key}: {len(records)} holdings（{label}官網）')
    print(f'{fund_id}: +1 天，共 {len(data["days"])} 天（{label}官網）')
    return 1


def backfill_issuer_holdings(since: date) -> int:
    """對 ISSUER_DATE_CAPABLE 的幾檔，逐日把 since→今天 的持股補進存檔。

    opt-in（env `ISSUER_BACKFILL_SINCE=YYYY-MM-DD`）而不是每天跑：每檔每個交易日一次請求，
    兩個月就幾百次，排在每日流程裡只是白耗。以 **fetcher 自報的日期** 當 key（第一金填日期
    會回前一交易日，用要求的日期當 key 會整段錯位一天）。
    """
    try:
        import issuers, issuers.sources  # noqa: F401
    except Exception as e:
        print(f'  ! issuers 套件載入失敗: {e}', file=sys.stderr)
        return 0
    end = date.today()
    total = 0
    for fund_id in sorted(ISSUER_DATE_CAPABLE):
        fetcher = issuers.REGISTRY.get(fund_id)
        if fetcher is None:
            continue
        data = load(fund_id)
        before = len(data['days'])
        for d in weekdays(since, end):
            cal = twse_trading_days(d.year, d.month)
            if cal is not None and d not in cal:
                continue
            try:
                rows = fetcher(fund_id, d.isoformat())
            except Exception:
                continue
            if not rows:
                continue
            got = api_to_date(rows[0]['date'].replace('-', '/'))
            cal2 = twse_trading_days(got.year, got.month)
            if cal2 is not None and got not in cal2:
                continue
            key = date_to_api(got)
            if key in data['days']:
                continue
            recs, names = [], {}
            for r in rows:
                sid, q, w = str(r.get('stockid') or '').strip(), int(r.get('qshare') or 0), float(r.get('prate') or 0)
                if not sid or q <= 0:  # 權重 0 的零頭部位仍保留（見 update_ezmoney_fund）
                    continue
                recs.append({'c': sid, 'q': q, 'm': 0, 'p': round(w, 4)})
                names[sid] = str(r.get('stockname') or '').strip()
            if recs:
                data['days'][key] = recs
                data['names'].update(names)
            time.sleep(0.2)
        added = len(data['days']) - before
        if added:
            save(fund_id, data)
        total += added
        print(f'{fund_id}: +{added} 天，共 {len(data["days"])} 天（官網回補 {since}→{end}）')
    return total


def main():
    total = 0
    backfill_since = os.environ.get('ISSUER_BACKFILL_SINCE', '').strip()
    if backfill_since:
        print(f'== 官網持股回補（ISSUER_BACKFILL_SINCE={backfill_since}）==')
        total += backfill_issuer_holdings(datetime.strptime(backfill_since, '%Y-%m-%d').date())
    for fund_id in FUND_IDS:
        print(f'== {fund_id} ==')
        total += update_fund(fund_id)
    for fund_id, assign_id in CMONEY_FUNDS.items():
        print(f'== {fund_id} (CMoney) ==')
        total += update_cmoney_fund(fund_id, assign_id)
    for fund_id, ticker in YUANTA_FUNDS.items():
        print(f'== {fund_id} (元大官網) ==')
        total += update_yuanta_fund(fund_id, ticker)
    for fund_id, fund_code in EZMONEY_FUNDS.items():
        print(f'== {fund_id} (統一投信官網) ==')
        total += update_ezmoney_fund(fund_id, fund_code)
    for fund_id, label in ISSUER_FUNDS.items():
        print(f'== {fund_id} ({label}官網) ==')
        total += update_issuer_fund(fund_id, label)
    print(f'完成，共新增 {total} 天')


if __name__ == '__main__':
    main()
