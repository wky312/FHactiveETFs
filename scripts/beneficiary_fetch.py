#!/usr/bin/env python3
"""TDCC 受益人數（集保股權分散表）抓取與解析。

兩條路，用途不同：

- `fetch_opendata_week()`：開放資料 CSV，**一次回全市場**所有標的的完整 15 級距，
  但只有最新一週 → 每週增量就靠這條，不管追蹤幾檔都只打 1 次。
- `fetch_history_week()`：查詢頁，可回補**最近 51 週**（TDCC 只留一年），
  但一次一檔一週，且要先 GET 拿 cookie + SYNCHRONIZER_TOKEN → 只在回補時用。

⚠️ 查詢頁不帶 CSRF token 會回 HTTP 200 的「空表單頁」，不是錯誤碼。解析器對這種輸入
回空 list（見 test_beneficiary.py），呼叫端必須把「空」當成失敗而不是「本週無資料」。

解析函式（parse_tdcc_html / parse_opendata_csv / total_row）皆為純函式、零網路。
"""

import csv
import html as html_mod
import io
import os
import re
import time
from typing import Iterable, Optional

import requests

TDCC_QUERY_URL = 'https://www.tdcc.com.tw/portal/zh/smWeb/qryStock'
TDCC_OPENDATA_URL = 'https://smart.tdcc.com.tw/opendata/getOD.ashx?id=1-5'
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0 Safari/537.36')

# 台股主動式 ETF（來源：共用 Supabase `etf` 表，扣掉 0050）。
TW_ACTIVE_TICKERS = [
    '00980A', '00981A', '00982A', '00984A', '00985A', '00987A', '00991A',
    '00992A', '00993A', '00994A', '00995A', '00996A', '00999A',
    '00400A', '00401A', '00403A', '00404A', '00405A', '00406A', '00407A', '00408A',
]
# 海外主動式 ETF（來源：lib/peerGroups.ts overseas 非 benchmark）。
# 每週 CSV 順手一起存（零成本），但不做歷史回補。
OVERSEAS_TICKERS = [
    '00983A', '00986A', '00988A', '00989A', '00990A',
    '00997A', '00998A', '00402A', '00409A', '00411A',
]
TRACKED_TICKERS = TW_ACTIVE_TICKERS + OVERSEAS_TICKERS

# 查詢頁的級距標籤 → level 1..15。順序固定，TDCC 十幾年沒改過。
LEVEL_LABELS = [
    '1-999', '1,000-5,000', '5,001-10,000', '10,001-15,000', '15,001-20,000',
    '20,001-30,000', '30,001-40,000', '40,001-50,000', '50,001-100,000',
    '100,001-200,000', '200,001-400,000', '400,001-600,000', '600,001-800,000',
    '800,001-1,000,000', '1,000,001以上',
]
LEVEL_ADJUSTMENT = 16   # 差異數調整（只有單位數、沒有人數；某些週不出現）
LEVEL_TOTAL = 17        # 合計

# 前端畫「結構變化」用的聚合分組。1 張 = 1,000 受益權單位。
LEVEL_GROUPS = [
    {'key': 'retail',  'label': '散戶',        'note': '5 張以下',      'levels': [1, 2]},
    {'key': 'small',   'label': '小額',        'note': '5–20 張',       'levels': [3, 4, 5]},
    {'key': 'medium',  'label': '中實戶',      'note': '20–100 張',     'levels': [6, 7, 8, 9]},
    {'key': 'large',   'label': '大戶',        'note': '100–400 張',    'levels': [10, 11]},
    {'key': 'xlarge',  'label': '巨戶',        'note': '400–1000 張',   'levels': [12, 13, 14]},
    {'key': 'whale',   'label': '超大戶／法人', 'note': '1000 張以上',   'levels': [15]},
]

SUPABASE_URL = os.environ.get('SUPABASE_URL', '')
SUPABASE_SERVICE_KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')


# ── 純解析 ───────────────────────────────────────────────────────────────────

