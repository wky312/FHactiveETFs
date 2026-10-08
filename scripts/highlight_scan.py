#!/usr/bin/env python3
"""每日行銷亮點引擎：掃描基金（預設 00991A，FUND_TICKER 可切 00409A）相關數據 → 規則 R1-R5 → LINE 推播（內部素材）。

設計文件：docs/03-features/001-daily-highlight-engine/design.md
輸出僅 LINE 個人推播＋data/highlights/ JSON 存檔，一律不接前端路由。
"""

import json
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

import requests

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, SCRIPT_DIR)

from daily_summary import TZ, get_with_retry, is_twse_trading_day, fetch_holdings  # noqa: E402

CONFIG_PATH = os.path.join(ROOT, 'config', 'highlight_thresholds.json')
PROFILES_PATH = os.path.join(ROOT, 'config', 'highlight_profiles.json')

SITE = 'https://fhactiveetf.vercel.app'
FUND_TICKER = os.environ.get('FUND_TICKER', '00991A')


def _load_profile(ticker):
    with open(PROFILES_PATH, encoding='utf-8') as f:
        profiles = json.load(f)
    if ticker not in profiles:
        sys.exit(f'ERROR: no profile for FUND_TICKER={ticker} in {PROFILES_PATH}')
    return profiles[ticker]


MARKET_SCOPE = os.environ.get('MARKET_SCOPE', '')
PROFILE = _load_profile(f'{FUND_TICKER}:{MARKET_SCOPE}' if MARKET_SCOPE else FUND_TICKER)

# 個股所屬市場（依復華 stockid 的彭博後綴；台股是裸碼）。market_filter 用它切分「美股 / 台日韓」兩份亮點。
_US_SUFFIX = {'US', 'UW', 'UN', 'UA'}
_ASIA_SUFFIX = {'JP', 'JT', 'KS', 'KP', 'TT'}


def _market_of(stockid):
    parts = str(stockid).strip().split(' ')
    if len(parts) == 1:
        return 'asia'  # 裸碼＝台股
    if parts[-1] in _US_SUFFIX:
        return 'us'
    if parts[-1] in _ASIA_SUFFIX:
        return 'asia'
    return 'other'


def _in_scope(stockid):
    flt = PROFILE.get('market_filter')
    return flt is None or _market_of(stockid) == flt

HOLDINGS_PATH = os.path.join(ROOT, 'data', 'holdings', PROFILE['holdings_file'])
# 每檔基金各自一份輸出與去重狀態（pushed_dates 不可共用，否則一檔推過另一檔就被擋）
OUT_DIR = os.path.normpath(os.path.join(ROOT, 'data', 'highlights', PROFILE['out_subdir']))
STATE_PATH = os.path.join(OUT_DIR, '_state.json')

LINE_CHANNEL_TOKEN = os.environ.get('LINE_CHANNEL_TOKEN', '')
LINE_TO = os.environ.get('LINE_TO', '')
SUPABASE_URL = os.environ.get('SUPABASE_URL', '')
SUPABASE_SERVICE_KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
ATTR_SUPABASE_URL = os.environ.get('ATTR_SUPABASE_URL', '')
ATTR_SUPABASE_ANON_KEY = os.environ.get('ATTR_SUPABASE_ANON_KEY', '')
DRY_RUN = os.environ.get('DRY_RUN') == '1'
FORCE_RESEND = os.environ.get('FORCE_RESEND') in ('1', 'true')


# ── Config / State ────────────────────────────────────────────────────────────

def load_config(path=CONFIG_PATH):
    if not os.path.exists(path):
        sys.exit(f'ERROR: config not found: {path}')
    with open(path, encoding='utf-8') as f:
        cfg = json.load(f)
    for section, patch in PROFILE.get('cfg_overrides', {}).items():
        cfg[section] = {**cfg.get(section, {}), **patch}
    return cfg


@dataclass
class DedupState:
    pushed_dates: list = field(default_factory=list)
    r3_events: dict = field(default_factory=dict)     # "{stockid}|{event_date}" -> {direction, tier_pushed}
    r4_rank: dict = field(default_factory=dict)       # {"mtd": {period, last_rank}, "ytd": {...}}
    r4_new_high: dict = field(default_factory=dict)   # {"last_high_date": "YYYY-MM-DD"}
    r5_aum_milestones: list = field(default_factory=list)
    r5_last_data_date: str = ''   # R5 已推播過的最新資料日（申贖入庫比掃描晚一天，按資料日去重）


def load_state(path=None) -> DedupState:
    path = path or STATE_PATH
    if not os.path.exists(path):
        return DedupState()
    try:
        with open(path, encoding='utf-8') as f:
            raw = json.load(f)
        return DedupState(
            pushed_dates=raw.get('pushed_dates', []),
            r3_events=raw.get('r3_events', {}),
            r4_rank=raw.get('r4_rank', {}),
            r4_new_high=raw.get('r4_new_high', {}),
            r5_aum_milestones=raw.get('r5_aum_milestones', []),
            r5_last_data_date=raw.get('r5_last_data_date', ''),
        )
    except Exception:
        return DedupState()


def save_state(state: DedupState, path=None):
    path = path or STATE_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({
            'updated_at': datetime.now(TZ).isoformat(timespec='seconds'),
            'pushed_dates': state.pushed_dates,
            'r3_events': state.r3_events,
            'r4_rank': state.r4_rank,
            'r4_new_high': state.r4_new_high,
            'r5_aum_milestones': state.r5_aum_milestones,
            'r5_last_data_date': state.r5_last_data_date,
        }, f, ensure_ascii=False, indent=2)


def prune_state(state: DedupState, holdings_days: list):
    window = set(holdings_days[-40:])  # 保留窗大於 20 交易日，避免時區/補資料邊界誤刪
    state.r3_events = {
        k: v for k, v in state.r3_events.items()
        if k.split('|', 1)[1] in window
    }
    state.pushed_dates = state.pushed_dates[-60:]


# ── Data access（每函式獨立失敗，回 None）─────────────────────────────────────

