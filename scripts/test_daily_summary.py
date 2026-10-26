"""daily_summary 純函式單元測試。零網路：is_twse_trading_day 一律 monkeypatch。

跑法：cd 00998a-web && python -m pytest scripts/test_daily_summary.py -q
"""

from datetime import date, datetime

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


def test_is_stale_lag_allows_overseas_to_be_one_trading_day_behind(monkeypatch):
    """海外檔(holdingsLag=1)：今天 9/2 拿到 9/1 的持股是正常的，不該告警。"""
    monkeypatch.setattr(ds, 'is_twse_trading_day', lambda d: True)
    assert ds.is_stale(date(2026, 9, 1), date(2026, 9, 2), 1) == (False, date(2026, 9, 1))


def test_is_stale_lag_still_flags_two_trading_days_behind(monkeypatch):
    """海外檔連 T-1 都沒有、只到 8/31 → 這才要告警。"""
    monkeypatch.setattr(ds, 'is_twse_trading_day', lambda d: True)
    assert ds.is_stale(date(2026, 8, 31), date(2026, 9, 2), 1) == (True, date(2026, 9, 1))


def test_is_stale_lag_steps_back_over_the_weekend(monkeypatch):
    """往回退一個『交易日』而不是一個日曆日：週一(9/7)的海外檔應更新到週五(9/4)。"""
    monkeypatch.setattr(ds, 'is_twse_trading_day', lambda d: d.weekday() < 5)
    assert ds.is_stale(date(2026, 9, 4), date(2026, 9, 7), 1) == (False, date(2026, 9, 4))


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


# ── fetch_fhtrust_day：公告日候選掃描 ─────────────────────────────────────────
# 復華官網每隔一陣子整站維護（例：2026-09-12 08:00–20:00），那時完全打不到 API，
# 所以這幾條一律用假的 requests.get 驗邏輯，不碰網路。

class _FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


def _fhtrust_stub(monkeypatch, by_pcf_date: dict):
    """by_pcf_date: {'YYYY/MM/DD'(查詢的公告日) -> actBuyValDate or None}。

    回傳 (calls) —— 實際被查過的 pcfDate 清單，用來驗「掃過頭要提早收工」。
    """
    calls = []

    def fake_get(url, **kw):
        pcf = url.split('pcfDate=')[1].replace('%2F', '/')
        calls.append(pcf)
        act = by_pcf_date.get(pcf)
        if act is None:
            return _FakeResp({'result': []})
        return _FakeResp({'result': [{
            'actBuyValDate': act, 'actBuyVal': '5000000', 'qDiff': '100000000.0',
            'nav': '10000000000',
        }]})

    monkeypatch.setattr(ds.requests, 'get', fake_get)
    return calls


def test_fetch_fhtrust_day_matches_self_reported_date(monkeypatch):
    """公告日 = 交易日 +1：以 API 自報的 actBuyValDate 對齊，不是用 offset 推。"""
    _fhtrust_stub(monkeypatch, {
        '2026/09/10': '2026/09/09',   # 這天的公告講的是前一天，不能收
        '2026/09/11': '2026/09/10',
    })
    got = ds.fetch_fhtrust_day('ETF21', date(2026, 9, 10))
    # netSub = actBuyVal × qDiff ÷ 500000 ÷ 1e8 = 5e6 × 1e8 ÷ 5e5 ÷ 1e8 = 10 億
    assert got == {'netSub': 10.0, 'aum': 100.0, 'is_estimate': False}


def test_fetch_fhtrust_day_spans_lunar_new_year(monkeypatch):
    """T+2 交易日碰上 9 天年假 → 公告日在 11 個日曆日後；舊的 8 天上限會漏掉這天。"""
    _fhtrust_stub(monkeypatch, {'2026/02/24': '2026/02/13'})
    got = ds.fetch_fhtrust_day('ETF07', date(2026, 2, 13))
    assert got is not None and got['netSub'] == 10.0


def test_fetch_fhtrust_day_stops_once_overshot(monkeypatch):
    """自報日期已越過目標日 → 該日沒有清單（休市），提早收工不要把 14 天掃完。"""
    calls = _fhtrust_stub(monkeypatch, {
        # 目標 9/19 是週六、沒有清單。週一(9/21)的公告講的還是 9/18，週二(9/22)就跳到 9/21，
        # 已經越過 9/19 → 不可能再對上。
        '2026/09/21': '2026/09/18',
        '2026/09/22': '2026/09/21',
    })
    assert ds.fetch_fhtrust_day('ETF21', date(2026, 9, 19)) is None
    assert calls == ['2026/09/19', '2026/09/20', '2026/09/21', '2026/09/22']  # 不是硬掃滿 14 天


# ── ezmoney 公告日掃描視窗：要跨得過連假 ──────────────────────────────────────

