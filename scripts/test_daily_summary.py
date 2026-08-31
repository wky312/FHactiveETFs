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

ALL = lambda tickers: (lambda d: set(tickers))


def test_find_peer_gaps_flags_date_missing_any_ticker():
    """某日少了一檔有來源的 ticker → 回報該日與「缺哪幾檔」。"""
    days = [date(2026, 8, 17), date(2026, 8, 18)]
    existing = {('2026-08-17', 'A'), ('2026-08-17', 'B'), ('2026-08-18', 'A')}
    assert ds.find_peer_gaps(days, existing, ALL({'A', 'B'})) == [(date(2026, 8, 18), {'B'})]


def test_find_peer_gaps_empty_when_all_present():
    days = [date(2026, 8, 17)]
    existing = {('2026-08-17', 'A'), ('2026-08-17', 'B')}
    assert ds.find_peer_gaps(days, existing, ALL({'A', 'B'})) == []


def test_find_peer_gaps_date_absent_entirely_is_a_gap():
    """整天完全沒有列（實例：tw_active 的 2026-08-07）→ 必須被抓出來，且整組都算缺。"""
    days = [date(2026, 8, 18)]
    assert ds.find_peer_gaps(days, set(), ALL({'A', 'B'})) == [(date(2026, 8, 18), {'A', 'B'})]


def test_find_peer_gaps_ignores_extra_tickers():
    """DB 有多的 ticker（例如已停用的來源）不影響判定。"""
    days = [date(2026, 8, 17)]
    existing = {('2026-08-17', 'A'), ('2026-08-17', 'Z')}
    assert ds.find_peer_gaps(days, existing, ALL({'A'})) == []


def test_find_peer_gaps_respects_per_date_expected():
    """expected 逐日計算：掛牌前的新檔不算缺，掛牌後才算。"""
    days = [date(2026, 8, 17), date(2026, 8, 18)]
    existing = {('2026-08-17', 'A'), ('2026-08-18', 'A')}
    expected_of = lambda d: {'A'} if d < date(2026, 8, 18) else {'A', 'NEW'}
    assert ds.find_peer_gaps(days, existing, expected_of) == [(date(2026, 8, 18), {'NEW'})]


def test_expected_tickers_on_excludes_ticker_before_its_since(monkeypatch):
    """since 之前不該期待有值——否則每個舊交易日都被判缺漏、每天白抓一輪。"""
    monkeypatch.setattr(ds, 'PEER_ETFS', [
        {'ticker': 'OLD', 'source': 'ezmoney', 'key': 'x'},
        {'ticker': 'NEW', 'source': 'ezmoney', 'key': 'y', 'since': '2026-08-24'},
        {'ticker': 'NOSRC', 'key': 'z'},
    ])
    assert ds.expected_tickers_on(date(2026, 8, 21)) == {'OLD'}
    assert ds.expected_tickers_on(date(2026, 8, 24)) == {'OLD', 'NEW'}


def test_every_peer_source_has_a_fetcher():
    """漏登記抓取器不會報錯、只會靜靜略過 → 用測試把它變成紅燈。"""
    missing = {e['source'] for e in ds.PEER_ETFS if e.get('source')} - set(ds._SOURCE_FETCHERS)
    assert not missing, f'這些來源沒有對應抓取器：{sorted(missing)}'


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


# ── 海外申贖：正式值 vs 預估值 的取捨 ────────────────────────────────────────

_OFF = {'date': date(2026, 8, 25), 'netSub': -0.15, 'aum': 372.0, 'is_estimate': False}
_EST = {'date': date(2026, 8, 25), 'netSub': -0.15, 'aum': 365.0, 'is_estimate': True}


def test_pick_latest_point_same_day_prefers_official():
    """元大(T+1) 常常同一天正式值與預估值都拿得到 → 必須報正式值。"""
    assert ds.pick_latest_point(_OFF, _EST) is _OFF


def test_pick_latest_point_newer_estimate_wins():
    """統一(T+2) 正式值停在 T-2、預估值已到 T-1 → 報比較新的預估值。"""
    older_official = {**_OFF, 'date': date(2026, 8, 24)}
    assert ds.pick_latest_point(older_official, _EST) is _EST


def test_pick_latest_point_handles_missing_sides():
    assert ds.pick_latest_point(None, _EST) is _EST
    assert ds.pick_latest_point(_OFF, None) is _OFF
    assert ds.pick_latest_point(None, None) is None


def test_pick_latest_point_never_downgrades_to_older_estimate():
    """預估值比正式值舊時不可勝出（否則會把已定案的數字換成過期估計）。"""
    stale_estimate = {**_EST, 'date': date(2026, 8, 22)}
    assert ds.pick_latest_point(_OFF, stale_estimate) is _OFF


