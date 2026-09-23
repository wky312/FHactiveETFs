#!/usr/bin/env python3
"""
每日持股存檔（git 當資料庫）。
對每檔主動式 ETF，把復華每日持股抓下來、精簡後存成 data/holdings/{fundId}.json。

- idempotent：已存在的日期跳過；空檔＝從 FLOOR 全回補，有檔＝只補「最後存檔日之後」的新日期。
- 僅依賴 requests；GitHub Actions 收盤後跑，產出由 workflow commit（不部署）。
"""

import json
import os
import sys
import time
from datetime import date, timedelta

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
# 落後元大官網 2-3 個交易日（2026-09-22 實測：CMoney 停 09/18、元大官網/API 已到 09/21；同期
# 比對過 00988A/00411A 的統一投信官網 ezmoney.com.tw，資料跟 CMoney 完全一致停在 09/18，是統一
# 投信自己揭露就慢、沒有更新來源可補，所以這份清單只有元大一檔）。收在 CMoney 更新之後跑，
# 官方資料覆蓋 CMoney 的同日舊值。
YUANTA_FUNDS = {
    '00990A': '00990A',  # fundId 與 ticker 相同
}
YUANTA_API = 'https://etfapi.yuantaetfs.com/ectranslation/api/bridge'


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
    print(f'完成，共新增 {total} 天')


if __name__ == '__main__':
    main()