class _FakeEzResp:
    """模擬 ezmoney GetPCF 回應。announced=None 代表那天沒掛清單（回全 0、TranDate 哨兵值）。"""

    status_code = 200
    headers = {'content-type': 'application/json'}

    def __init__(self, tran_date, diff_unit=0.0, p_unit=0.0, nav=0.0):
        self._tran_date = tran_date or '0001-01-01'
        self._amounts = {'DIFF_UNIT': diff_unit, 'P_UNIT': p_unit, 'NAV': nav}

    def json(self):
        return {'pcf': [
            {'PCFCode': code, 'Amount': amt, 'TranDate': f'{self._tran_date}T00:00:00'}
            for code, amt in self._amounts.items()
        ]}


class _FakeEzSession:
    """by_announce: {公告日 date → TranDate 字串}；其餘公告日視為休市（全 0）。"""

    def __init__(self, by_announce):
        self.by_announce = by_announce
        self.queried = []

    def post(self, url, json=None, headers=None, timeout=None):
        roc = json['date']                      # 'YYY/MM/DD'
        y, m, d = roc.split('/')
        announce = date(int(y) + 1911, int(m), int(d))
        self.queried.append(announce)
        tran = self.by_announce.get(announce)
        if tran is None:
            return _FakeEzResp(None)            # 休市：TranDate=0001-01-01、P_UNIT=0
        return _FakeEzResp(tran, diff_unit=-1_000_000.0, p_unit=10.0, nav=1e10)


def test_fetch_ezmoney_day_crosses_four_day_holiday():
    """2026/09/24 的清單要到 09/29 才公告（09/25 中秋～09/28 教師節連休四天）。

    舊版只掃 T+1..T+4 日曆日（09/25–09/28 全是休市）→ 永久留白。
    """
    sess = _FakeEzSession({date(2026, 9, 29): '2026-09-24'})
    got = ds.fetch_ezmoney_day('49YTW', date(2026, 9, 24), session=sess)
    assert got is not None, f'掃到的公告日只有 {sess.queried}'
    assert round(got['netSub'], 4) == -0.1
    assert round(got['aum'], 2) == 100.0


def test_fetch_ezmoney_day_crosses_lunar_new_year():
    """2026 春節休 02/12–02/20：02/11 的清單 02/23 才公告（T+12 日曆日）。"""
    sess = _FakeEzSession({date(2026, 2, 23): '2026-02-11'})
    assert ds.fetch_ezmoney_day('49YTW', date(2026, 2, 11), session=sess) is not None


def test_fetch_ezmoney_day_stops_once_announcement_passes_target():
    """公告日的 TranDate 單調遞增；越過目標日就不可能再對上 → 提早收工，別把視窗掃完。"""
    sess = _FakeEzSession({
        date(2026, 9, 23): '2026-09-22',
        date(2026, 9, 24): '2026-09-23',   # 已越過目標日 09/22
    })
    assert ds.fetch_ezmoney_day('49YTW', date(2026, 9, 21), session=sess) is None
    assert sess.queried == [date(2026, 9, 22), date(2026, 9, 23)], sess.queried


def test_fetch_ezmoney_day_ignores_holiday_sentinel_rows():
    """休市日回 TranDate=0001-01-01、金額全 0 → 不可當成資料，也不可觸發提早收工。"""
    sess = _FakeEzSession({date(2026, 9, 29): '2026-09-24'})
    assert ds.fetch_ezmoney_day('49YTW', date(2026, 9, 24), session=sess) is not None
    assert date(2026, 9, 25) in sess.queried


# ── 預估值公告日候選：也要跨得過連假 ────────────────────────────────────────

def test_announce_candidates_default_crosses_four_day_holiday():
    """2026/09/24 的預估值在 09/29 那份清單裡（09/25 中秋 + 週末 + 09/28 教師節連休四天）。

    _next_biz_day 只跳週末、不認國定假日 → 預設 lookahead 必須夠深才掃得到 09/29，
    否則連假那天的海外預估值整排停在前一個交易日。
    """
    assert date(2026, 9, 29) in ds._announce_candidates(date(2026, 9, 24))


def test_announce_candidates_default_crosses_lunar_new_year():
    """2026 春節休 02/12–02/20（7 個平日）：02/11 的預估值要等 02/23 那份清單。"""
    assert date(2026, 2, 23) in ds._announce_candidates(date(2026, 2, 11))


def test_newest_estimate_crosses_holiday_to_reach_today():
    """休市的公告日回 None，不可讓掃描停住——要一路掃到連假後的第一個公告日。"""
    by_ann = {
        date(2026, 9, 24): {'date': date(2026, 9, 23), 'netSub': -1.61, 'aum': 533.98},
        date(2026, 9, 29): {'date': date(2026, 9, 24), 'netSub': -3.73, 'aum': 531.52},
    }
    got = ds._newest_estimate(lambda ann: by_ann.get(ann), today=date(2026, 9, 24))
    assert got['date'] == date(2026, 9, 24)
    assert got['netSub'] == -3.73


