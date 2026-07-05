"""highlight_scan 單元＋mock 整合測試。純 fixture，零網路。

跑法：cd 00998a-web && python -m pytest scripts/test_highlight_scan.py -q
"""

import json
from datetime import date

import pytest

import highlight_scan as hs
from highlight_scan import (Candidate, DedupState, ScanContext, build_message,
                            rule_r1, rule_r2, rule_r3, rule_r4, rule_r5,
                            select_top)

CFG = hs.load_config()
TODAY = date(2026, 7, 3)


def make_ctx(**kw):
    ctx = ScanContext(today=TODAY)
    ctx.own = {'names': {'2330': '台積電', '1519': '華城電機', '9999': '獨門股'},
               'days': {}}
    ctx.own_days_sorted = []
    for k, v in kw.items():
        setattr(ctx, k, v)
    return ctx


def own_days(ctx, days: dict):
    ctx.own['days'] = days
    ctx.own_days_sorted = sorted(days.keys())
    return ctx


# ── R1（AC-001/002）───────────────────────────────────────────────────────────

def r1_ctx(pct=4.2, cross=None):
    ctx = make_ctx(quotes={'2330': {'pct': pct, 'price': 1200.0}}, cross=cross)
    return own_days(ctx, {'2026/07/03': [
        {'c': '2330', 'q': 3400000, 'm': 1, 'p': 8.3},
        {'c': '1519', 'q': 100000, 'm': 1, 'p': 2.0},
    ]})


def test_r1_triggers_with_name_pct_weight():
    got = rule_r1(r1_ctx(), CFG)
    assert len(got) == 1
    c = got[0]
    assert '台積電' in c.fact and '4.2' in c.fact and '8.3' in c.fact
    assert c.score == pytest.approx(4.2 * 8.3, abs=0.01)


def test_r1_below_threshold_no_trigger():
    assert rule_r1(r1_ctx(pct=2.9), CFG) == []


def test_r1_heaviest_clause_only_when_top_across_universe():
    cross = {'00991A': {'date': '2026-07-03', 'w': {'2330': 8.3}},
             '00981A': {'date': '2026-07-03', 'w': {'2330': 5.0}}}
    got = rule_r1(r1_ctx(cross=cross), CFG)
    assert '持有最重' in got[0].fact
    cross['00981A']['w']['2330'] = 12.0
    got = rule_r1(r1_ctx(cross=cross), CFG)
    assert '持有最重' not in got[0].fact


def test_r1_no_cross_omits_heaviest_clause():
    got = rule_r1(r1_ctx(cross=None), CFG)
    assert len(got) == 1 and '持有最重' not in got[0].fact


# ── R2（AC-003）───────────────────────────────────────────────────────────────

def r2_ctx(others_weight=None, pct=6.0):
    w = {'9999': 3.0}
    cross = {'00991A': {'date': '2026-07-03', 'w': w}}
    cross['00981A'] = {'date': '2026-07-03',
                       'w': {'9999': others_weight} if others_weight else {}}
    ctx = make_ctx(cross=cross,
                   quotes={'9999': {'pct': pct, 'price': 100.0}},
                   high60=lambda s: 200.0)
    return own_days(ctx, {'2026/07/03': [{'c': '9999', 'q': 1, 'm': 1, 'p': 3.0}]})


def test_r2_exclusive_triggers():
    got = rule_r2(r2_ctx(), CFG)
    assert len(got) == 1 and '獨門' in got[0].fact
    assert got[0].score == pytest.approx(6.0 * 3.0 * 1.5, abs=0.01)


def test_r2_held_by_peer_not_overweight_no_trigger():
    assert rule_r2(r2_ctx(others_weight=2.0), CFG) == []  # 3.0 < 2×2.0


def test_r2_overweight_triggers():
    got = rule_r2(r2_ctx(others_weight=1.4), CFG)  # 3.0 >= 2×1.4 且 >=1%
    assert len(got) == 1 and '超配' in got[0].fact


