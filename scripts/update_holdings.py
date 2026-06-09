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

# 對應 lib/etfList.ts（00991A→ETF23、00998A→ETF24）
FUND_IDS = ['ETF23', 'ETF24']

# 主動式 ETF 最早約 2025-05 上市，全回補的掃描下限（成立前的日期會回 null、自動跳過）
FLOOR = date(2025, 5, 1)

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
        start = FLOOR

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


def main():
    total = 0
    for fund_id in FUND_IDS:
        print(f'== {fund_id} ==')
        total += update_fund(fund_id)
    print(f'完成，共新增 {total} 天')


if __name__ == '__main__':
    main()
