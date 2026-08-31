#!/usr/bin/env python3
"""
Backfill peer redemption data into Supabase.
Fetches all trading days from START_DATE to today, skipping dates already complete.
Triggered manually via GitHub Actions or run locally with env vars set.
"""

import os
import sys
import time
from datetime import date, timedelta
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from daily_summary import (
    fetch_all_peer_data,
    write_peer_to_supabase,
    expected_tickers_on,
    PEER_ETFS,
)

SUPABASE_URL         = os.environ.get('SUPABASE_URL', '')
SUPABASE_SERVICE_KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')


def _parse_start_date() -> date:
    """START_DATE env (YYYY-MM-DD or YYYY/MM/DD) overrides the default 2025-12-08."""
    raw = os.environ.get('START_DATE', '').strip()
    if raw:
        from datetime import datetime
        return datetime.strptime(raw.replace('/', '-'), '%Y-%m-%d').date()
    return date(2025, 12, 8)


START_DATE = _parse_start_date()


def trading_days(start: date, end: date):
    d = start
    while d <= end:
        if d.weekday() < 5:
            yield d
        d += timedelta(days=1)


def get_complete_dates(start: date, end: date) -> set:
    """Return dates that already have all 5 tickers stored.

    IGNORE_COMPLETE=1 → 一律回空集合，把區間內每個交易日都重抓一次。
    用在「某檔的資料來源換掉」時：既有列本身是完整的，完成度判斷會直接跳過，
    舊的錯誤數字就永遠留在 DB（例：00998A 從 CMoney 推算改吃復華官方 PCF，
    CMoney 那批不只有取整噪音，整條序列還錯位 2 個交易日）。upsert 以
    (date,ticker) 為主鍵，重抓純粹是覆寫，冪等。
    """
    if os.environ.get('IGNORE_COMPLETE', '').strip() in ('1', 'true', 'True'):
        print('IGNORE_COMPLETE=1 → 略過完成度判斷，區間內全部重抓覆寫。')
        return set()
    try:
        from supabase import create_client
        client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        result = (
            client.table('peer_redemption')
            .select('date, ticker')
            .gte('date', str(start))
            .lte('date', str(end))
            .execute()
        )
        # 只把「有接通爬蟲、且該日已經存在」的 ticker 算進完成度：
        # ① 尚未接通申贖來源的 ETF 永遠不會有資料 → 算進去會讓該日永遠標不成完成、被無限重抓；
        # ② 新掛牌的檔（如 00411A）掛牌前一樣抓不到 → expected_tickers_on 用 since 逐日排除，
        #    否則加一檔新 ETF 就會讓歷史上每一天都退回未完成、整段重抓一遍。
        counts = defaultdict(set)
        for row in result.data:
            counts[row['date']].add(row['ticker'])
        return {
            d for d, tickers in counts.items()
            if expected_tickers_on(date.fromisoformat(d)) <= tickers
        }
    except Exception as e:
        print(f'Warning: could not query existing dates ({e}), will fetch all.')
        return set()


def main():
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        sys.exit('ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.')

    end = date.today()
    all_days   = list(trading_days(START_DATE, end))
    print(f'Range : {START_DATE} → {end}')
    print(f'Days  : {len(all_days)} trading days')

    print('Checking Supabase for existing data…')
    complete = get_complete_dates(START_DATE, end)
    to_fetch = [d for d in all_days if str(d) not in complete]
    print(f'Stored: {len(complete)}  |  To fetch: {len(to_fetch)}\n')

    if not to_fetch:
        print('All data already stored — nothing to do.')
        return

    ok_count   = 0
    skip_count = 0

    for i, d in enumerate(to_fetch, 1):
        print(f'[{i:>3}/{len(to_fetch)}] {d} … ', end='', flush=True)
        try:
            peer_results = fetch_all_peer_data(d)
            valid = [
                e for e in peer_results
                if e.get('data')
                and e['data'].get('netSub') is not None
                and e['data'].get('aum')    is not None
            ]
            if valid:
                write_peer_to_supabase(peer_results, d)
                print(f'✓  {len(valid)}/{len(peer_results)} ETFs stored')
                ok_count += 1
            else:
                print('—  no valid data (holiday or API unavailable)')
                skip_count += 1
        except Exception as e:
            print(f'✗  ERROR: {e}')
            skip_count += 1

        if i < len(to_fetch):
            time.sleep(1)

    print(f'\nDone.  Stored: {ok_count}  Skipped/failed: {skip_count}')


if __name__ == '__main__':
    main()