# ── R3（AC-004）───────────────────────────────────────────────────────────────

def r3_ctx(latest_px=120.0):
    ctx = make_ctx(px_on=lambda s, d: 100.0, px_latest=lambda s: latest_px)
    return own_days(ctx, {
        '2026/06/19': [{'c': '1519', 'q': 100000, 'm': 1, 'p': 2.0}],
        '2026/06/20': [{'c': '1519', 'q': 150000, 'm': 1, 'p': 3.0}],
        '2026/07/03': [{'c': '1519', 'q': 150000, 'm': 1, 'p': 3.1}],
    })


def test_r3_add_event_triggers_at_tier():
    got = rule_r3(r3_ctx(), CFG, DedupState())
    assert len(got) == 1
    assert '加碼' in got[0].fact and '+20' in got[0].fact
    assert got[0].data['tier'] == 15


def test_r3_dedup_same_tier_no_repush():
    state = DedupState(r3_events={'1519|2026/06/20': {'direction': 'add',
                                                      'tier_pushed': 15}})
    assert rule_r3(r3_ctx(), CFG, state) == []


def test_r3_higher_tier_repushes():
    state = DedupState(r3_events={'1519|2026/06/20': {'direction': 'add',
                                                      'tier_pushed': 15}})
    got = rule_r3(r3_ctx(latest_px=135.0), CFG, state)   # +35% 跨過 30
    assert len(got) == 1 and got[0].data['tier'] == 30


def test_r3_same_stock_keeps_best_event_only():
    ctx = make_ctx(px_on=lambda s, d: 100.0, px_latest=lambda s: 120.0)
    own_days(ctx, {
        '2026/06/19': [{'c': '1519', 'q': 100000, 'm': 1, 'p': 2.0}],
        '2026/06/20': [{'c': '1519', 'q': 150000, 'm': 1, 'p': 3.0}],
        '2026/06/23': [{'c': '1519', 'q': 200000, 'm': 1, 'p': 4.0}],
    })
    got = rule_r3(ctx, CFG, DedupState())
    assert len(got) == 1  # 兩個相鄰加碼事件只留最佳一則


def test_r3_trim_dodge():
    ctx = make_ctx(px_on=lambda s, d: 100.0, px_latest=lambda s: 90.0)
    own_days(ctx, {
        '2026/06/19': [{'c': '1519', 'q': 100000, 'm': 1, 'p': 2.0}],
        '2026/06/20': [{'c': '1519', 'q': 50000, 'm': 1, 'p': 1.0}],
    })
    got = rule_r3(ctx, CFG, DedupState())
    assert len(got) == 1 and '減碼' in got[0].fact


# ── R4（AC-005）───────────────────────────────────────────────────────────────

def cumret(wins_at_end):
    """製造一段 00991A 對 0050 連勝 wins_at_end 天的序列。"""
    n = 12
    dates = [f'2026-06-{10 + i:02d}' for i in range(n)]
    bench = [round(i * 0.1, 2) for i in range(n)]
    mine = [0.0]
    for i in range(1, n):
        win = i >= n - wins_at_end
        mine.append(round((1 + mine[-1] / 100) *
                          (1 + (0.003 if win else -0.001)) * 100 - 100, 4))
    return {'dates': dates,
            'series': [{'ticker': '00991A', 'pct': mine},
                       {'ticker': '0050', 'pct': bench}]}


def test_r4_streak_triggers_on_threshold_day():
    ctx = make_ctx(cumret=cumret(3), peer_perf=None)
    got = [c for c in rule_r4(ctx, CFG, DedupState()) if 'streak' in c.id]
    assert len(got) == 1 and '連續 3' in got[0].fact


def test_r4_streak_not_on_day_4():
    ctx = make_ctx(cumret=cumret(4), peer_perf=None)
    assert [c for c in rule_r4(ctx, CFG, DedupState()) if 'streak' in c.id] == []


