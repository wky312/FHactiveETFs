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
    """Return dates that already have all 5 tickers stored."""
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
        # 只把「有接通爬蟲」的 ticker 算進完成度；尚未接通申贖來源的 ETF
        # 永遠不會有資料，否則該日永遠標不成完成、被無限重抓。
        expected = {e['ticker'] for e in PEER_ETFS if e.get('source')}
        counts = defaultdict(set)
        for row in result.data:
            counts[row['date']].add(row['ticker'])
        return {d for d, tickers in counts.items() if tickers >= expected}
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