# ── 預估值：公告日候選要往後掃 ──────────────────────────────────────────────

def test_announce_candidates_weekday():
    """平日 → 今天 + 之後兩個營業日。"""
    assert ds._announce_candidates(date(2026, 8, 26), 3) == [
        date(2026, 8, 26), date(2026, 8, 27), date(2026, 8, 28),
    ]


def test_announce_candidates_crosses_weekend():
    """週五 → 跳過週末。"""
    assert ds._announce_candidates(date(2026, 8, 28), 3) == [
        date(2026, 8, 28), date(2026, 8, 31), date(2026, 9, 1),
    ]


def test_announce_candidates_from_weekend_starts_next_biz_day():
    """週日執行 → 今天不算公告日，從週一起算。"""
    assert ds._announce_candidates(date(2026, 8, 23), 2) == [
        date(2026, 8, 24), date(2026, 8, 25),
    ]


def test_newest_estimate_picks_latest_self_reported_date():
    """今天的公告日只給 T-1，次一公告日給 T → 必須回 T 那筆。"""
    by_ann = {
        date(2026, 8, 26): {'date': date(2026, 8, 25), 'netSub': 1.0},
        date(2026, 8, 27): {'date': date(2026, 8, 26), 'netSub': 2.0},
    }
    got = ds._newest_estimate(by_ann.get, today=date(2026, 8, 26))
    assert got['date'] == date(2026, 8, 26) and got['netSub'] == 2.0


def test_newest_estimate_stops_once_today_reached():
    """抓到「今天」的預估就收工，不再多打後面的候選。"""
    calls = []

    def fetch_one(ann):
        calls.append(ann)
        return {'date': date(2026, 8, 26), 'netSub': 1.0}

    ds._newest_estimate(fetch_one, today=date(2026, 8, 26))
    assert calls == [date(2026, 8, 26)]


def test_newest_estimate_survives_failing_candidate():
    """某個公告日拋例外/回 None 不能中斷，後面的候選仍要試。"""
    def fetch_one(ann):
        if ann == date(2026, 8, 26):
            raise RuntimeError('boom')
        if ann == date(2026, 8, 27):
            return None
        return {'date': date(2026, 8, 25), 'netSub': 3.0}

    got = ds._newest_estimate(fetch_one, today=date(2026, 8, 26))
    assert got['netSub'] == 3.0


def test_newest_estimate_all_fail_returns_none():
    assert ds._newest_estimate(lambda ann: None, today=date(2026, 8, 26)) is None


def test_newest_estimate_rejects_future_dated_estimate():
    """投信若把「下一交易日」當快照日回來（群益 buyback 有前科），不可採用。"""
    def fetch_one(ann):
        if ann == date(2026, 8, 26):
            return {'date': date(2026, 8, 25), 'netSub': 1.0}
        return {'date': date(2026, 8, 27), 'netSub': 9.9}   # 未來日，要被擋掉

    got = ds._newest_estimate(fetch_one, today=date(2026, 8, 26))
    assert got['date'] == date(2026, 8, 25) and got['netSub'] == 1.0


# ── Email 副本 ──────────────────────────────────────────────────────────────

def _fake_smtp(monkeypatch, sent: dict):
    import smtplib

    class FakeSMTP:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def login(self, user, pw):
            sent['login'] = (user, pw)

        def send_message(self, msg):
            sent['msg'] = msg

    monkeypatch.setattr(smtplib, 'SMTP_SSL', FakeSMTP)


def test_send_email_digest_skips_when_unconfigured(monkeypatch):
    """沒設 Gmail/收件者時要靜默回 False，不能拋例外把 Pushover 流程拖下水。"""
    monkeypatch.setattr(ds, 'GMAIL_USER', '')
    monkeypatch.setattr(ds, 'GMAIL_APP_PASSWORD', '')
    monkeypatch.setattr(ds, 'REPORT_EMAIL_TO', '')
    assert ds.send_email_digest('標題', [{'title': 'a', 'message': 'b', 'image': b'png'}]) is False


def _configure_mail(monkeypatch, to='a@x.edu'):
    monkeypatch.setattr(ds, 'GMAIL_USER', 'bot@gmail.com')
    monkeypatch.setattr(ds, 'GMAIL_APP_PASSWORD', 'pw')
    monkeypatch.setattr(ds, 'REPORT_EMAIL_TO', to)