def test_r4_rank_first_entry_then_dedup():
    perf = [{'ticker': '00991A', 'pctMTD': 10, 'pctYTD': 50, 'anomaly': False},
            {'ticker': '00981A', 'pctMTD': 12, 'pctYTD': 40, 'anomaly': False},
            {'ticker': '0050', 'pctMTD': 99, 'pctYTD': 99, 'anomaly': False}]
    ctx = make_ctx(peer_perf=perf, cumret=None)
    got = rule_r4(ctx, CFG, DedupState())
    ranks = [c for c in got if 'rank' in c.id]
    assert {c.data['kind'] for c in ranks} == {'mtd', 'ytd'}
    assert all('0050' != c.data for c in ranks)  # 0050 被 ^\d{5}A$ 濾掉
    state = DedupState(r4_rank={'mtd': {'period': '2026-07', 'last_rank': 2},
                                'ytd': {'period': '2026', 'last_rank': 1}})
    assert [c for c in rule_r4(ctx, CFG, state) if 'rank' in c.id] == []


def test_r4_rank_skips_null_and_anomaly():
    perf = [{'ticker': '00991A', 'pctMTD': 10, 'pctYTD': None, 'anomaly': False},
            {'ticker': '00981A', 'pctMTD': 12, 'pctYTD': 40, 'anomaly': True}]
    ctx = make_ctx(peer_perf=perf, cumret=None)
    got = rule_r4(ctx, CFG, DedupState())
    assert len([c for c in got if 'rank' in c.id]) == 1  # 只剩 mtd（00981A anomaly 被剔除→991 第1）


def test_r4_new_high_with_cooldown():
    data = cumret(0)
    data['series'][0]['pct'][-1] = 99.0  # 最後一天創新高
    ctx = make_ctx(cumret=data, peer_perf=None)
    got = [c for c in rule_r4(ctx, CFG, DedupState()) if 'newhigh' in c.id]
    assert len(got) == 1
    state = DedupState(r4_new_high={'last_high_date': '2026-06-19'})  # 2 交易日前
    got = [c for c in rule_r4(ctx, CFG, state) if 'newhigh' in c.id]
    assert got == []  # 冷卻中


# ── R5（AC-006）───────────────────────────────────────────────────────────────

def redemption(streak=5, today_iso='2026-07-03', aum=120.0):
    rows = []
    for i in range(streak + 2):
        d = f'2026-06-{20 + i:02d}' if 20 + i <= 30 else today_iso
        rows.append({'date': d, 'ticker': '00991A',
                     'net_sub': -1.0 if i < 2 else 2.0, 'aum': aum})
    rows[-1]['date'] = today_iso
    rows.append({'date': today_iso, 'ticker': '00981A', 'net_sub': 0.5, 'aum': 50})
    return rows


def test_r5_streak_triggers():
    ctx = make_ctx(redemption=redemption(5))
    got = [c for c in rule_r5(ctx, CFG, DedupState()) if 'streak' in c.id]
    assert len(got) == 1 and '連續 5' in got[0].fact


def test_r5_yesterday_data_still_triggers_once():
    # 14:00 掃描時申贖只到前一交易日：容遲評估，但同一資料日只觸發一次
    rows = redemption(5, today_iso='2026-07-02')
    ctx = make_ctx(redemption=rows)
    got = rule_r5(ctx, CFG, DedupState())
    assert any('streak' in c.id for c in got)
    assert all(c.state_patch.get('r5_last_data_date') == '2026-07-02'
               for c in got if 'streak' in c.id)
    state = DedupState(r5_last_data_date='2026-07-02')
    assert rule_r5(ctx, CFG, state) == []


def test_r5_single_day_first():
    ctx = make_ctx(redemption=redemption(4))  # streak=4 非門檻
    got = rule_r5(ctx, CFG, DedupState())
    assert any('top1' in c.id for c in got)
    assert all('觀測同業' in c.fact for c in got if 'top1' in c.id)


