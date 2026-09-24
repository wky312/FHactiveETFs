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
            if not sid or weight <= 0:
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
    last = max((api_to_date(k) for k in data['days']), default=FLOOR)
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


def main():
    total = 0
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
    print(f'完成，共新增 {total} 天')


if __name__ == '__main__':
    main()