def _postgrest(base_url, key, path_query, timeout=30):
    r = get_with_retry(
        f'{base_url}/rest/v1/{path_query}',
        headers={'apikey': key, 'Authorization': f'Bearer {key}'},
        timeout=timeout,
    )
    r.raise_for_status()
    return r.json()


def fetch_own_holdings_history(today: date):
    """存檔＋live top-up。回 ({names, days}, status)；status: ok|stale|fail。"""
    try:
        with open(HOLDINGS_PATH, encoding='utf-8') as f:
            data = json.load(f)
        if not data.get('days'):
            return None, 'fail'
    except Exception:
        return None, 'fail'

    today_key = today.strftime('%Y/%m/%d')
    if today_key in data['days']:
        return data, 'ok'
    live = fetch_holdings(today_key, data.get('fundId', 'ETF23'))
    if live and live.get('holdings') and live.get('date') == today_key:
        total_m = sum(h['mvalue'] for h in live['holdings']) or 1
        data['days'][today_key] = [
            {'c': h['stockid'], 'q': h['qshare'], 'm': h['mvalue'],
             'p': h['prate_addaccint'] or round(h['mvalue'] / total_m * 100, 3)}
            for h in live['holdings'] if h['stockid']
        ]
        for h in live['holdings']:
            data.setdefault('names', {}).setdefault(h['stockid'], h['stockname'])
        return data, 'ok'
    return data, 'stale'


def fetch_tw_active_universe():
    try:
        rows = _postgrest(ATTR_SUPABASE_URL, ATTR_SUPABASE_ANON_KEY,
                          'etf?select=ticker,name&market=eq.tw&type=eq.equity')
        tickers = [r['ticker'] for r in rows]
        return tickers if tickers else None
    except Exception as e:
        print(f'  universe fetch error: {e}')
        return None


def fetch_cross_fund_holdings(tickers, as_of: date, lookback_days=15):
    """各檔基金最新持股快照 {ticker: {'date':…, 'w': {stockid: prate}}}。"""
    try:
        since = (as_of - timedelta(days=lookback_days)).isoformat()
        in_list = ','.join(f'"{t}"' for t in tickers)
        rows, offset = [], 0
        while True:
            page = _postgrest(
                ATTR_SUPABASE_URL, ATTR_SUPABASE_ANON_KEY,
                f'holding?select=ticker,date,stockid,prate&ticker=in.({in_list})'
                f'&date=gte.{since}&order=date.desc&limit=10000&offset={offset}')
            rows.extend(page)
            if len(page) < 10000:
                break
            offset += 10000
        snap = {}
        for r in rows:
            t = r['ticker']
            if t not in snap:
                snap[t] = {'date': r['date'], 'w': {}}
            if r['date'] == snap[t]['date']:
                snap[t]['w'][str(r['stockid'])] = float(r['prate'] or 0)
        return snap if snap else None
    except Exception as e:
        print(f'  cross holdings fetch error: {e}')
        return None


def fetch_stock_quotes(stockids):
    """TWSE MIS 批次即時報價 {stockid: {'pct':…, 'price':…}}；缺漏逐檔 yfinance。"""
    out = {}
    try:
        ex_ch = '|'.join(f'{m}_{c}.tw' for c in stockids for m in ('tse', 'otc'))
        r = get_with_retry(
            f'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch={ex_ch}&json=1&delay=0',
            headers={'User-Agent': 'Mozilla/5.0'}, timeout=15)
        for row in (r.json().get('msgArray') or []):
            c = row.get('c')
            z, y = row.get('z', '-'), row.get('y', '-')
            if not c or z in ('-', '', None) or y in ('-', '', None):
                continue
            z, y = float(z), float(y)
            if y > 0:
                out[c] = {'pct': round((z - y) / y * 100, 2), 'price': z}
    except Exception as e:
        print(f'  MIS quotes error: {e}')
    missing = [c for c in stockids if c not in out]
    if missing:
        try:
            import yfinance as yf
            for c in missing:
                for suffix in ('.TW', '.TWO'):
                    try:
                        h = yf.Ticker(c + suffix).history(period='5d')
                        if len(h) >= 2:
                            prev, cur = h['Close'].iloc[-2], h['Close'].iloc[-1]
                            out[c] = {'pct': round((cur - prev) / prev * 100, 2),
                                      'price': float(cur)}
                            break
                    except Exception:
                        continue
        except Exception:
            pass
    return out if out else None


# 彭博交易所後綴 → Yahoo 後綴（與 lib/exchangeMap.ts 同步；' CH' 滬深另判）
_BBG_TO_YF = {
    'US': '', 'UW': '', 'UN': '', 'UA': '', 'LN': '.L', 'HK': '.HK',
    'JP': '.T', 'JT': '.T', 'GY': '.DE', 'GR': '.DE', 'FP': '.PA', 'AU': '.AX',
    'SM': '.MC', 'IM': '.MI', 'NA': '.AS', 'SW': '.SW', 'DC': '.CO', 'NO': '.OL',
    'SS': '.ST', 'SE': '.ST', 'SP': '.SI', 'KS': '.KS', 'KP': '.KS', 'TT': '.TW',
    'IN': '.NS', 'IB': '.BO', 'SJ': '.JO', 'BZ': '.SA', 'CN': '.TO', 'CT': '.TO',
}


def yf_candidates(stockid):
    """復華 stockid → 依序嘗試的 Yahoo 代號。台股是裸 4 碼（試 .TW 再 .TWO），
    外國股是「代碼 空格 兩碼交易所」（'NVDA US'、'000660 KS'、'6857 JP'）。"""
    sid = str(stockid).strip()
    m = re.match(r'^(.+?)\s+([A-Z]{2})$', sid)
    if not m:
        return [sid + '.TW', sid + '.TWO']
    base, ex = m.groups()
    base = base.rstrip('/').replace('/', '-')
    if ex == 'CH':  # 6 開頭＝上海、其餘＝深圳
        return [base + ('.SS' if base.startswith('6') else '.SZ')]
    suffix = _BBG_TO_YF.get(ex)
    return [] if suffix is None else [base + suffix]