# ── PEER_ETFS 的 since 不變量 ────────────────────────────────────────────────

def test_latest_only_sources_must_declare_since():
    """只拿得到「最新一期」的來源（永豐/兆豐）一定要有 since。

    沒 since 的話，expected_tickers_on 會從 DB 起始日就期待這一檔，而那些歷史日期永遠補不到
    → 每個舊交易日都掛著一個補不完的缺口，補洞邏輯天天白跑（同 00411A 的教訓）。
    """
    missing = [e['ticker'] for e in ds.PEER_ETFS
               if e['source'] in ds.LATEST_ONLY_SOURCES and not e.get('since')]
    assert not missing, f'這些檔的來源只有最新一期卻沒給 since: {missing}'


def test_every_tw_active_fund_has_a_registered_fetcher():
    """台股組每一檔都要有登記的抓取器——漏登記不會報錯，只會靜靜整欄留白。"""
    bad = [e['ticker'] for e in ds.PEER_ETFS
           if e.get('group') == 'tw_active' and e['source'] not in ds._SOURCE_FETCHERS]
    assert not bad, f'沒有對應抓取器: {bad}'


def test_peer_etfs_keys_are_not_tickers_for_keyed_sources():
    """第一金/中信/安聯/摩根/凱基/國泰的 key 是投信內部代號，不是股票代號。

    寫成股票代號不會報錯（端點只會回空），但那一欄會永遠留白——實測第一金 182/183、
    中信 E0036/E0038 都是這樣。這個測試把「順手填成 ticker」擋在 CI。
    """
    keyed = {'fsitc', 'ctbc', 'allianz', 'jpmorgan', 'kgi', 'cathay', 'capital', 'ezmoney'}
    bad = [e['ticker'] for e in ds.PEER_ETFS if e['source'] in keyed and e['key'] == e['ticker']]
    assert not bad, f'這些檔的 key 被填成股票代號了: {bad}'


def test_fetch_all_peer_data_routes_every_etf_through_the_dispatcher(monkeypatch):
    """fetch_all_peer_data 必須對每一檔都呼叫 fetch_peer_day，不可自己維護第二份來源鏈。

    2026-10-03 的實例：新增聯博/第一金/永豐/兆豐 時只登記了 _SOURCE_FETCHERS，
    fetch_all_peer_data 裡那條獨立的 if/elif 鏈沒加 → 四家在每日排程與回補都靜靜回 None，
    回補跑完印「Stored: 0  Skipped/failed: 193」卻還是綠燈。
    """
    seen = []
    monkeypatch.setattr(ds, 'fetch_peer_day',
                        lambda etf, d, ezmoney_session=None: seen.append(etf['ticker']) or {'netSub': 0.0, 'aum': 1.0})
    monkeypatch.setattr(ds, '_get_ezmoney_session', lambda code: None)
    etfs = [
        {'ticker': 'A', 'name': 'a', 'source': 'ab',      'key': 'k', 'group': 'tw_active'},
        {'ticker': 'B', 'name': 'b', 'source': 'fsitc',   'key': 'k', 'group': 'tw_active'},
        {'ticker': 'C', 'name': 'c', 'source': 'sinopac', 'key': 'k', 'group': 'tw_active'},
        {'ticker': 'D', 'name': 'd', 'source': 'mega',    'key': 'k', 'group': 'tw_active'},
        {'ticker': 'E', 'name': 'e', 'source': 'ezmoney', 'key': 'k', 'group': 'tw_active'},
    ]
    res = ds.fetch_all_peer_data(date(2026, 10, 2), etfs)
    assert seen == ['A', 'B', 'C', 'D', 'E'], seen
    assert all(r['data'] is not None for r in res)


def _fake_now(monkeypatch, today):
    class FakeDT(ds.datetime):
        @classmethod
        def now(cls, tz=None):
            return ds.datetime(today.year, today.month, today.day, 14, 0, tzinfo=tz)
    monkeypatch.setattr(ds, 'datetime', FakeDT)


def test_is_twse_trading_day_today_before_fmtqik_posts(monkeypatch):
    """14:00 時 FMTQIK 還沒有今天那列 → 不可判成非交易日（2026-10-07 漏推 LINE 的根因）。"""
    _fake_now(monkeypatch, date(2026, 10, 7))
    monkeypatch.setattr(ds, '_twse_trading_days', lambda y, m: {date(2026, 10, 1), date(2026, 10, 6)})
    monkeypatch.setattr(ds, '_twse_holidays', lambda y: {date(2026, 10, 9), date(2026, 10, 10)})
    assert ds.is_twse_trading_day(date(2026, 10, 7)) is True
    assert ds.is_twse_trading_day(date(2026, 10, 9)) is False     # 國慶日
    assert ds.is_twse_trading_day(date(2026, 10, 11)) is False    # 週日
    assert ds.is_twse_trading_day(date(2026, 10, 2)) is False     # 已過去且不在 FMTQIK
    assert ds.is_twse_trading_day(date(2026, 10, 6)) is True


