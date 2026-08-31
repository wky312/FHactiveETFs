#!/usr/bin/env python3
"""回補受益人數歷史（TDCC 查詢頁，最近 51 週）。

每週增量走開放資料 CSV（beneficiary_fetch.main），這支只在「要歷史」時手動跑。
TDCC 只保存一年 → 再往前沒有任何來源，過了就永遠拿不到，所以第一次要盡早跑滿。

冪等：DB 裡已經有合計列的 (date, ticker) 直接跳過，中斷後重跑只補沒補到的。

環境變數：
  TICKERS    逗號分隔，只回補這些檔（分批用）。預設全部台股主動式 ETF。
  MAX_WEEKS  只回補最近 N 週。預設全部可查週次。
  SLEEP      每次查詢間隔秒數，預設 0.4（對 TDCC 客氣一點）。
"""

import os
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(__file__))
from beneficiary_fetch import (  # noqa: E402
    TW_ACTIVE_TICKERS, available_weeks, fetch_history_week,
    stored_pairs, total_row, write_to_supabase,
)


def main():
    if not os.environ.get('SUPABASE_URL') or not os.environ.get('SUPABASE_SERVICE_KEY'):
        sys.exit('ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.')

    raw = os.environ.get('TICKERS', '').strip()
    tickers = [t.strip().upper() for t in raw.split(',') if t.strip()] or list(TW_ACTIVE_TICKERS)
    sleep = float(os.environ.get('SLEEP', '0.4'))

    session = requests.Session()
    weeks = available_weeks(session)
    max_weeks = os.environ.get('MAX_WEEKS', '').strip()
    if max_weeks:
        weeks = weeks[:int(max_weeks)]
    if not weeks:
        sys.exit('ERROR: 查詢頁沒有列出任何可查日期，版面可能改了')
    print(f'可查週次 {len(weeks)} 週（{weeks[-1]} ~ {weeks[0]}），標的 {len(tickers)} 檔')

    done = stored_pairs(tickers)
    print(f'DB 已有 {len(done)} 個 (週, 檔) 組合，將跳過')

    pending = [(w, t) for w in weeks for t in tickers
               if (f'{w[:4]}-{w[4:6]}-{w[6:]}', t) not in done]
    print(f'待抓 {len(pending)} 組\n')

    written = empty = failed = 0
    buf = []
    for i, (week, ticker) in enumerate(pending, start=1):
        try:
            rows = fetch_history_week(ticker, week, session)
        except Exception as e:
            failed += 1
            print(f'  [{i}/{len(pending)}] {ticker} {week} 失敗：{e}')
            time.sleep(sleep)
            continue
        if not rows or total_row(rows) is None:
            # 掛牌前的週次就是這樣，屬正常；但「沒帶 token 的空表單頁」也長這樣，
            # 所以整批都空要當成故障（見結尾的健檢）。
            empty += 1
        else:
            buf.extend(rows)
            if i % 20 == 0 or len(buf) >= 800:
                written += write_to_supabase(buf)
                buf = []
        if i % 50 == 0:
            print(f'  進度 {i}/{len(pending)}（寫入 {written} 列、無資料 {empty}、失敗 {failed}）')
        time.sleep(sleep)

    written += write_to_supabase(buf)
    print(f'\n完成：寫入 {written} 列、無資料 {empty} 組、失敗 {failed} 組')

    if pending and written == 0:
        sys.exit('ERROR: 一列都沒寫進去——多半是 CSRF 串接壞了（查詢頁改版），不是真的沒資料')


if __name__ == '__main__':
    main()