def make_yf_fetchers(with_hist=False):
    """回 (px_on, px_latest, high60) 三個 callable；個股失敗回 None 不拋。
    with_hist=True 時多回第 4 個 callable：個股日 K 線 DataFrame（報價判斷用）。"""
    import yfinance as yf
    cache = {}

    def _hist(stockid):
        if stockid not in cache:
            h = None
            for cand in yf_candidates(stockid):
                try:
                    got = yf.Ticker(cand).history(period='6mo')
                    if len(got) > 0:
                        h = got
                        break
                except Exception:
                    continue
            cache[stockid] = h
        return cache[stockid]

    def px_on(stockid, d: date):
        h = _hist(stockid)
        if h is None:
            return None
        sel = h[h.index.date <= d]
        return float(sel['Close'].iloc[-1]) if len(sel) else None

    def px_latest(stockid):
        h = _hist(stockid)
        return float(h['Close'].iloc[-1]) if h is not None and len(h) else None

    def high60(stockid):
        h = _hist(stockid)
        if h is None or len(h) < 2:
            return None
        closes = h['Close'].iloc[:-1]
        return float(closes.tail(60).max()) if len(closes) else None

    if with_hist:
        return px_on, px_latest, high60, _hist
    return px_on, px_latest, high60


def fetch_quotes_yf(stockids, hist_fn, session_date: date):
    """全球持股報價：最後一根日 K 的日期必須等於 session_date 才算當日有交易
    （該市場休市時最後一根是更早的日期，就當沒有報價，避免把舊漲跌幅當今日）。
    回 {stockid: {'pct','price'}}；所有個股都抓不到歷史（Yahoo 掛了）回 None。"""
    out, reachable = {}, False
    for c in stockids:
        h = hist_fn(c)
        if h is None or len(h) < 2:
            continue
        reachable = True
        if h.index[-1].date() != session_date:
            continue
        prev, cur = float(h['Close'].iloc[-2]), float(h['Close'].iloc[-1])
        if prev > 0:
            out[c] = {'pct': round((cur - prev) / prev * 100, 2), 'price': cur}
    return out if reachable else None


def _xid(stockid):
    """跨基金比對用的代碼：去掉彭博交易所後綴（'NVDA US' → 'NVDA'；台股裸碼不變）。"""
    return str(stockid).split(' ')[0]


def fetch_cross_from_repo(files: dict, as_of: date, lookback_days=15):
    """從 repo 的 data/holdings 存檔組同業最新持股快照（ATTR 資料庫沒有海外檔時用）。
    回 {ticker: {'date': 'YYYY-MM-DD', 'w': {xid: prate}}}；太舊（>lookback_days）的同業略過。"""
    snap = {}
    for ticker, fname in files.items():
        try:
            with open(os.path.join(ROOT, 'data', 'holdings', fname), encoding='utf-8') as f:
                d = json.load(f)
            keys = sorted(d['days'])
            if not keys:
                continue
            last = keys[-1]
            last_d = datetime.strptime(last, '%Y/%m/%d').date()
            if (as_of - last_d).days > lookback_days and ticker != FUND_TICKER:
                continue
            w = {}
            for h in d['days'][last]:
                w[_xid(h['c'])] = w.get(_xid(h['c']), 0) + float(h.get('p') or 0)
            snap[ticker] = {'date': last_d.isoformat(), 'w': w}
        except Exception as e:
            print(f'  cross file {fname} error: {e}')
    return snap if snap else None


def fetch_site_peer_performance(group='active'):
    try:
        r = get_with_retry(f'{SITE}/api/peer-performance?group={group}',
                           timeout=30, attempts=2)
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, list) and data else None
    except Exception as e:
        print(f'  peer-performance error: {e}')
        return None


def fetch_site_cumulative_return(tickers, start, end, group='active'):
    try:
        r = get_with_retry(
            f'{SITE}/api/cumulative-return?group={group}&tickers={tickers}'
            f'&startDate={start}&endDate={end}', timeout=30, attempts=2)
        r.raise_for_status()
        data = r.json()
        return data if data.get('dates') and data.get('series') else None
    except Exception as e:
        print(f'  cumulative-return error: {e}')
        return None


def fetch_peer_redemption_history(start: date, end: date, group='tw_active'):
    try:
        rows = _postgrest(
            SUPABASE_URL, SUPABASE_SERVICE_KEY,
            f'peer_redemption?select=date,ticker,net_sub,aum&group=eq.{group}'
            f'&date=gte.{start.isoformat()}&date=lte.{end.isoformat()}&order=date.asc')
        return rows if rows else None
    except Exception as e:
        print(f'  peer_redemption error: {e}')
        return None


# ── Context ───────────────────────────────────────────────────────────────────

@dataclass
class ScanContext:
    today: date = None
    own: dict = None                # {names, days}
    own_days_sorted: list = None
    universe: list = None
    cross: dict = None
    quotes: dict = None             # {stockid: {pct, price}}
    px_on: object = None
    px_latest: object = None
    high60: object = None
    peer_perf: list = None
    cumret: dict = None
    redemption: list = None
    hist: object = None             # 個股日 K 線 callable（全球版文案算進場成本用）