def _num(raw: str) -> float:
    """'1,234' → 1234.0；'' / '-' → 0.0（差異數調整列的人數就是空字串）。"""
    s = (raw or '').replace(',', '').replace('　', '').strip()
    if not s or s == '-':
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def _cells(tr: str) -> list:
    raw = re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', tr, re.S)
    return [html_mod.unescape(re.sub(r'<[^>]+>', '', c)).replace('\xa0', ' ').strip() for c in raw]


def _label_to_level(label: str) -> Optional[int]:
    """級距標籤 → level。

    ⚠️ 不可用列的序號當 level：有「差異數調整」列時合計是第 17 列、沒有時是第 16 列，
    照序號存會讓合計在不同週落到不同 level，整條序列就歪了。
    """
    flat = label.replace('　', '').replace(' ', '')
    if flat.startswith('合'):
        return LEVEL_TOTAL
    if '差異數調整' in flat:
        return LEVEL_ADJUSTMENT
    for i, lab in enumerate(LEVEL_LABELS, start=1):
        if flat == lab.replace(' ', ''):
            return i
    return None


def parse_tdcc_html(html: str, date_iso: str, ticker: str) -> list:
    """查詢頁 HTML → rows。認不得的列（表頭、版面表格）一律忽略。"""
    rows = []
    for tr in re.findall(r'<tr[^>]*>(.*?)</tr>', html, re.S):
        c = _cells(tr)
        if len(c) < 5:
            continue
        level = _label_to_level(c[1])
        if level is None:
            continue
        rows.append({
            'date': date_iso, 'ticker': ticker, 'level': level,
            'people': int(_num(c[2])), 'units': _num(c[3]), 'pct': _num(c[4]),
        })
    return rows


def parse_opendata_csv(text: str, tickers: Iterable[str]) -> list:
    """開放資料 CSV → rows。CSV 的『持股分級』本身就是 1..17，可直接當 level。"""
    wanted = set(tickers)
    rows = []
    reader = csv.DictReader(io.StringIO(text.lstrip('﻿')))
    for r in reader:
        ticker = (r.get('證券代號') or '').strip()
        if ticker not in wanted:
            continue
        raw_date = (r.get('資料日期') or '').strip()
        if len(raw_date) != 8:
            continue
        rows.append({
            'date': f'{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:]}',
            'ticker': ticker,
            'level': int(r['持股分級']),
            'people': int(_num(r.get('人數', ''))),
            'units': _num(r.get('股數', '')),
            'pct': _num(r.get('占集保庫存數比例%', '')),
        })
    return rows


def total_row(rows: list) -> Optional[dict]:
    """取合計列。找不到就回 None——呼叫端據此判定該週資料不完整，別假裝成功。"""
    for r in rows:
        if r['level'] == LEVEL_TOTAL:
            return r
    return None


# ── 抓取 ─────────────────────────────────────────────────────────────────────

def _lax(fn, *args, **kw):
    """先驗證憑證、SSLError 才對這個唯讀公開端點退回 verify=False（同 daily_summary._get_lax）。"""
    try:
        return fn(*args, **kw)
    except requests.exceptions.SSLError:
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        kw['verify'] = False
        return fn(*args, **kw)


def fetch_opendata_week(tickers: Iterable[str] = TRACKED_TICKERS) -> list:
    """開放資料 CSV（最新一週、全市場）→ 追蹤清單的 rows。"""
    resp = _lax(requests.get, TDCC_OPENDATA_URL, headers={'User-Agent': UA}, timeout=120)
    resp.raise_for_status()
    resp.encoding = 'utf-8'
    return parse_opendata_csv(resp.text, tickers)


def _form_page(session: requests.Session) -> str:
    resp = _lax(session.get, TDCC_QUERY_URL, headers={'User-Agent': UA}, timeout=30)
    resp.raise_for_status()
    resp.encoding = 'utf-8'
    return resp.text


def available_weeks(session: Optional[requests.Session] = None) -> list:
    """查詢頁可查的資料日（新到舊，約 51 週）。"""
    session = session or requests.Session()
    opts = re.findall(r'<option[^>]*value="(\d{8})"', _form_page(session))
    return sorted(set(opts), reverse=True)