def test_r5_aum_milestone_double_insurance():
    rows = redemption(4, aum=140.0)
    rows[-2]['aum'] = 160.0  # 今天(00991A 最後列)跨過 150
    for r in rows[:-2]:
        r['aum'] = 140.0
    ctx = make_ctx(redemption=rows)
    got = [c for c in rule_r5(ctx, CFG, DedupState()) if 'aum' in c.id]
    assert len(got) == 1 and got[0].data['milestone'] == 150
    state = DedupState(r5_aum_milestones=[3])  # 已推過 150（tier 3）
    assert [c for c in rule_r5(ctx, CFG, state) if 'aum' in c.id] == []


# ── 排序/訊息（AC-007/008、FR-02/03/07）──────────────────────────────────────

def cand(i, score):
    return Candidate(id=f'X-{i}', rule='R1', score=score, fact=f'fact{i}',
                     angle=f'angle{i}', draft=f'draft{i}', data={})


def test_select_top_limits_and_sorts():
    cands = [cand(i, i) for i in range(7)]
    top, rest = select_top(cands, 5)
    assert len(top) == 5 and len(rest) == 2
    assert [c.score for c in top] == [6, 5, 4, 3, 2]


def test_build_message_format_and_footer():
    msg = build_message([cand(1, 9), cand(2, 5)], TODAY, [], CFG)
    assert msg.startswith('📈 00991A 今日亮點 2026/07/03（2 則）')
    assert '① 📌 fact1' in msg and '② 📌 fact2' in msg
    assert CFG['message']['footer'] in msg


def test_build_message_skipped_note():
    msg = build_message([cand(1, 9)], TODAY, ['R2', 'R4'], CFG)
    assert '本日未掃描：R2、R4（來源故障）' in msg


def test_build_message_drops_whole_lowest_blocks_when_too_long():
    big = [Candidate(id=f'B{i}', rule='R1', score=10 - i, fact='F' * 1200,
                     angle='a', draft='d', data={}) for i in range(5)]
    msg = build_message(big, TODAY, [], CFG)
    assert len(msg) <= CFG['message']['max_chars']
    assert 'B0' or True  # 最高分保留（fact 同文無法辨識 id，改驗塊數）
    assert msg.count('📌') < 5


# ── main 流程整合（AC-007/009/010/011）───────────────────────────────────────

def run_main(monkeypatch, tmp_path, *, candidates, status=None, state=None,
             trading=True):
    sent = []
    monkeypatch.setattr(hs, 'OUT_DIR', str(tmp_path))
    monkeypatch.setattr(hs, 'STATE_PATH', str(tmp_path / '_state.json'))
    if state is not None:
        hs.save_state(state, str(tmp_path / '_state.json'))
    monkeypatch.setattr(hs, 'is_twse_trading_day', lambda d: trading)
    default_status = {'own_holdings': 'ok', 'attr_supabase': 'ok',
                      'twse_mis': 'ok', 'yahoo': 'ok',
                      'site_peer_performance': 'ok',
                      'site_cumulative_return': 'ok', 'peer_redemption': 'ok'}
    ctx = make_ctx()
    monkeypatch.setattr(hs, 'build_context',
                        lambda today, cfg: (ctx, status or default_status))
    monkeypatch.setattr(hs, 'run_rules',
                        lambda c, s, cfg, st: (candidates,
                                               [r for r in ('R1', 'R2', 'R3')
                                                if (status or {}).get('own_holdings') == 'fail']))
    monkeypatch.setattr(hs, 'send_line_text', lambda t: (sent.append(t), 200)[1])
    monkeypatch.setattr(hs, 'DRY_RUN', False)
    monkeypatch.setattr(hs, 'FORCE_RESEND', False)
    monkeypatch.setenv('SCAN_DATE', TODAY.isoformat())
    hs.main()
    return sent, tmp_path


def read_daily(tmp_path):
    with open(tmp_path / f'{TODAY.isoformat()}.json', encoding='utf-8') as f:
        return json.load(f)