def build_context(today: date, cfg):
    ctx = ScanContext(today=today)
    status = {}

    ctx.own, status['own_holdings'] = fetch_own_holdings_history(today)
    ctx.own_days_sorted = sorted(ctx.own['days'].keys()) if ctx.own else []

    if PROFILE['cross_source'] == 'repo':
        ctx.cross = fetch_cross_from_repo(PROFILE['cross_files'], today)
        ctx.universe = list(ctx.cross) if ctx.cross else None
    else:
        ctx.universe = fetch_tw_active_universe()
        if ctx.universe:
            ctx.cross = fetch_cross_fund_holdings(ctx.universe, today)
    status['attr_supabase'] = 'ok' if (ctx.universe and ctx.cross) else 'fail'

    top_ids = []
    if ctx.own and ctx.own_days_sorted:
        latest = ctx.own['days'][ctx.own_days_sorted[-1]]
        top_ids = [h['c'] for h in sorted(latest, key=lambda x: -x['p'])
                   if _in_scope(h['c'])][:30]

    if PROFILE['quote_source'] == 'yahoo':
        # 全球型：報價一律走 Yahoo（台/美/日/韓），用同一份日 K 快取供 R2/R3 重複使用。
        # status 鍵沿用 'twse_mis'（= 報價來源狀態），RULES 的依賴宣告不用改。
        try:
            ctx.px_on, ctx.px_latest, ctx.high60, hist_fn = make_yf_fetchers(with_hist=True)
            ctx.hist = hist_fn
            quote_ids = top_ids
            now = datetime.now(TZ)
            if today == now.date() and (now.hour, now.minute) < (14, 45):
                # 日/韓股台北 14:30 才收盤；之前 Yahoo 的當日 K 棒還是盤中價，不能當收盤漲跌幅
                quote_ids = [c for c in top_ids if _market_of(c) != 'asia' or ' ' not in c]
            ctx.quotes = fetch_quotes_yf(quote_ids, hist_fn, today)
            status['twse_mis'] = 'ok' if ctx.quotes is not None else 'fail'
            status['yahoo'] = 'ok' if ctx.quotes is not None else 'fail'
        except Exception:
            status['twse_mis'] = status['yahoo'] = 'fail'
    else:
        if top_ids:
            ctx.quotes = fetch_stock_quotes(top_ids)
        status['twse_mis'] = 'ok' if ctx.quotes else 'fail'
        try:
            ctx.px_on, ctx.px_latest, ctx.high60 = make_yf_fetchers()
            status['yahoo'] = 'ok' if ctx.px_latest('0050') is not None else 'fail'
        except Exception:
            status['yahoo'] = 'fail'

    ctx.peer_perf = fetch_site_peer_performance(PROFILE['peer_perf_group'])
    status['site_peer_performance'] = 'ok' if ctx.peer_perf else 'fail'

    bench = cfg['r4'].get('benchmark_ticker')
    ctx.cumret = fetch_site_cumulative_return(
        f'{FUND_TICKER},{bench}' if bench else FUND_TICKER,
        '2020-01-01', today.isoformat(), PROFILE['cumret_group'])
    status['site_cumulative_return'] = 'ok' if ctx.cumret else 'fail'

    ctx.redemption = fetch_peer_redemption_history(
        today - timedelta(days=90), today, cfg['r5']['peer_group'])
    status['peer_redemption'] = 'ok' if ctx.redemption else 'fail'

    return ctx, status


# ── Rule engine ───────────────────────────────────────────────────────────────

@dataclass
class Candidate:
    id: str
    rule: str
    score: float
    fact: str
    angle: str
    draft: str
    data: dict
    state_patch: dict = None


def _name(ctx, stockid):
    return (ctx.own or {}).get('names', {}).get(stockid, stockid)


def _own_weights(ctx):
    """{stockid: p} of latest own snapshot."""
    if not ctx.own_days_sorted:
        return {}
    return {h['c']: h['p'] for h in ctx.own['days'][ctx.own_days_sorted[-1]]}


def _md(key):
    """'2026/08/25' → '8/25'"""
    d = datetime.strptime(key, '%Y/%m/%d')
    return f'{d.month}/{d.day}'


def holding_story(ctx, stockid):
    """全球版文案的基金面敘述：進場/加碼時間軸、持有張數、占淨值、近似成本報酬。

    - 目前這段持有的起點＝最後一次由 0 轉正的那天（中途清倉再買進＝「重新建倉」）。
    - 加碼＝起點之後持股數增加的日子；減碼不寫（對外素材只講進場判斷）。
    - 成本：每次買進量以「進場日 OHLC 四價平均」估（日 K 無法取得 VWAP，實測與同事手算
      MRVL +17.8%/ALAB +10.1% 差 0.1~0.2 個百分點）；現價用掃描日收盤。
    資料不足回 None（呼叫端退回簡短文案）。"""
    if not ctx.own or not ctx.own_days_sorted:
        return None
    rows = []
    for k in ctx.own_days_sorted:
        h = next((x for x in ctx.own['days'][k] if x['c'] == stockid), None)
        rows.append((k, h['q'] if h else 0, h['p'] if h else 0))
    if rows[-1][1] <= 0:
        return None
    i = len(rows) - 1
    while i > 0 and rows[i - 1][1] > 0:
        i -= 1
    entry_key = rows[i][0]
    reentry = any(r[1] > 0 for r in rows[:i])  # 之前持有過、中途清倉才算重新建倉
    buys, adds = [(entry_key, rows[i][1])], []
    for (_, q0, _p0), (k1, q1, _p1) in zip(rows[i:], rows[i + 1:]):
        if q1 > q0:
            buys.append((k1, q1 - q0))
            adds.append(k1)
    last_key, last_q, last_w = rows[-1]

    text = f'{FUND_TICKER} ' + (f'最近於 {_md(entry_key)} 重新建倉' if reentry
                                else f'自 {_md(entry_key)} 首次買進')
    if adds:
        text += '，並於 ' + '、'.join(_md(k) for k in adds[-4:]) + ' 加碼'
    text += f'；截至 {_md(last_key)} 持有 {last_q / 1000:g} 張、占淨值 {round(last_w, 3):g}%'

    q = (ctx.quotes or {}).get(stockid)
    if ctx.hist and q:
        try:
            h = ctx.hist(stockid)
            if h is not None and len(h):
                ohlc4 = (h['Open'] + h['High'] + h['Low'] + h['Close']) / 4
                cost_sum = qty_sum = 0.0
                for k, n in buys:
                    px = float(ohlc4.loc[:datetime.strptime(k, '%Y/%m/%d').strftime('%Y-%m-%d')].iloc[-1])
                    cost_sum += px * n
                    qty_sum += n
                if qty_sum and cost_sum:
                    ret = (q['price'] / (cost_sum / qty_sum) - 1) * 100
                    text += f'，報酬約 {ret:+.1f}%'
        except Exception:
            pass
    return text + '。'


def _story_draft(ctx, stockid, name, pct):
    """同事寫法：『昨日 X（代碼）上漲約 N%。』＋ 基金進場/加碼/持有/報酬敘述。"""
    story = holding_story(ctx, stockid) or f'{FUND_TICKER} 持有 {name}。'
    pct_txt = f'上漲約 {pct:g}%' if pct is not None else '創 60 日新高'
    return f'{PROFILE["day_word"]} {name}（{_xid(stockid)}）{pct_txt}。\n{story}'