def test_send_email_digest_embeds_one_image_per_section(monkeypatch):
    """三段各自內嵌自己的圖，cid 必須各自獨立、且都掛在 html part 底下。"""
    sent: dict = {}
    _fake_smtp(monkeypatch, sent)
    _configure_mail(monkeypatch, 'a@x.edu, b@y.edu')

    sections = [
        {'title': '00991A 當日摘要 08/27', 'message': '第一行\n<b>第二行</b>', 'image': b'png1'},
        {'title': '同業申贖觀測 2026-08-27', 'message': '內文', 'image': b'png2'},
        {'title': '海外主動式ETF 申購買回 08/27', 'message': '內文', 'image': b'png3'},
    ]
    assert ds.send_email_digest('復華主動式ETF 每日摘要 08/27', sections) is True

    msg = sent['msg']
    assert msg['Subject'] == '復華主動式ETF 每日摘要 08/27'
    assert msg['To'] == 'a@x.edu, b@y.edu'
    cids = [p.get('Content-ID') for p in msg.walk() if p.get('Content-ID')]
    assert cids == ['<report0>', '<report1>', '<report2>']
    html = next(p for p in msg.walk() if p.get_content_type() == 'text/html').get_content()
    for i, sec in enumerate(sections):
        assert sec['title'] in html and f'cid:report{i}' in html
    assert '第一行<br>' in html


def test_send_email_digest_section_without_image(monkeypatch):
    sent: dict = {}
    _fake_smtp(monkeypatch, sent)
    _configure_mail(monkeypatch)
    assert ds.send_email_digest('摘要', [{'title': '告警', 'message': '資料源連不到', 'image': None}]) is True
    html = next(p for p in sent['msg'].walk() if p.get_content_type() == 'text/html').get_content()
    assert 'cid:report' not in html


def test_send_email_digest_swallows_smtp_failure(monkeypatch):
    """SMTP 掛掉不能往上拋——Pushover 早就個別送出去了。"""
    import smtplib
    _configure_mail(monkeypatch)

    def boom(*a, **k):
        raise OSError('connection refused')

    monkeypatch.setattr(smtplib, 'SMTP_SSL', boom)
    assert ds.send_email_digest('摘要', [{'title': 't', 'message': 'm', 'image': None}]) is False


def test_notify_pushes_now_but_queues_email(monkeypatch):
    """notify 立刻推 Pushover，email 只進 buffer（三則要合併成一封）。"""
    calls = []
    monkeypatch.setattr(ds, 'send_pushover', lambda t, m, i, p=0: calls.append(('push', t)))
    monkeypatch.setattr(ds, 'send_pushover_text', lambda t, m, p=0: calls.append(('push_text', t)))
    ds._EMAIL_SECTIONS.clear()

    ds.notify('有圖', '內文', b'png')
    ds.notify('無圖', '內文', None, priority=1)

    assert calls == [('push', '有圖'), ('push_text', '無圖')]
    assert [s['title'] for s in ds._EMAIL_SECTIONS] == ['有圖', '無圖']
    assert [bool(s['image']) for s in ds._EMAIL_SECTIONS] == [True, False]
    ds._EMAIL_SECTIONS.clear()


def test_flush_email_digest_combines_and_clears(monkeypatch):
    sent: dict = {}
    monkeypatch.setattr(ds, 'send_email_digest', lambda subj, secs: sent.update(subject=subj, n=len(secs)) or True)
    ds._EMAIL_SECTIONS.clear()
    ds.queue_email_section('a', 'm', b'p')
    ds.queue_email_section('b', 'm', b'p')

    assert ds.flush_email_digest(date(2026, 8, 27)) is True
    assert sent['subject'] == '復華主動式ETF 每日摘要 08/27' and sent['n'] == 2
    assert ds._EMAIL_SECTIONS == []          # 寄完要清空，避免下一輪重複


def test_flush_email_digest_marks_warning_subject(monkeypatch):
    """任一段是告警 → 主旨掛 ⚠️，手機掃一眼就知道要看。"""
    sent: dict = {}
    monkeypatch.setattr(ds, 'send_email_digest', lambda subj, secs: sent.update(subject=subj) or True)
    ds._EMAIL_SECTIONS.clear()
    ds.queue_email_section('00991A 當日摘要 08/27', 'm', b'p')
    ds.queue_email_section('⚠️ 每日摘要無資料', 'm', None)

    ds.flush_email_digest(date(2026, 8, 27))
    assert sent['subject'].startswith('⚠️ ')
    ds._EMAIL_SECTIONS.clear()


def test_flush_email_digest_noop_when_empty():
    ds._EMAIL_SECTIONS.clear()
    assert ds.flush_email_digest(date(2026, 8, 27)) is False