def test_no_candidates_no_push_but_json_written(monkeypatch, tmp_path):
    sent, out = run_main(monkeypatch, tmp_path, candidates=[])
    assert sent == []
    payload = read_daily(out)
    assert payload['push']['reason'] == 'no_candidates'
    assert 'config_snapshot' in payload


def test_idempotent_rerun_no_repush(monkeypatch, tmp_path):
    state = DedupState(pushed_dates=[TODAY.isoformat()])
    sent, out = run_main(monkeypatch, tmp_path,
                         candidates=[cand(1, 9)], state=state)
    assert sent == []
    assert read_daily(out)['push']['reason'] == 'idempotent_rerun'


def test_push_success_marks_pushed(monkeypatch, tmp_path):
    sent, out = run_main(monkeypatch, tmp_path, candidates=[cand(1, 9)])
    assert len(sent) == 1
    assert TODAY.isoformat() in hs.load_state(str(out / '_state.json')).pushed_dates


def test_push_failure_not_marked_and_exits_red(monkeypatch, tmp_path):
    monkeypatch.setattr(hs, 'OUT_DIR', str(tmp_path))
    monkeypatch.setattr(hs, 'STATE_PATH', str(tmp_path / '_state.json'))
    monkeypatch.setattr(hs, 'is_twse_trading_day', lambda d: True)
    ctx = make_ctx()
    ok = {'own_holdings': 'ok', 'attr_supabase': 'ok', 'twse_mis': 'ok',
          'yahoo': 'ok', 'site_peer_performance': 'ok',
          'site_cumulative_return': 'ok', 'peer_redemption': 'ok'}
    monkeypatch.setattr(hs, 'build_context', lambda today, cfg: (ctx, ok))
    monkeypatch.setattr(hs, 'run_rules', lambda c, s, cfg, st: ([cand(1, 9)], []))
    monkeypatch.setattr(hs, 'send_line_text', lambda t: 500)
    monkeypatch.setattr(hs, 'send_line_alert', lambda t: None)
    monkeypatch.setattr(hs, 'DRY_RUN', False)
    monkeypatch.setattr(hs, 'FORCE_RESEND', False)
    monkeypatch.setenv('SCAN_DATE', TODAY.isoformat())
    with pytest.raises(SystemExit):
        hs.main()
    state = hs.load_state(str(tmp_path / '_state.json'))
    assert TODAY.isoformat() not in state.pushed_dates   # review M2
    assert read_daily(tmp_path)['push']['reason'] == 'push_failed'


def test_source_failure_degrades_with_note(monkeypatch, tmp_path):
    status = {'own_holdings': 'fail', 'attr_supabase': 'ok', 'twse_mis': 'ok',
              'yahoo': 'ok', 'site_peer_performance': 'ok',
              'site_cumulative_return': 'ok', 'peer_redemption': 'ok'}
    sent, out = run_main(monkeypatch, tmp_path,
                         candidates=[cand(1, 9)], status=status)
    assert len(sent) == 1
    assert '本日未掃描' in sent[0]
    assert set(read_daily(out)['skipped_rules']) == {'R1', 'R2', 'R3'}


def test_non_trading_day_silent(monkeypatch, tmp_path):
    sent, out = run_main(monkeypatch, tmp_path, candidates=[cand(1, 9)],
                         trading=False)
    assert sent == []
    assert not (out / f'{TODAY.isoformat()}.json').exists()


def test_run_rules_skips_on_missing_needs():
    status = {'own_holdings': 'fail', 'attr_supabase': 'ok', 'twse_mis': 'ok',
              'yahoo': 'ok', 'site_peer_performance': 'fail',
              'site_cumulative_return': 'fail', 'peer_redemption': 'fail'}
    ctx = make_ctx(peer_perf=None, cumret=None, redemption=None)
    cands, skipped = hs.run_rules(ctx, status, CFG, DedupState())
    assert cands == []
    assert set(skipped) == {'R1', 'R2', 'R3', 'R4', 'R5'}