def rule_r1(ctx, cfg):
    c1 = cfg['r1']
    out = []
    weights = {k: v for k, v in _own_weights(ctx).items() if _in_scope(k)}
    top = sorted(weights.items(), key=lambda kv: -kv[1])[:c1['top_n_holdings']]
    for stockid, w in top:
        q = (ctx.quotes or {}).get(stockid)
        if not q or q['pct'] < c1['min_daily_pct']:
            continue
        heaviest, universe_size = None, None
        if ctx.cross:
            xid = _xid(stockid)
            others = [snap['w'].get(xid) for t, snap in ctx.cross.items()
                      if t != FUND_TICKER and xid in snap['w']]
            mine = ctx.cross.get(FUND_TICKER, {}).get('w', {}).get(xid, w)
            heaviest = all(mine >= o for o in others) if others else True
            universe_size = len(ctx.cross)
        name = _name(ctx, stockid)
        w = round(w, 2)
        heavy_txt = (f'、為{PROFILE["universe_fact"].format(n=universe_size)}中持有最重'
                     if heaviest else '')
        out.append(Candidate(
            id=f'R1-{stockid}-{ctx.today.isoformat()}', rule='R1',
            score=round(q['pct'] * w, 2),
            fact=f'{name}{PROFILE["day_word"]} +{q["pct"]}%，{FUND_TICKER} 持股 {w}%{heavy_txt}',
            angle='重倉命中：主動選股的含金量',
            draft=(_story_draft(ctx, stockid, name, q['pct']) if PROFILE.get('story') else
                   f'{name}大漲 {q["pct"]}%，{FUND_TICKER} 以 {w}% 持股'
                   + (f'居{PROFILE["universe_short"]}之冠，' if heaviest else '重倉布局，')
                   + '經理人重押命中。'),
            data={'stockid': stockid, 'pct_change': q['pct'], 'weight_pct': w,
                  'is_heaviest_among_universe': heaviest,
                  'universe_size': universe_size}))
    return out


def rule_r2(ctx, cfg):
    c2 = cfg['r2']
    out = []
    if not ctx.cross or FUND_TICKER not in ctx.cross:
        return out
    mine = ctx.cross[FUND_TICKER]['w']
    # cross 的 key 可能是去後綴的 xid（repo 模式）；報價/名稱要用持股存檔的原始代碼查
    raw_by_xid = {_xid(c): c for c in _own_weights(ctx)}
    for key, w in mine.items():
        stockid = raw_by_xid.get(key, key)
        if not _in_scope(stockid):
            continue
        others = [snap['w'][key] for t, snap in ctx.cross.items()
                  if t != FUND_TICKER and key in snap['w']]
        exclusive = not others
        overweight = (others and w >= c2['overweight_multiple'] * max(others)
                      and w >= c2['overweight_min_weight_pct'])
        if not exclusive and not overweight:
            continue
        q = (ctx.quotes or {}).get(stockid)
        pct = q['pct'] if q else None
        new_high = False
        if ctx.high60 and q:
            h60 = ctx.high60(stockid)
            new_high = h60 is not None and q['price'] >= h60
        if (pct is None or pct < c2['min_daily_pct']) and not new_high:
            continue
        kind = '獨門' if exclusive else '顯著超配'
        w = round(w, 2)
        eff_pct = pct if (pct or 0) >= c2['min_daily_pct'] else c2['min_daily_pct']
        score = eff_pct * w * (c2['exclusive_score_multiplier'] if exclusive else 1.0)
        event = f'{PROFILE["day_word"]} +{pct}%' if (pct or 0) >= c2['min_daily_pct'] else f'創 {c2["new_high_lookback_days"]} 日新高'
        name = _name(ctx, stockid)
        out.append(Candidate(
            id=f'R2-{stockid}-{ctx.today.isoformat()}', rule='R2',
            score=round(score, 2),
            fact=f'{kind}持股 {name}{event}（{FUND_TICKER} 權重 {w}%，{PROFILE["others_label"]} '
                 f'{"皆未持有" if exclusive else "最高僅 " + str(round(max(others), 2)) + "%"}）',
            angle=f'{kind}股發威：別人沒有的上漲',
            draft=(_story_draft(ctx, stockid, name, pct if (pct or 0) >= c2['min_daily_pct'] else None)
                   if PROFILE.get('story') else
                   f'{name}{event}——這檔是 {FUND_TICKER} 的{kind}持股（{w}%），'
                   f'{PROFILE["universe_short"] + "只有復華布局" if exclusive else "布局深度遠超同業"}。'),
            data={'stockid': stockid, 'pct_change': pct, 'weight_pct': w,
                  'exclusive': exclusive, 'new_high': new_high,
                  'others_max_weight': round(max(others), 3) if others else None}))
    return out


def _r3_events(ctx, cfg):
    """從存檔相鄰日找加減碼事件 [(stockid, event_date_key, direction, dq_pct, weight)]。"""
    c3 = cfg['r3']
    days = ctx.own_days_sorted
    window = days[-(c3['lookback_trading_days'] + 1):]
    events = []
    for prev_key, cur_key in zip(window, window[1:]):
        prev = {h['c']: h for h in ctx.own['days'][prev_key]}
        cur = {h['c']: h for h in ctx.own['days'][cur_key]}
        for stockid in set(prev) | set(cur):
            pq = prev.get(stockid, {}).get('q', 0)
            cq = cur.get(stockid, {}).get('q', 0)
            if pq <= 0 and cq <= 0:
                continue
            base = pq if pq > 0 else cq
            if pq > 0 and abs(cq - pq) / pq * 100 < c3['min_qty_change_pct']:
                continue
            if pq <= 0 < cq:
                pass  # 首次建倉視為加碼事件
            # 權重門檻取事件前後較大者，清倉（cur=0）才不會被自身歸零排除
            w = max(prev.get(stockid, {}).get('p', 0), cur.get(stockid, {}).get('p', 0))
            if w < c3['min_weight_pct']:
                continue
            direction = 'add' if cq > pq else 'trim'
            events.append((stockid, cur_key, direction,
                           round((cq - pq) / base * 100, 1), w))
    return events


