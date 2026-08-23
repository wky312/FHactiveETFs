"""daily_summary 純函式單元測試。零網路：is_twse_trading_day 一律 monkeypatch。

跑法：cd 00998a-web && python -m pytest scripts/test_daily_summary.py -q
"""

from datetime import date

import daily_summary as ds


def test_latest_expected_trading_day_anchor_is_trading_day(monkeypatch):
    """anchor 本身就是交易日 → 直接回傳 anchor。"""
    monkeypatch.setattr(ds, 'is_twse_trading_day', lambda d: True)
    assert ds.latest_expected_trading_day(date(2026, 8, 14)) == date(2026, 8, 14)


def test_latest_expected_trading_day_walks_back_over_weekend(monkeypatch):
    """anchor 是週一但行事曆說週一非交易日（例如颱風假）→ 應往回找到最近一個交易日。"""
    trading_days = {date(2026, 8, 14): True, date(2026, 8, 15): False, date(2026, 8, 16): False, date(2026, 8, 17): False}
    monkeypatch.setattr(ds, 'is_twse_trading_day', lambda d: trading_days[d])
    assert ds.latest_expected_trading_day(date(2026, 8, 17)) == date(2026, 8, 14)


def test_latest_expected_trading_day_none_when_twse_unreachable():
    """TWSE 連不到（回 None）→ 整體回 None，呼叫端不應誤報。"""
    def flaky(d):
        return None
    import daily_summary as ds2
    orig = ds2.is_twse_trading_day
    ds2.is_twse_trading_day = flaky
    try:
        assert ds2.latest_expected_trading_day(date(2026, 8, 17)) is None
    finally:
        ds2.is_twse_trading_day = orig


def test_latest_expected_trading_day_gives_up_after_max_back(monkeypatch):
    """一路都非交易日、超過 max_back 天仍找不到 → 回 None（不要無限迴圈或誤回舊日期）。"""
    monkeypatch.setattr(ds, 'is_twse_trading_day', lambda d: False)
    assert ds.latest_expected_trading_day(date(2026, 8, 17), max_back=3) is None


def test_is_stale_never_false_positive_when_twse_unreachable(monkeypatch):
    """TWSE 行事曆連不到（is_twse_trading_day 一律回 None）→ is_stale 回 (False, None)，不誤報。"""
    monkeypatch.setattr(ds, 'is_twse_trading_day', lambda d: None)
    assert ds.is_stale(date(2026, 8, 10), date(2026, 8, 17)) == (False, None)


def test_is_stale_false_when_reported_date_matches_expected(monkeypatch):
    """回報日期就是最新交易日 → 不算 stale。"""
    monkeypatch.setattr(ds, 'is_twse_trading_day', lambda d: True)
    assert ds.is_stale(date(2026, 8, 14), date(2026, 8, 14)) == (False, date(2026, 8, 14))


def test_is_stale_true_when_reported_date_earlier_than_expected(monkeypatch):
    """回報日期早於最新交易日 → 視為 stale。"""
    monkeypatch.setattr(ds, 'is_twse_trading_day', lambda d: True)
    assert ds.is_stale(date(2026, 8, 13), date(2026, 8, 14)) == (True, date(2026, 8, 14))


# ── 近期補洞（find_peer_gaps / recent_trading_days）─────────────────────────

def test_find_peer_gaps_flags_date_missing_any_ticker():
    """某日少了一檔有來源的 ticker → 該日算缺漏。"""
    days = [date(2026, 8, 17), date(2026, 8, 18)]
    existing = {('2026-08-17', 'A'), ('2026-08-17', 'B'), ('2026-08-18', 'A')}
    assert ds.find_peer_gaps(days, existing, {'A', 'B'}) == [date(2026, 8, 18)]


def test_find_peer_gaps_empty_when_all_present():
    days = [date(2026, 8, 17)]
    existing = {('2026-08-17', 'A'), ('2026-08-17', 'B')}
    assert ds.find_peer_gaps(days, existing, {'A', 'B'}) == []


def test_find_peer_gaps_date_absent_entirely_is_a_gap():
    """整天完全沒有列（實例：overseas 的 2026-08-18）→ 必須被抓出來。"""
    days = [date(2026, 8, 18)]
    assert ds.find_peer_gaps(days, set(), {'A'}) == [date(2026, 8, 18)]


def test_find_peer_gaps_ignores_extra_tickers():
    """DB 有多的 ticker（例如已停用的來源）不影響判定。"""
    days = [date(2026, 8, 17)]
    existing = {('2026-08-17', 'A'), ('2026-08-17', 'Z')}
    assert ds.find_peer_gaps(days, existing, {'A'}) == []


def test_recent_trading_days_skips_weekend(monkeypatch):
    """2026-08-23 是週日 → 最近 3 個交易日應為 8/19、8/20、8/21。"""
    monkeypatch.setattr(ds, 'is_twse_trading_day', lambda d: d.weekday() < 5)
    assert ds.recent_trading_days(date(2026, 8, 23), 3) == [
        date(2026, 8, 19), date(2026, 8, 20), date(2026, 8, 21),
    ]


def test_recent_trading_days_skips_market_holiday(monkeypatch):
    """行事曆說 8/20 休市（例：颱風）→ 該日不算，往前多取一天。"""
    closed = {date(2026, 8, 20)}
    monkeypatch.setattr(ds, 'is_twse_trading_day',
                        lambda d: d.weekday() < 5 and d not in closed)
    assert ds.recent_trading_days(date(2026, 8, 23), 3) == [
        date(2026, 8, 18), date(2026, 8, 19), date(2026, 8, 21),
    ]


def test_recent_trading_days_includes_day_when_twse_unreachable(monkeypatch):
    """TWSE 連不到（回 None）→ 照收平日，寧可多補一天也不要漏。"""
    monkeypatch.setattr(ds, 'is_twse_trading_day', lambda d: None)
    assert ds.recent_trading_days(date(2026, 8, 21), 2) == [
        date(2026, 8, 20), date(2026, 8, 21),
    ]
