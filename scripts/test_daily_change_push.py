"""daily_change_push 純函式測試（零網路）。跑法：cd scripts && python -m pytest test_daily_change_push.py -q"""

import daily_change_push as m

DATA = {
    'funds': [
        {'ticker': '00991A', 'name': 'A', 'curDate': '2026-10-21', 'prevDate': '2026-10-20'},
        {'ticker': '00981A', 'name': 'B', 'curDate': '2026-10-21', 'prevDate': '2026-10-20'},
        {'ticker': '00992A', 'name': 'C', 'curDate': '2026-10-20', 'prevDate': '2026-10-17'},
        {'ticker': '00980A', 'name': 'D', 'curDate': '2026-10-21', 'prevDate': '2026-10-20'},
    ],
    'stocks': [
        {'stockid': '2330', 'stockname': '台積電', 'close': 1000.0, 'changes': [
            {'ticker': '00991A', 'prev': 1000, 'cur': 3000},
            {'ticker': '00981A', 'prev': 5000, 'cur': 4000},
            {'ticker': '00980A', 'prev': 0, 'cur': 9000}]},          # 非三檔之一 → 不算
        {'stockid': '2317', 'stockname': '鴻海', 'close': 200.0, 'changes': [
            {'ticker': '00992A', 'prev': 0, 'cur': 50000}]},
        {'stockid': '9999', 'stockname': '無報價', 'close': None, 'changes': [
            {'ticker': '00981A', 'prev': 2000, 'cur': 0}]},
        {'stockid': '1111', 'stockname': '只有別檔', 'close': 10.0, 'changes': [
            {'ticker': '00980A', 'prev': 0, 'cur': 1000}]},
    ],
}
T = ['00991A', '00981A', '00992A']


def test_build_rows_aggregates_selected_funds_only():
    rows, buy, sell = m.build_rows(DATA, T)
    assert [r['stockid'] for r in rows] == ['2317', '2330', '9999']   # |金額| 由大到小，無報價殿後
    tsmc = rows[1]
    assert tsmc['net'] == 1000 and tsmc['amount'] == 1_000_000
    assert [p['ticker'] for p in tsmc['adds']] == ['00991A'] and [p['ticker'] for p in tsmc['cuts']] == ['00981A']
    assert rows[0]['adds'][0]['tag'] == '新' and rows[2]['cuts'][0]['tag'] == '清'
    assert buy == 2_000_000 + 10_000_000 and sell == 1_000_000


def test_lagging_funds_flags_not_today():
    lag = m.lagging_funds(DATA, T, '2026-10-21')
    assert [f['ticker'] for f in lag] == ['00992A']
    assert [f['ticker'] for f in m.lagging_funds({'funds': []}, T, '2026-10-21')] == T   # 查無資料也算落後