def test_is_twse_trading_day_today_unknown_when_holiday_api_down(monkeypatch):
    """今天不在 FMTQIK、休市日表又連不到 → None（呼叫端照跑），不可回 False。"""
    _fake_now(monkeypatch, date(2026, 10, 7))
    monkeypatch.setattr(ds, '_twse_trading_days', lambda y, m: set())
    monkeypatch.setattr(ds, '_twse_holidays', lambda y: None)
    assert ds.is_twse_trading_day(date(2026, 10, 7)) is None


def test_build_diff_rows_skips_cash_lines():
    """現金類科目（stockid 空白）不算持股異動；股票照常比。"""
    def h(sid, name, q):
        return {'stockid': sid, 'stockname': name, 'qshare': q, 'mvalue': q * 10.0, 'prate_addaccint': 1.0}
    base = [h('', '應付買回款(NTD)', 5), h('', '扣除應付買入證券款後現金餘額(USD)', 9), h('JPM US', 'JPMORGAN', 200)]
    cmp_ = [h('', '扣除應付買入證券款後現金餘額(USD)', 3), h('JPM US', 'JPMORGAN', 100)]
    rows = ds.build_diff_rows(base, cmp_)
    assert [r['stockid'] for r in rows] == ['JPM US']


# ── 颱風假：臨時休市不在 holidaySchedule，今天要靠 MIS 補判 ──

def _patch_calendar(monkeypatch, *, fmtqik=frozenset(), holidays=frozenset(), mis=None):
    monkeypatch.setattr(ds, '_twse_trading_days', lambda y, m: set(fmtqik))
    monkeypatch.setattr(ds, '_twse_holidays', lambda y: set(holidays))
    monkeypatch.setattr(ds, '_mis_last_session_date', lambda: mis)


def test_closed_today_by_mis_typhoon(monkeypatch):
    """2026-10-23 颱風休市：14:00 時 MIS 最近交易日仍是 10/22 → 判休市。"""
    _patch_calendar(monkeypatch, mis=date(2026, 10, 22))
    now = datetime(2026, 10, 23, 14, 0, tzinfo=ds.TZ)
    assert ds._closed_today_by_mis(date(2026, 10, 23), now) is True


def test_closed_today_by_mis_before_open_is_unknown(monkeypatch):
    """開盤前 MIS 本來就停在前一交易日，不能拿來判休市。"""
    _patch_calendar(monkeypatch, mis=date(2026, 10, 22))
    now = datetime(2026, 10, 23, 8, 30, tzinfo=ds.TZ)
    assert ds._closed_today_by_mis(date(2026, 10, 23), now) is False


def test_closed_today_by_mis_open_or_unreachable(monkeypatch):
    now = datetime(2026, 10, 27, 14, 0, tzinfo=ds.TZ)
    _patch_calendar(monkeypatch, mis=date(2026, 10, 27))
    assert ds._closed_today_by_mis(date(2026, 10, 27), now) is False
    _patch_calendar(monkeypatch, mis=None)
    assert ds._closed_today_by_mis(date(2026, 10, 27), now) is False


def test_closed_today_by_mis_only_for_today(monkeypatch):
    _patch_calendar(monkeypatch, mis=date(2026, 10, 22))
    now = datetime(2026, 10, 27, 14, 0, tzinfo=ds.TZ)
    assert ds._closed_today_by_mis(date(2026, 10, 28), now) is False


def test_is_twse_trading_day_holiday_schedule(monkeypatch):
    """10/26 光復節補假列在 holidaySchedule → False（不必等 MIS）。"""
    _patch_calendar(monkeypatch, holidays={date(2026, 10, 26)}, mis=None)
    monkeypatch.setattr(ds, '_closed_today_by_mis', lambda d, now=None: False)
    assert ds.is_twse_trading_day(date(2026, 10, 26)) is False


def test_is_twse_trading_day_today_uses_mis(monkeypatch):
    _patch_calendar(monkeypatch)
    monkeypatch.setattr(ds, '_closed_today_by_mis', lambda d, now=None: True)
    assert ds.is_twse_trading_day(date(2099, 10, 23)) is False
    monkeypatch.setattr(ds, '_closed_today_by_mis', lambda d, now=None: False)
    assert ds.is_twse_trading_day(date(2099, 10, 23)) is True
