#!/usr/bin/env python3
"""
Backfill unit_watch data into Supabase.
Fetches every trading day from each product's listing date (or START_DATE override) to today,
skipping dates already stored. Triggered manually via GitHub Actions or run locally with env vars set.
"""

import os
import sys
import time
from datetime import date, timedelta, datetime

sys.path.insert(0, os.path.dirname(__file__))
from daily_summary import (
    fetch_units,
    write_unit_watch_to_supabase,
    UNIT_WATCH_PRODUCTS,
)

SUPABASE_URL         = os.environ.get('SUPABASE_URL', '')
SUPABASE_SERVICE_KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')


def _parse_date(raw: str) -> date:
    return datetime.strptime(raw.replace('/', '-'), '%Y-%m-%d').date()


def trading_days(start: date, end: date):
    d = start
    while d <= end:
        if d.weekday() < 5:
            yield d
        d += timedelta(days=1)


def get_stored_dates(ticker: str, start: date, end: date) -> set:
    try:
        from supabase import create_client
        client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        result = (
            client.table('unit_watch')
            .select('date')
            .eq('ticker', ticker)
            .gte('date', str(start))
            .lte('date', str(end))
            .execute()
        )
        return {row['date'] for row in result.data}
    except Exception as e:
        print(f'Warning: could not query existing dates for {ticker} ({e}), will fetch all.')
        return set()


def main():
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        sys.exit('ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.')

    override_start = os.environ.get('START_DATE', '').strip()
    end = date.today()

    for product in UNIT_WATCH_PRODUCTS:
        ticker = product['ticker']
        start = _parse_date(override_start) if override_start else product['listing_date']
        print(f'\n=== {ticker} ({product["fundId"]}) : {start} → {end} ===')

        all_days = list(trading_days(start, end))
        stored   = get_stored_dates(ticker, start, end)
        to_fetch = [d for d in all_days if str(d) not in stored]
        print(f'Days: {len(all_days)}  Stored: {len(stored)}  To fetch: {len(to_fetch)}')

        if not to_fetch:
            print('All data already stored — nothing to do.')
            continue

        ok, skip = 0, 0
        for i, d in enumerate(to_fetch, 1):
            print(f'[{i:>3}/{len(to_fetch)}] {d} … ', end='', flush=True)
            units = fetch_units(d, product['fundId'])
            if units is not None:
                write_unit_watch_to_supabase([{'date': d, 'ticker': ticker, 'units': units}])
                print(f'✓ {units:,.0f}')
                ok += 1
            else:
                print('—  no data (holiday or API unavailable)')
                skip += 1
            if i < len(to_fetch):
                time.sleep(0.5)

        print(f'{ticker} done. Stored: {ok}  Skipped: {skip}')


if __name__ == '__main__':
    main()