def rule_r3(ctx, cfg, state: DedupState):
    c3 = cfg['r3']
    out = []
    if not ctx.px_on or not ctx.px_latest:
        return out
    for stockid, event_key, direction, dq_pct, w in _r3_events(ctx, cfg):
        if not _in_scope(stockid):
            continue
        event_d = datetime.strptime(event_key, '%Y/%m/%d').date()
        p0 = ctx.px_on(stockid, event_d)
        p1 = ctx.px_latest(stockid)
        if not p0 or not p1:
            continue
        ret = (p1 - p0) / p0 * 100
        hit = None
        for tier in sorted(c3['tiers_pct']):
            if (direction == 'add' and ret >= tier) or (direction == 'trim' and ret <= -tier):
                hit = tier
        if hit is None:
            continue
        key = f'{stockid}|{event_key}'
        if state.r3_events.get(key, {}).get('tier_pushed', 0) >= hit:
            continue
        name = _name(ctx, stockid)
        md = f'{event_d.month}/{event_d.day}'
        if direction == 'add':
            fact = f'{md} 加碼的 {name} 至今 +{round(ret, 1)}%'
            angle = '操作驗證：加碼點位精準'
            draft = f'經理人 {md} 加碼{name}，至今上漲 {round(ret, 1)}%，展現主動管理的判斷力。'
        else:
            fact = f'{md} 減碼 {name}，其後回跌 {abs(round(ret, 1))}%'
            angle = '操作驗證：減碼躲過回檔'
            draft = f'經理人 {md} 提前減碼{name}，隨後該股回跌 {abs(round(ret, 1))}%，成功避開損失。'
        out.append(Candidate(
            id=f'R3-{stockid}-{event_key.replace("/", "")}-t{hit}', rule='R3',
            score=round(abs(ret) * cfg['scoring']['r3_multiplier'], 2),
            fact=fact, angle=angle, draft=draft,
            data={'stockid': stockid, 'event_date': event_d.isoformat(),
                  'direction': direction, 'qty_change_pct': dq_pct,
                  'weight_pct': w, 'return_since_pct': round(ret, 2), 'tier': hit},
            state_patch={'r3': {key: {'direction': direction, 'tier_pushed': hit}}}))
    # 同一檔股票同方向只留最佳事件，避免相鄰日連續加碼洗版
    best = {}
    for c in out:
        k = (c.data['stockid'], c.data['direction'])
        if k not in best or c.score > best[k].score:
            best[k] = c
    return list(best.values())


def _daily_returns(dates, pct):
    rets = {}
    for i in range(1, len(dates)):
        if pct[i] is None or pct[i - 1] is None:
            continue
        rets[dates[i]] = (1 + pct[i] / 100) / (1 + pct[i - 1] / 100) - 1
    return rets


def rule_r4(ctx, cfg, state: DedupState):
    c4 = cfg['r4']
    sc = cfg['scoring']
    out = []
    today_iso = ctx.today.isoformat()

    if ctx.cumret:
        dates = ctx.cumret['dates']
        series = {s['ticker']: s['pct'] for s in ctx.cumret['series']}
        bench_t = c4.get('benchmark_ticker')  # None＝此基金沒有可辯護的對標，不做連勝
        mine = series.get(FUND_TICKER)
        bench = series.get(bench_t) if bench_t else None
        if mine and bench:
            r_m = _daily_returns(dates, mine)
            r_b = _daily_returns(dates, bench)
            streak = 0
            for d in reversed(dates[1:]):
                if d in r_m and d in r_b and r_m[d] > r_b[d]:
                    streak += 1
                else:
                    break
            if streak in c4['streak_days']:
                out.append(Candidate(
                    id=f'R4-streak{streak}-{today_iso}', rule='R4',
                    score=round(streak * sc['r4_streak_multiplier'], 2),
                    fact=f'{FUND_TICKER} 連續 {streak} 個交易日報酬勝過 {bench_t}',
                    angle='主動 vs 被動：連勝進行中',
                    draft=f'{FUND_TICKER} 已連續 {streak} 個交易日打敗 {bench_t}，'
                          '主動選股的超額報酬正在累積。',
                    data={'streak_days': streak}))
        if mine:
            valid = [(d, p) for d, p in zip(dates, mine) if p is not None]
            if len(valid) >= 2 and valid[-1][1] > max(p for _, p in valid[:-1]):
                last_push = state.r4_new_high.get('last_high_date')
                cooled = True
                if last_push:
                    between = [d for d, _ in valid if last_push < d <= valid[-1][0]]
                    cooled = len(between) >= c4['new_high_cooldown_trading_days']
                if cooled:
                    out.append(Candidate(
                        id=f'R4-newhigh-{today_iso}', rule='R4',
                        score=sc['r4_new_high_score'],
                        fact=f'{FUND_TICKER} 含息累積報酬 +{round(valid[-1][1], 1)}%，創上市以來新高',
                        angle='績效里程碑：歷史新高',
                        draft=f'{FUND_TICKER} 含息累積報酬達 {round(valid[-1][1], 1)}%，'
                              '改寫上市以來新高。',
                        data={'cum_return_pct': round(valid[-1][1], 2)},
                        state_patch={'r4_new_high': {'last_high_date': valid[-1][0]}}))

    if ctx.peer_perf:
        for kind, pct_key, period in (
                ('mtd', 'pctMTD', ctx.today.strftime('%Y-%m')),
                ('ytd', 'pctYTD', str(ctx.today.year))):
            rows = [r for r in ctx.peer_perf
                    if re.match(r'^\d{5}A$', str(r.get('ticker', '')))
                    and r.get(pct_key) is not None and not r.get('anomaly')]
            rows.sort(key=lambda r: -r[pct_key])
            rank = next((i + 1 for i, r in enumerate(rows)
                         if r['ticker'] == FUND_TICKER), None)
            if not rank or rank > c4['rank_top_n']:
                continue
            prev = state.r4_rank.get(kind, {})
            if prev.get('period') == period and prev.get('last_rank', 99) <= rank:
                continue
            label = 'MTD' if kind == 'mtd' else 'YTD'
            out.append(Candidate(
                id=f'R4-rank-{kind}{rank}-{today_iso}', rule='R4',
                score=round((c4['rank_top_n'] + 1 - rank) * sc['r4_rank_multiplier'], 2),
                fact=f'{FUND_TICKER} {label} 報酬在同業觀測群排名第 {rank}（{len(rows)} 檔）',
                angle='績效里程碑：排名領先',
                draft=f'{FUND_TICKER} {label} 績效衝上同業觀測群第 {rank} 名，主動管理實力發酵。',
                data={'kind': kind, 'rank': rank, 'universe_size': len(rows),
                      'pct': rows[rank - 1][pct_key]},
                state_patch={'r4_rank': {kind: {'period': period, 'last_rank': rank}}}))
    return out