def fetch_history_week(ticker: str, yyyymmdd: str,
                       session: Optional[requests.Session] = None) -> list:
    """查詢頁單檔單週。

    ⚠️ SYNCHRONIZER_TOKEN 用過即失效 → 每次查詢都要重新 GET 一次表單頁拿新的。
    """
    session = session or requests.Session()
    page = _form_page(session)
    m = re.search(r'SYNCHRONIZER_TOKEN"\s+value="([^"]+)"', page)
    if not m:
        raise RuntimeError('TDCC 表單頁沒有 SYNCHRONIZER_TOKEN，版面可能改了')
    payload = {
        'SYNCHRONIZER_TOKEN': m.group(1),
        'SYNCHRONIZER_URI': '/portal/zh/smWeb/qryStock',
        'method': 'submit',
        'scaDate': yyyymmdd,
        'sqlMethod': 'StockNo',   # 欄位名是小寫開頭，大寫會被無聲忽略
        'stockNo': ticker,
        'stockName': '',
        'REQ_OPR': 'SELECT',
    }
    resp = _lax(session.post, TDCC_QUERY_URL, data=payload, timeout=60,
                headers={'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded',
                         'Referer': TDCC_QUERY_URL})
    resp.raise_for_status()
    resp.encoding = 'utf-8'
    date_iso = f'{yyyymmdd[:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:]}'
    return parse_tdcc_html(resp.text, date_iso, ticker)


# ── 寫入 ─────────────────────────────────────────────────────────────────────

def write_to_supabase(rows: list, chunk: int = 1000) -> int:
    """upsert 進 beneficiary_counts。

    ⚠️ 一定要帶 on_conflict='date,ticker,level'，否則既有列會讓整批以 23505 失敗
    （peer_redemption 踩過同一個坑）。
    """
    if not rows:
        return 0
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        print('  Supabase credentials not set, skipping beneficiary_counts write.')
        return 0
    from supabase import create_client
    client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    payload = [{
        'date': r['date'], 'ticker': r['ticker'], 'level': int(r['level']),
        'people': int(r['people']), 'units': float(r['units']), 'pct': float(r['pct']),
    } for r in rows]
    written = 0
    for i in range(0, len(payload), chunk):
        batch = payload[i:i + chunk]
        client.table('beneficiary_counts').upsert(batch, on_conflict='date,ticker,level').execute()
        written += len(batch)
    print(f'  ✓ Supabase: upserted {written} beneficiary_counts row(s)')
    return written


def stored_pairs(tickers: Iterable[str]) -> set:
    """DB 裡已經有合計列的 (date, ticker)，供回補跳過。"""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        return set()
    from supabase import create_client
    client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    out, step, offset = set(), 1000, 0
    while True:
        res = (client.table('beneficiary_counts')
               .select('date,ticker')
               .eq('level', LEVEL_TOTAL)
               .in_('ticker', list(tickers))
               .range(offset, offset + step - 1)
               .execute())
        batch = res.data or []
        out.update((r['date'][:10], r['ticker']) for r in batch)
        if len(batch) < step:
            return out
        offset += step


# ── 每週增量 ─────────────────────────────────────────────────────────────────

def main():
    print('[受益人數] 抓取 TDCC 開放資料（最新一週、全市場）')
    rows = fetch_opendata_week()
    if not rows:
        raise SystemExit('ERROR: 開放資料沒有任何追蹤標的的資料，可能是格式改了')
    weeks = sorted({r['date'] for r in rows})
    tickers = sorted({r['ticker'] for r in rows})
    print(f'  資料日 {weeks}，{len(tickers)} 檔、{len(rows)} 列')
    missing = sorted(set(TRACKED_TICKERS) - set(tickers))
    if missing:
        print(f'  註：{len(missing)} 檔在集保沒有資料（多半是還沒掛牌）：{", ".join(missing)}')
    for t in tickers:
        tr = total_row([r for r in rows if r['ticker'] == t])
        if tr is None:
            print(f'  ⚠ {t} 缺合計列，跳過')
            rows = [r for r in rows if r['ticker'] != t]
    write_to_supabase(rows)


if __name__ == '__main__':
    main()
