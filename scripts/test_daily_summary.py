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