def rule_r5(ctx, cfg, state: DedupState):
    c5 = cfg['r5']
    sc = cfg['scoring']
    out = []
    if not ctx.redemption:
        return out
    mine = [r for r in ctx.redemption if r['ticker'] == FUND_TICKER]
    if not mine:
        return out
    latest_date = mine[-1]['date']
    if latest_date <= state.r5_last_data_date:
        return out  # 該資料日已推播過（申贖 17:15 才入庫，14:00 掃描吃前一交易日，按資料日去重）
    marker = {'r5_last_data_date': latest_date}

    streak = 0
    for r in reversed(mine):
        if (r['net_sub'] or 0) > 0:
            streak += 1
        else:
            break
    if streak in c5['streak_days']:
        out.append(Candidate(
            id=f'R5-streak{streak}-{latest_date}', rule='R5',
            score=round(streak * sc['r5_streak_multiplier'], 2),
            fact=f'{FUND_TICKER} 連續 {streak} 個交易日淨申購',
            angle='資金用腳投票：買盤持續',
            draft=f'{FUND_TICKER} 連續 {streak} 個交易日獲淨申購，資金持續進場。',
            data={'streak_days': streak, 'data_date': latest_date},
            state_patch=dict(marker)))

    unit = c5['aum_milestone_billion_twd']
    today_aum = mine[-1]['aum'] or 0
    today_tier = int(today_aum // unit)
    hist_tier = max((int((r['aum'] or 0) // unit) for r in mine[:-1]), default=0)
    baseline = max([hist_tier] + [int(t) for t in state.r5_aum_milestones]) if (
        state.r5_aum_milestones or hist_tier) else hist_tier
    if today_tier > baseline and today_tier > 0:
        milestone = today_tier * unit
        out.append(Candidate(
            id=f'R5-aum{milestone}-{latest_date}', rule='R5',
            score=sc['r5_milestone_score'],
            fact=f'{FUND_TICKER} 規模首度突破 {milestone} 億元（{round(today_aum, 1)} 億）',
            angle='規模里程碑',
            draft=f'{FUND_TICKER} 基金規模正式站上 {milestone} 億元大關。',
            data={'aum_billion': round(today_aum, 2), 'milestone': milestone,
                  'data_date': latest_date},
            state_patch={'r5_aum_milestones': today_tier, **marker}))

    day_rows = [r for r in ctx.redemption if r['date'] == latest_date]
    if len(day_rows) >= 2:
        best = max(day_rows, key=lambda r: r['net_sub'] or 0)
        my_net = mine[-1]['net_sub'] or 0
        if (best['ticker'] == FUND_TICKER
                and my_net >= c5['single_day_min_billion_twd']):
            out.append(Candidate(
                id=f'R5-top1-{latest_date}', rule='R5',
                score=sc['r5_single_day_first_score'],
                fact=f'{FUND_TICKER} 單日淨申購 {round(my_net, 1)} 億元，'
                     f'觀測同業（{len(day_rows)} 檔）中第一',
                angle='資金流向：同業吸金王',
                draft=f'觀測同業中，{FUND_TICKER} 以 {round(my_net, 1)} 億元淨申購居冠。',
                data={'net_sub_billion': round(my_net, 2),
                      'peer_count': len(day_rows), 'data_date': latest_date},
                state_patch=dict(marker)))
    return out


RULES = [
    ('R1', rule_r1, ('own_holdings', 'twse_mis'), False),
    ('R2', rule_r2, ('own_holdings', 'attr_supabase', 'twse_mis'), False),
    ('R3', rule_r3, ('own_holdings', 'yahoo'), True),
    ('R4', rule_r4, (), True),   # 兩個站上來源各自 fail-soft，規則內部處理
    ('R5', rule_r5, ('peer_redemption',), True),
]


def run_rules(ctx, status, cfg, state):
    candidates, skipped = [], []
    for name, fn, needs, wants_state in RULES:
        if PROFILE.get('rules') and name not in PROFILE['rules']:
            continue
        if any(status.get(n) == 'fail' for n in needs):
            skipped.append(name)
            continue
        try:
            got = fn(ctx, cfg, state) if wants_state else fn(ctx, cfg)
            candidates.extend(got)
        except Exception as e:
            print(f'  {name} rule error: {e}')
            skipped.append(name)
    r4_enabled = not PROFILE.get('rules') or 'R4' in PROFILE['rules']
    if (r4_enabled and 'R4' not in skipped
            and status.get('site_peer_performance') == 'fail'
            and status.get('site_cumulative_return') == 'fail'):
        skipped.append('R4')
    return candidates, skipped


# ── Ranking / Message ─────────────────────────────────────────────────────────

def select_top(candidates, limit=5):
    ranked = sorted(candidates, key=lambda c: -c.score)
    return ranked[:limit], ranked[limit:]


CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩'


def build_message(selected, today: date, skipped_rules, cfg):
    m = cfg['message']
    header = f'📈 {FUND_TICKER} {PROFILE["title_word"]} {today.strftime("%Y/%m/%d")}（{len(selected)} 則）'
    blocks = []
    for i, c in enumerate(selected):
        n = CIRCLED[i] if i < len(CIRCLED) else f'{i + 1}.'
        blocks.append(f'{n} 📌 {c.fact}\n💡 {c.angle}\n✍️ 「{c.draft}」')
    note = (f'\n\n本日未掃描：{"、".join(skipped_rules)}（來源故障）'
            if skipped_rules else '')
    footer = f'\n\n{m["footer"]}'
    while blocks:
        body = header + '\n\n' + '\n\n'.join(blocks) + note + footer
        if len(body) <= m['max_chars']:
            return body
        blocks.pop()  # 超長時整條移除最低分者
    return header + note + footer


# ── LINE / Archive ────────────────────────────────────────────────────────────

def send_line_text(text):
    if DRY_RUN:
        print('--- DRY_RUN message preview ---')
        print(text)
        print('--- end preview ---')
        return 200
    if not LINE_CHANNEL_TOKEN or not LINE_TO:
        print('ERROR: LINE_CHANNEL_TOKEN / LINE_TO not set')
        return 0
    try:
        r = requests.post(
            'https://api.line.me/v2/bot/message/push',
            headers={'Authorization': f'Bearer {LINE_CHANNEL_TOKEN}',
                     'Content-Type': 'application/json'},
            json={'to': LINE_TO, 'messages': [{'type': 'text', 'text': text}]},
            timeout=20)
        if r.status_code != 200:
            print(f'LINE push failed: {r.status_code} {r.text[:200]}')
        return r.status_code
    except Exception as e:
        print(f'LINE push error: {e}')
        return 0


def send_line_alert(text):
    send_line_text(f'🔧 highlight_scan({FUND_TICKER}) 維運告警\n{text}')


def write_daily_json(today, candidates, selected, status, skipped, push, cfg):
    os.makedirs(OUT_DIR, exist_ok=True)
    sel_ids = {c.id for c in selected}
    payload = {
        'date': today.isoformat(),
        'scanned_at': datetime.now(TZ).isoformat(timespec='seconds'),
        'config_snapshot': {k: cfg[k] for k in ('r1', 'r2', 'r3', 'r4', 'r5', 'scoring')},
        'sources': status,
        'skipped_rules': skipped,
        'candidates': [{
            'id': c.id, 'rule': c.rule, 'score': c.score,
            'selected': c.id in sel_ids,
            'fact': c.fact, 'angle': c.angle, 'draft': c.draft, 'data': c.data,
        } for c in sorted(candidates, key=lambda c: -c.score)],
        'push': push,
    }
    with open(os.path.join(OUT_DIR, f'{today.isoformat()}.json'), 'w',
              encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def apply_state_patches(state: DedupState, selected):
    for c in selected:
        p = c.state_patch
        if not p:
            continue
        for key, val in p.get('r3', {}).items():
            state.r3_events[key] = val
        for kind, val in p.get('r4_rank', {}).items():
            state.r4_rank[kind] = val
        if 'r4_new_high' in p:
            state.r4_new_high.update(p['r4_new_high'])
        if 'r5_aum_milestones' in p:
            tier = p['r5_aum_milestones']
            if tier not in state.r5_aum_milestones:
                state.r5_aum_milestones.append(tier)
        if 'r5_last_data_date' in p:
            state.r5_last_data_date = max(state.r5_last_data_date,
                                          p['r5_last_data_date'])


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    override = os.environ.get('SCAN_DATE')
    if override:
        today = datetime.strptime(override, '%Y-%m-%d').date()
    elif PROFILE['calendar'] == 'global':
        # 清晨 06:00 送：掃的是「最近一個已收完的交易日」（台北日期的前一個平日，
        # 美股在台北清晨收盤；週一早上掃到的是上週五）
        today = datetime.now(TZ).date() - timedelta(days=1)
        while today.weekday() >= 5:
            today -= timedelta(days=1)
    else:
        today = datetime.now(TZ).date()
    print(f'highlight_scan {FUND_TICKER} for {today} (dry_run={DRY_RUN}, force={FORCE_RESEND})')

    # 全球型基金各市場休市日不同（台股休市美股照開），不能用單一交易日曆擋；
    # 沒有報價的市場由 fetch_quotes_yf 以「最後一根日 K 日期 ≠ 掃描日」自然略過。
    if PROFILE['calendar'] == 'twse' and is_twse_trading_day(today) is False:
        print('Non-trading day, exit quietly.')
        return

    cfg = load_config()
    state = load_state()
    ctx, status = build_context(today, cfg)
    print(f'sources: {status}')

    if all(v == 'fail' for v in status.values()):
        send_line_alert(f'{today} 全部資料源失敗，未產出亮點。')
        write_daily_json(today, [], [], status, [r[0] for r in RULES],
                         {'attempted': False, 'sent': False,
                          'reason': 'all_sources_failed'}, cfg)
        sys.exit('all sources failed')

    candidates, skipped = run_rules(ctx, status, cfg, state)
    selected, _rest = select_top(candidates, cfg['message']['max_items'])
    print(f'candidates={len(candidates)} selected={len(selected)} skipped={skipped}')

    push_failed = False
    today_iso = today.isoformat()
    if not candidates:
        push = {'attempted': False, 'sent': False, 'reason': 'no_candidates',
                'candidate_count': 0, 'selected_count': 0}
    elif today_iso in state.pushed_dates and not FORCE_RESEND:
        push = {'attempted': False, 'sent': False, 'reason': 'idempotent_rerun',
                'candidate_count': len(candidates), 'selected_count': len(selected)}
    else:
        msg = build_message(selected, today, skipped, cfg)
        code = send_line_text(msg)
        sent = code == 200
        push = {'attempted': True, 'sent': sent, 'reason': None if sent else 'push_failed',
                'message_chars': len(msg), 'line_status': code,
                'candidate_count': len(candidates), 'selected_count': len(selected)}
        if sent:
            if not DRY_RUN and today_iso not in state.pushed_dates:
                state.pushed_dates.append(today_iso)
            if not DRY_RUN:
                apply_state_patches(state, selected)
        else:
            push_failed = True  # 不標記 pushed → 下次重跑會重試（review M2）

    if not DRY_RUN:
        prune_state(state, ctx.own_days_sorted or [])
        save_state(state)
        write_daily_json(today, candidates, selected, status, skipped, push, cfg)
    else:
        print(json.dumps(push, ensure_ascii=False))

    if push_failed:
        send_line_alert(f'{today} 亮點推播失敗（LINE 回應異常），下次執行將自動重試。')
        sys.exit('LINE push failed')


if __name__ == '__main__':
    main()
