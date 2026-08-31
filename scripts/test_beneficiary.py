"""beneficiary_fetch 純函式單元測試。零網路：全部吃 scripts/fixtures/ 的真實回應。

跑法：cd 00998a-web && python -m pytest scripts/test_beneficiary.py -q
"""

import os

import beneficiary_fetch as bf

FIX = os.path.join(os.path.dirname(__file__), 'fixtures')


def _read(name: str) -> str:
    with open(os.path.join(FIX, name), encoding='utf-8') as f:
        return f.read()


# ── parse_tdcc_html ──────────────────────────────────────────────────────────

def test_html_total_row_when_adjustment_row_present():
    """20260731 有「差異數調整」列 → 合計在第 17 列。用序號當索引會抓錯，必須靠標籤。"""
    rows = bf.parse_tdcc_html(_read('tdcc_00991A_20260731.html'), '2026-07-31', '00991A')
    total = bf.total_row(rows)
    assert total['people'] == 342010
    assert total['units'] == 4637416000


def test_html_total_row_when_adjustment_row_absent():
    """20260828 沒有「差異數調整」列 → 合計在第 16 列。同一支解析器要兩種都對。"""
    rows = bf.parse_tdcc_html(_read('tdcc_00991A_20260828.html'), '2026-08-28', '00991A')
    total = bf.total_row(rows)
    assert total['people'] == 339311
    assert total['units'] == 4746416000


def test_html_never_uses_last_row_as_total():
    """回歸測試：合計列的 level 一律是 17，不因它在表中第幾列而變。"""
    for name, d in (('tdcc_00991A_20260731.html', '2026-07-31'),
                    ('tdcc_00991A_20260828.html', '2026-08-28')):
        rows = bf.parse_tdcc_html(_read(name), d, '00991A')
        assert bf.total_row(rows)['level'] == 17


def test_html_has_all_fifteen_levels():
    rows = bf.parse_tdcc_html(_read('tdcc_00991A_20260828.html'), '2026-08-28', '00991A')
    levels = sorted(r['level'] for r in rows if r['level'] <= 15)
    assert levels == list(range(1, 16))


def test_html_level_values_match_source():
    """逐欄對第 1、9、15 級距，確認人數/單位數/佔比沒有錯位。"""
    rows = bf.parse_tdcc_html(_read('tdcc_00991A_20260828.html'), '2026-08-28', '00991A')
    by_level = {r['level']: r for r in rows}
    assert (by_level[1]['people'], by_level[1]['units'], by_level[1]['pct']) == (37744, 12168060, 0.25)
    assert (by_level[9]['people'], by_level[9]['units'], by_level[9]['pct']) == (8396, 617011895, 12.99)
    assert (by_level[15]['people'], by_level[15]['units'], by_level[15]['pct']) == (127, 902898348, 19.02)


def test_html_adjustment_row_kept_with_empty_people():
    """差異數調整列人數是空字串、單位數是負的 → 存成 level 16、people=0，不可讓它污染合計。"""
    rows = bf.parse_tdcc_html(_read('tdcc_00991A_20260731.html'), '2026-07-31', '00991A')
    adj = next(r for r in rows if r['level'] == 16)
    assert adj['people'] == 0
    assert adj['units'] == -3996443


def test_html_levels_sum_to_total_people():
    """15 個級距人數加總應等於合計人數（差異數調整只影響單位數，不影響人數）。"""
    for name, d in (('tdcc_00991A_20260731.html', '2026-07-31'),
                    ('tdcc_00991A_20260828.html', '2026-08-28')):
        rows = bf.parse_tdcc_html(_read(name), d, '00991A')
        assert sum(r['people'] for r in rows if r['level'] <= 15) == bf.total_row(rows)['people']


def test_html_carries_date_and_ticker():
    rows = bf.parse_tdcc_html(_read('tdcc_00991A_20260731.html'), '2026-07-31', '00991A')
    assert {r['date'] for r in rows} == {'2026-07-31'}
    assert {r['ticker'] for r in rows} == {'00991A'}


def test_html_empty_page_returns_nothing():
    """沒帶 CSRF token 時 TDCC 回的是表單頁（HTTP 200 但無結果表）→ 必須回空、不可假裝成功。"""
    assert bf.parse_tdcc_html('<html><body>no table here</body></html>', '2026-07-31', '00991A') == []


# ── parse_opendata_csv ───────────────────────────────────────────────────────

def test_csv_filters_to_requested_tickers():
    rows = bf.parse_opendata_csv(_read('tdcc_opendata_sample.csv'), {'00991A'})
    assert {r['ticker'] for r in rows} == {'00991A'}


def test_csv_total_matches_html_for_same_week():
    """同一週的 CSV 與查詢頁必須給出同一個合計 → 兩條路可以互相回補而不打架。"""
    csv_rows = bf.parse_opendata_csv(_read('tdcc_opendata_sample.csv'), {'00991A'})
    html_rows = bf.parse_tdcc_html(_read('tdcc_00991A_20260828.html'), '2026-08-28', '00991A')
    assert bf.total_row(csv_rows) == bf.total_row(html_rows)


def test_csv_date_is_normalised_to_iso():
    rows = bf.parse_opendata_csv(_read('tdcc_opendata_sample.csv'), {'00991A'})
    assert {r['date'] for r in rows} == {'2026-08-28'}


def test_csv_keeps_multiple_tickers():
    rows = bf.parse_opendata_csv(_read('tdcc_opendata_sample.csv'), {'00991A', '00981A'})
    assert {r['ticker'] for r in rows} == {'00991A', '00981A'}
    assert bf.total_row([r for r in rows if r['ticker'] == '00981A'])['people'] > 0


def test_csv_unknown_ticker_returns_nothing():
    assert bf.parse_opendata_csv(_read('tdcc_opendata_sample.csv'), {'09999A'}) == []


# ── total_row ────────────────────────────────────────────────────────────────

def test_total_row_returns_none_when_missing():
    """只有級距沒有合計列 → 回 None，呼叫端才有機會判定這週資料不完整。"""
    assert bf.total_row([{'level': 1, 'people': 10, 'units': 100}]) is None


# ── 級距聚合 ─────────────────────────────────────────────────────────────────

def test_level_groups_cover_all_fifteen_levels_exactly_once():
    seen = [lv for g in bf.LEVEL_GROUPS for lv in g['levels']]
    assert sorted(seen) == list(range(1, 16))
