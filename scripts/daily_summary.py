#!/usr/bin/env python3
"""
Daily holdings summary: fetch fhtrust data, render HTML, screenshot, send via Pushover.
Runs Mon-Fri at 17:15 TST via GitHub Actions.
"""

import os
import sys
import asyncio
import requests
from datetime import datetime, timedelta, date
import pytz

TZ = pytz.timezone('Asia/Taipei')

FHTRUST_ASSETS = 'https://www.fhtrust.com.tw/api/assets'
FHTRUST_PCF    = 'https://www.fhtrust.com.tw/api/ETFPcf'

ETFS = [
    {'ticker': '00991A', 'name': '復華主動式ETF', 'fundId': 'ETF23', 'yfTicker': '00991A.TW'},
]

PUSHOVER_TOKEN     = os.environ.get('PUSHOVER_TOKEN', '')
PUSHOVER_USER      = os.environ.get('PUSHOVER_USER', '')
SUPABASE_URL       = os.environ.get('SUPABASE_URL', '')
SUPABASE_SERVICE_KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')


# ── Helpers ──────────────────────────────────────────────────────────────────

def date_to_api(d: date) -> str:
    return d.strftime('%Y/%m/%d')

def parse_num(v) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    return float(str(v).replace(',', '').replace('%', '') or 0)


# ── API fetchers ──────────────────────────────────────────────────────────────

def fetch_holdings(date_str: str, fund_id: str):
    """Return {'date': str, 'holdings': [...]} or None."""
    url = f'{FHTRUST_ASSETS}?fundID={fund_id}&qDate={requests.utils.quote(date_str)}'
    try:
        r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
        data = r.json()
        fund = (data.get('result') or [None])[0]
        if not fund:
            return None
        holdings = [
            {
                'stockid':          str(item.get('stockid', '')),
                'stockname':        str(item.get('stockname', '')),
                'qshare':           parse_num(item.get('qshare', 0)),
                'mvalue':           parse_num(item.get('mvalue', 0)),
                'prate_addaccint':  parse_num(item.get('prate_addaccint', 0)),
            }
            for item in fund.get('detail', [])
        ]
        return {'date': fund.get('dDate', date_str), 'holdings': holdings}
    except Exception as e:
        print(f'  holdings fetch error ({date_str}): {e}')
        return None


def fetch_pcf(target: date, fund_id: str):
    """Return {'aum': float, 'pnav': float} for the given actBuyValDate, or None."""
    target_str = date_to_api(target)
    for offset in range(5):
        pcf_date = date_to_api(target + timedelta(days=offset))
        try:
            url = f'{FHTRUST_PCF}?fundID={fund_id}&pcfDate={requests.utils.quote(pcf_date)}'
            r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
            data = r.json()
            d = (data.get('result') or [None])[0] if data.get('result') else data
            if not d or not d.get('actBuyValDate'):
                continue
            if str(d['actBuyValDate']) != target_str:
                continue
            return {
                'aum':  parse_num(d.get('nav', 0)) / 1e8,
                'pnav': parse_num(d.get('pnav', 0)),
            }
        except:
            continue
    return None


def fetch_etf_price(yf_ticker: str) -> dict | None:
    """Fetch ETF market price and previous close from Yahoo Finance."""
    try:
        import yfinance as yf
        ticker = yf.Ticker(yf_ticker)
        fi = ticker.fast_info
        price      = fi.last_price
        prev_close = fi.previous_close
        if not price:
            return None
        return {'price': price, 'prev_close': prev_close}
    except Exception as e:
        print(f'  yfinance {yf_ticker}: {e}')
        return None


# ── Peer ETF data fetchers ────────────────────────────────────────────────────

PEER_ETFS = [
    {'ticker': '00991A', 'name': '復華991', 'source': 'fhtrust',  'key': 'ETF23'},
    {'ticker': '00981A', 'name': '統一981', 'source': 'ezmoney',  'key': '49YTW'},
    {'ticker': '00403A', 'name': '統一403', 'source': 'ezmoney',  'key': '63YTW'},
    {'ticker': '00982A', 'name': '群益982', 'source': 'capital',  'key': '399'},
    {'ticker': '00992A', 'name': '群益992', 'source': 'capital',  'key': '500'},
]

EZMONEY_HOST = 'www.ezmoney.com.tw'
CAPITAL_HOST = 'www.capitalfund.com.tw'


def _get_ezmoney_session(fund_code: str) -> requests.Session:
    s = requests.Session()
    s.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    s.get(f'https://{EZMONEY_HOST}/', timeout=15)
    s.get(f'https://{EZMONEY_HOST}/ETF/Transaction/PCF?fundCode={fund_code}', timeout=15)
    return s


def _roc_date(d: date) -> str:
    """Convert Gregorian date to ROC format YYY/MM/DD."""
    return f'{d.year - 1911}/{d.month:02d}/{d.day:02d}'


def _parse_tran_date(raw) -> str | None:
    """Parse ezmoney TranDate from ISO string or .NET /Date(ms)/ format → YYYY-MM-DD."""
    if not raw:
        return None
    s = str(raw)
    # ISO format: "2026-06-01T00:00:00"
    if 'T' in s:
        return s[:10]
    # .NET ticks: "/Date(1780243200000)/"
    import re
    m = re.search(r'Date\((\d+)\)', s)
    if m:
        ms = int(m.group(1))
        # Add 8 hours to convert UTC to Taiwan time before extracting date
        from datetime import timezone, timezone as tz
        dt = datetime.fromtimestamp((ms + 8 * 3600 * 1000) / 1000, tz=timezone.utc)
        return dt.strftime('%Y-%m-%d')
    return None


def fetch_ezmoney_day(fund_code: str, transaction_date: date,
                      session: requests.Session | None = None) -> dict | None:
    """Return {'netSub': float, 'aum': float} for given transaction date, or None.
    Tries announcement offsets +1..+4 days to handle weekends and holidays."""
    try:
        s = session or _get_ezmoney_session(fund_code)
        target_str = str(transaction_date)  # YYYY-MM-DD
        for offset in range(1, 5):
            announce = transaction_date + timedelta(days=offset)
            payload = {'fundCode': fund_code, 'date': _roc_date(announce), 'specificDate': True}
            try:
                r = s.post(
                    f'https://{EZMONEY_HOST}/ETF/Transaction/GetPCF',
                    json=payload,
                    headers={'X-Requested-With': 'XMLHttpRequest',
                             'Referer': f'https://{EZMONEY_HOST}/ETF/Transaction/PCF?fundCode={fund_code}'},
                    timeout=25,
                )
            except Exception:
                continue
            if r.status_code != 200 or 'application/json' not in r.headers.get('content-type', ''):
                continue
            pcf = r.json().get('pcf', [])
            if not pcf:
                continue
            tran_date = _parse_tran_date(pcf[0].get('TranDate'))
            if not tran_date or tran_date != target_str:
                continue
            get = lambda code: next((parse_num(p['Amount']) for p in pcf if p.get('PCFCode','').upper() == code), 0)
            diff_unit = get('DIFF_UNIT')
            p_unit    = get('P_UNIT')
            nav       = get('NAV')
            if p_unit == 0:
                continue
            return {'netSub': (diff_unit * p_unit) / 1e8, 'aum': nav / 1e8}
        return None
    except Exception as e:
        print(f'  ezmoney {fund_code} {transaction_date}: {e}')
        return None


def _next_biz_day(d: date) -> date:
    nd = d + timedelta(days=1)
    while nd.weekday() >= 5:
        nd += timedelta(days=1)
    return nd


def fetch_capital_day(fund_id: str, transaction_date: date) -> dict | None:
    """Return {'netSub': float, 'aum': float} for given transaction date, or None."""
    try:
        s = requests.Session()
        s.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        s.get(f'https://{CAPITAL_HOST}/', timeout=15)
        announce = _next_biz_day(transaction_date)
        payload = {'fundId': fund_id, 'date': str(announce)}
        r = s.post(
            f'https://{CAPITAL_HOST}/CFWeb/api/etf/buyback',
            json=payload,
            headers={'Referer': f'https://{CAPITAL_HOST}/etf/transaction/buyback'},
            timeout=20,
        )
        if r.status_code != 200:
            return None
        pcf = r.json().get('data', {}).get('pcf', {})
        if not pcf or pcf.get('date2') != str(transaction_date):
            return None
        dis_unit = parse_num(pcf.get('disUnit', 0))
        p_unit   = parse_num(pcf.get('pUnit', 0))
        nav      = parse_num(pcf.get('nav', 0))
        if p_unit == 0:
            return None
        return {'netSub': (dis_unit * p_unit) / 1e8, 'aum': nav / 1e8}
    except Exception as e:
        print(f'  capital {fund_id} {transaction_date}: {e}')
        return None


def fetch_fhtrust_peer_day(fund_id: str, transaction_date: date) -> dict | None:
    """Fetch net subscription for fhtrust ETF from PCF data."""
    result = fetch_pcf(transaction_date, fund_id)
    if not result:
        return None
    # aum from PCF; netSub from ScaleDay pattern: need actBuyVal × qDiff
    # For peer table we only use aum here; netSub from etf-scale logic not repeated
    return {'aum': result['aum'], 'netSub': None}  # netSub requires scale API separately


def fetch_all_peer_data(transaction_date: date) -> list:
    """Fetch net subscription data for all peer ETFs on the given date."""
    # Build shared ezmoney session once for all ezmoney ETFs
    ezmoney_etfs = [e for e in PEER_ETFS if e['source'] == 'ezmoney']
    ezmoney_session = None
    if ezmoney_etfs:
        try:
            ezmoney_session = _get_ezmoney_session(ezmoney_etfs[0]['key'])
        except Exception as e:
            print(f'  ezmoney session error: {e}')

    results = []
    for etf in PEER_ETFS:
        data = None
        if etf['source'] == 'ezmoney':
            data = fetch_ezmoney_day(etf['key'], transaction_date, session=ezmoney_session)
        elif etf['source'] == 'capital':
            data = fetch_capital_day(etf['key'], transaction_date)
        elif etf['source'] == 'fhtrust':
            # For fhtrust, netSub comes from PCF DIFF_UNIT calculation
            # Use fhtrust PCF API (same as etf-scale)
            target_str = date_to_api(transaction_date)
            for offset in range(5):
                pcf_date = date_to_api(transaction_date + timedelta(days=offset))
                try:
                    url = f'{FHTRUST_PCF}?fundID={etf["key"]}&pcfDate={requests.utils.quote(pcf_date)}'
                    r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
                    d = r.json()
                    d = (d.get('result') or [None])[0] if d.get('result') else d
                    if not d or str(d.get('actBuyValDate', '')) != target_str:
                        continue
                    act_buy_val = parse_num(d.get('actBuyVal', 0))
                    q_diff      = parse_num(d.get('qDiff', 0))
                    nav         = parse_num(d.get('nav', 0))
                    data = {
                        'netSub': act_buy_val * q_diff / 500000 / 1e8,
                        'aum':    nav / 1e8,
                    }
                    break
                except:
                    continue
        results.append({**etf, 'data': data})
    return results


def build_peer_html(peer_results: list, transaction_date: date) -> str:
    rows_html = ''
    for etf in peer_results:
        d = etf['data']
        if d and d['netSub'] is not None:
            ns = d['netSub']
            color = '#C00000' if ns > 0 else '#1A6B45' if ns < 0 else '#6B6460'
            sign  = '+' if ns > 0 else ''
            ns_str = f'{sign}{ns:.2f}'
            aum_str = f'{d["aum"]:.2f} 億' if d.get('aum') else '—'
        else:
            ns_str = '—'
            color  = '#BBBBBB'
            aum_str = '—'
        rows_html += f'''
        <tr style="border-bottom:1px solid #EEE9E4;">
          <td style="padding:8px 14px;font-size:13px;color:#1C1C1E;font-weight:600;">{etf["ticker"]}</td>
          <td style="padding:8px 14px;font-size:12px;color:#6B6460;">{etf["name"]}</td>
          <td style="padding:8px 14px;text-align:right;font-family:monospace;font-size:13px;font-weight:700;color:{color};">{ns_str}</td>
          <td style="padding:8px 14px;text-align:right;font-family:monospace;font-size:12px;color:#6B6460;">{aum_str}</td>
        </tr>'''

    return f'''<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>*{{margin:0;padding:0;box-sizing:border-box;}}body{{font-family:"Noto Sans TC","Segoe UI",Arial,sans-serif;background:#fff;padding:20px;width:520px;}}</style>
</head><body>
  <div style="border-left:4px solid #C00000;padding-left:12px;margin-bottom:16px;">
    <div style="font-size:17px;font-weight:700;color:#1C1C1E;">同業申贖觀測</div>
    <div style="font-size:12px;color:#6B6460;margin-top:3px;">{transaction_date}　單位：億元</div>
  </div>
  <table style="width:100%;border-collapse:collapse;border:1px solid #E8E3DF;border-radius:8px;overflow:hidden;">
    <thead>
      <tr style="background:#1C1C1E;">
        <th style="padding:9px 14px;color:#fff;font-size:11px;text-align:left;">代碼</th>
        <th style="padding:9px 14px;color:#fff;font-size:11px;text-align:left;">名稱</th>
        <th style="padding:9px 14px;color:#fff;font-size:11px;text-align:right;">淨申贖(億)</th>
        <th style="padding:9px 14px;color:#fff;font-size:11px;text-align:right;">規模</th>
      </tr>
    </thead>
    <tbody>{rows_html}</tbody>
  </table>
  <div style="margin-top:10px;font-size:11px;color:#6B6460;text-align:right;">
    正值=淨申購（紅）　負值=淨贖回（綠）　生成時間：{datetime.now(TZ).strftime('%Y/%m/%d %H:%M')} TST
  </div>
</body></html>'''


def find_trading_day_with_data(start: date, fund_id: str, max_lookback: int = 10):
    """Walk back from `start` (skipping weekends) until holdings data is found."""
    d = start
    for _ in range(max_lookback):
        if d.weekday() < 5:  # Mon–Fri
            result = fetch_holdings(date_to_api(d), fund_id)
            if result:
                return d, result
        d -= timedelta(days=1)
    return None, None


# ── Diff logic ────────────────────────────────────────────────────────────────

def build_diff_rows(base_holdings, cmp_holdings):
    """Return only changed rows, sorted by status then weight."""
    curr_map = {(h['stockid'] or h['stockname']): h for h in base_holdings}
    prev_map = {(h['stockid'] or h['stockname']): h for h in cmp_holdings}
    keys = set(curr_map) | set(prev_map)

    ORDER = {'new': 0, 'increased': 1, 'decreased': 2, 'removed': 3}
    rows = []
    for key in keys:
        c, p = curr_map.get(key), prev_map.get(key)
        if   c and not p:              status = 'new'
        elif not c:                    status = 'removed'
        elif c['qshare'] > p['qshare']: status = 'increased'
        elif c['qshare'] < p['qshare']: status = 'decreased'
        else:                          continue  # unchanged

        c_price = c['mvalue'] / c['qshare'] if c and c['qshare'] > 0 else None
        p_price = p['mvalue'] / p['qshare'] if p and p['qshare'] > 0 else None
        if   c and p and c_price: diff_amount = c_price * (c['qshare'] - p['qshare'])
        elif c and c_price:       diff_amount = c['mvalue']
        elif p and p_price:       diff_amount = -p['mvalue']
        else:                     diff_amount = None

        rows.append({
            'stockid':    (c or p)['stockid'],
            'stockname':  (c or p)['stockname'],
            'status':     status,
            'curr_q':     c['qshare']           if c else None,
            'prev_q':     p['qshare']           if p else None,
            'diff_q':     (c['qshare'] - p['qshare']) if c and p else None,
            'curr_p':     c['prate_addaccint']  if c else None,
            'prev_p':     p['prate_addaccint']  if p else None,
            'diff_p':     (c['prate_addaccint'] - p['prate_addaccint']) if c and p else None,
            'diff_amount': diff_amount,
        })

    rows.sort(key=lambda r: (ORDER[r['status']], -(r['curr_p'] or 0)))
    return rows


# ── Formatters ────────────────────────────────────────────────────────────────

def fn(n, dec=0):
    return '—' if n is None else f'{n:,.{dec}f}'

def fd(n, dec=0):
    if n is None: return ''
    s = f'{abs(n):,.{dec}f}'
    return f'+{s}' if n > 0 else f'−{s}' if n < 0 else '0'

def fp(n):
    return '—' if n is None else f'{n:.3f}%'

def fdp(n):
    if n is None: return ''
    s = f'{abs(n):.3f}'
    return f'+{s}%' if n > 0 else f'−{s}%' if n < 0 else '0%'

def famt(n):
    if n is None: return '—'
    wan = n / 10000
    if abs(wan) < 0.05: return '0'
    s = f'{abs(wan):,.1f}'
    return f'+{s}' if wan > 0 else f'−{s}'

def diff_color(n):
    if n is None or n == 0: return '#6B6460'
    return '#C00000' if n > 0 else '#1A6B45'


# ── HTML generation ───────────────────────────────────────────────────────────

SC = {
    'new':       {'bg': '#FFF5F5', 'bbg': '#FFE8E8', 'bc': '#C00000', 'bb': '#FFCDD2', 'label': '新倉'},
    'increased': {'bg': '#FFFAFA', 'bbg': '#FFF0F0', 'bc': '#C00000', 'bb': '#FFE0E0', 'label': '加碼'},
    'decreased': {'bg': '#F5FBF5', 'bbg': '#E8F5EC', 'bc': '#1A6B45', 'bb': '#C8E6C9', 'label': '減碼'},
    'removed':   {'bg': '#EEF8EE', 'bbg': '#D8EEDC', 'bc': '#1A6B45', 'bb': '#A5D6A7', 'label': '清倉'},
}


def build_html(etf, base_data, cmp_data, curr_pcf, prev_pcf, rows, etf_price=None):
    bs = str(base_data['date'])[5:]
    cs = str(cmp_data['date'])[5:]

    counts = {s: sum(1 for r in rows if r['status'] == s) for s in SC}
    total  = sum(counts.values())

    # Scale / price card values
    aum_val = f"{curr_pcf['aum']:.2f} 億" if curr_pcf else '—'
    if curr_pcf and prev_pcf:
        da = curr_pcf['aum'] - prev_pcf['aum']
        aum_diff  = fd(da, 2) + ' 億'
        aum_color = diff_color(da)
    else:
        aum_diff = '—'; aum_color = '#6B6460'

    # ETF market price (replaces pnav)
    if etf_price and etf_price.get('price'):
        ep = etf_price['price']
        ec = etf_price.get('prev_close')
        price_val = f"{ep:.2f}"
        if ec:
            dp = ep - ec
            pct = dp / ec * 100
            sign = '+' if dp > 0 else '−' if dp < 0 else ''
            price_diff = f"{sign}{abs(dp):.2f}"
            price_diff_sub = f"({sign}{abs(pct):.2f}%)"
            price_diff_color = diff_color(dp)
        else:
            price_diff = '—'; price_diff_sub = ''; price_diff_color = '#6B6460'
        price_color = '#1C1C1E'
    else:
        price_val = '—'; price_diff = '—'; price_diff_sub = ''
        price_color = price_diff_color = '#6B6460'

    def card4(items):
        cells = ''
        for i, (label, val, color, sub) in enumerate(items):
            br = 'border-right:1px solid #EEE9E4;' if i < 3 else ''
            sub_html = f'<div style="font-size:13px;font-weight:600;color:{color};font-family:monospace;margin-top:2px;">{sub}</div>' if sub else ''
            cells += f'''<div style="padding:12px 16px;{br}">
              <div style="font-size:11px;color:#6B6460;font-weight:500;margin-bottom:4px;">{label}</div>
              <div style="font-size:20px;font-weight:700;color:{color};font-family:monospace;line-height:1.1;">{val}</div>
              {sub_html}
            </div>'''
        return f'<div style="display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #EEE9E4;border-radius:8px;overflow:hidden;margin-bottom:12px;background:#FAFAF9;">{cells}</div>'

    scale_cards = card4([
        (f'基金規模 ({bs})',       aum_val,    '#1C1C1E',         ''),
        (f'規模變化 (vs {cs})',    aum_diff,   aum_color,         ''),
        (f'ETF 股價 ({bs})',       price_val,  price_color,       ''),
        ('股價變化',               price_diff, price_diff_color,  price_diff_sub),
    ])

    stat_cards = card4([
        ('新增持倉', counts['new'],       '#C00000', ''),
        ('加碼',     counts['increased'], '#C00000', ''),
        ('減碼',     counts['decreased'], '#1A6B45', ''),
        ('清倉',     counts['removed'],   '#1A6B45', ''),
    ])

    if rows:
        tbody = ''
        for r in rows:
            sc = SC[r['status']]
            pq_c = '#BBBBBB' if r['status'] == 'removed' else '#1C1C1E'
            cq_c = '#BBBBBB' if r['status'] == 'new'     else '#1C1C1E'
            pp_c = '#BBBBBB' if r['status'] == 'removed' else '#1C1C1E'
            cp_c = '#BBBBBB' if r['status'] == 'new'     else '#1C1C1E'
            tbody += f'''<tr style="background:{sc['bg']};border-bottom:1px solid #EEE9E4;">
              <td style="padding:7px 8px;font-family:monospace;font-size:12px;color:#6B6460;text-align:center;white-space:nowrap;">{r['stockid'] or '—'}</td>
              <td style="padding:7px 8px;font-size:13px;color:#1C1C1E;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">{r['stockname']}</td>
              <td style="padding:7px 8px;font-family:monospace;font-size:12px;color:{pq_c};text-align:right;">{fn(r['prev_q'])}</td>
              <td style="padding:7px 8px;font-family:monospace;font-size:12px;color:{cq_c};text-align:right;">{fn(r['curr_q'])}</td>
              <td style="padding:7px 8px;font-family:monospace;font-size:12px;color:{diff_color(r['diff_q'])};font-weight:600;text-align:right;">{fd(r['diff_q'])}</td>
              <td style="padding:7px 8px;font-family:monospace;font-size:12px;color:{diff_color(r['diff_amount'])};font-weight:600;text-align:right;">{famt(r['diff_amount'])}</td>
              <td style="padding:7px 8px;font-family:monospace;font-size:12px;color:{pp_c};text-align:right;">{fp(r['prev_p'])}</td>
              <td style="padding:7px 8px;font-family:monospace;font-size:12px;color:{cp_c};text-align:right;">{fp(r['curr_p'])}</td>
              <td style="padding:7px 8px;font-family:monospace;font-size:12px;color:{diff_color(r['diff_p'])};font-weight:600;text-align:right;">{fdp(r['diff_p'])}</td>
              <td style="padding:7px 8px;text-align:center;"><span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600;background:{sc['bbg']};color:{sc['bc']};border:1px solid {sc['bb']};">{sc['label']}</span></td>
            </tr>'''
    else:
        tbody = '<tr><td colspan="10" style="text-align:center;padding:28px;color:#AAA;font-size:13px;">當日無持股異動</td></tr>'

    thead = f'''<thead><tr>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:center;white-space:nowrap;">代碼</th>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:left;white-space:nowrap;">名稱</th>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:right;white-space:nowrap;">持股 ({cs})</th>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:right;white-space:nowrap;">持股 ({bs})</th>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:right;white-space:nowrap;">持股變化</th>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:right;white-space:nowrap;">異動金額(萬)</th>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:right;white-space:nowrap;">佔比% ({cs})</th>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:right;white-space:nowrap;">佔比% ({bs})</th>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:right;white-space:nowrap;">佔比變化</th>
      <th style="padding:9px 8px;background:#1C1C1E;color:#fff;font-size:11px;text-align:center;white-space:nowrap;">操作</th>
    </tr></thead>'''

    now_str = datetime.now(TZ).strftime('%Y/%m/%d %H:%M')
    return f'''<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>*{{margin:0;padding:0;box-sizing:border-box;}}body{{font-family:"Noto Sans TC","Segoe UI",Arial,sans-serif;background:#fff;padding:20px;width:1020px;}}</style>
</head><body>
  <div style="border-left:4px solid #C00000;padding-left:12px;margin-bottom:16px;">
    <div style="font-size:18px;font-weight:700;color:#1C1C1E;">{etf['ticker']} {etf['name']}</div>
    <div style="font-size:13px;color:#6B6460;margin-top:3px;">當日摘要　{base_data['date']} vs {cmp_data['date']}</div>
  </div>
  {scale_cards}
  {stat_cards}
  <div style="border:1px solid #E8E3DF;border-radius:8px;overflow:hidden;">
    <table style="width:100%;border-collapse:collapse;">{thead}<tbody>{tbody}</tbody></table>
  </div>
  <div style="margin-top:10px;font-size:11px;color:#6B6460;text-align:right;">資料來源：復華投信　生成時間：{now_str} TST</div>
</body></html>'''


# ── Screenshot ────────────────────────────────────────────────────────────────

async def screenshot_html(html: str) -> bytes:
    from playwright.async_api import async_playwright
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await browser.new_page(viewport={'width': 1020, 'height': 800})
        await page.set_content(html, wait_until='load')
        h = await page.evaluate('document.body.scrollHeight')
        await page.set_viewport_size({'width': 1020, 'height': h + 40})
        img = await page.screenshot(full_page=True)
        await browser.close()
    return img


# ── Pushover ──────────────────────────────────────────────────────────────────

def send_pushover(title: str, message: str, image_bytes: bytes):
    r = requests.post(
        'https://api.pushover.net/1/messages.json',
        data={'token': PUSHOVER_TOKEN, 'user': PUSHOVER_USER,
              'title': title, 'message': message, 'html': '1'},
        files={'attachment': ('summary.png', image_bytes, 'image/png')},
        timeout=30,
    )
    result = r.json()
    if result.get('status') != 1:
        raise RuntimeError(f'Pushover error: {result}')
    print(f'  ✓ Pushover sent: {title}')


# ── Main ──────────────────────────────────────────────────────────────────────

async def process_etf(etf: dict, today: date):
    print(f'\n[{etf["ticker"]}]')
    fid = etf['fundId']

    base_date, base_data = find_trading_day_with_data(today, fid)
    if not base_data:
        print(f'  No base data found, skipping.')
        return

    cmp_date, cmp_data = find_trading_day_with_data(base_date - timedelta(days=1), fid)
    if not cmp_data:
        print(f'  No comparison data found, skipping.')
        return

    print(f'  base={base_date}  cmp={cmp_date}')

    curr_pcf  = fetch_pcf(base_date, fid)
    prev_pcf  = fetch_pcf(cmp_date,  fid)
    etf_price = fetch_etf_price(etf.get('yfTicker', ''))

    rows = build_diff_rows(base_data['holdings'], cmp_data['holdings'])
    html = build_html(etf, base_data, cmp_data, curr_pcf, prev_pcf, rows, etf_price)

    img = await screenshot_html(html)

    bs    = str(base_data['date'])[5:]
    cs    = str(cmp_data['date'])[5:]
    total = len(rows)
    send_pushover(
        title   = f'{etf["ticker"]} 當日摘要 {bs}',
        message = f'vs {cs}　共 {total} 筆異動',
        image_bytes = img,
    )


def write_peer_to_supabase(peer_results: list, transaction_date: date):
    """Upsert peer redemption data to Supabase. Silently skips if credentials missing."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        print('  Supabase credentials not set, skipping DB write.')
        return
    try:
        from supabase import create_client
        client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        rows = [
            {
                'date':    str(transaction_date),
                'ticker':  etf['ticker'],
                'net_sub': round(float(etf['data']['netSub']), 6),
                'aum':     round(float(etf['data']['aum']),    6),
            }
            for etf in peer_results
            if etf.get('data')
            and etf['data'].get('netSub') is not None
            and etf['data'].get('aum')    is not None
        ]
        if rows:
            client.table('peer_redemption').upsert(rows).execute()
            print(f'  ✓ Supabase: upserted {len(rows)} rows for {transaction_date}')
        else:
            print('  No valid rows to write to Supabase.')
    except Exception as e:
        print(f'  Supabase write error: {e}')
        import traceback; traceback.print_exc()


async def process_peer_redemption(today: date):
    """Fetch peer redemption data, write to Supabase, and send Pushover notification."""
    print('\n[同業申贖觀測]')
    base_date, _ = find_trading_day_with_data(today, 'ETF23')
    if not base_date:
        print('  No base date found, skipping.')
        return
    print(f'  date={base_date}')
    peer_results = fetch_all_peer_data(base_date)

    write_peer_to_supabase(peer_results, base_date)

    html = build_peer_html(peer_results, base_date)
    img  = await screenshot_html(html)
    send_pushover(
        title       = f'同業申贖觀測 {base_date}',
        message     = '淨申贖：' + '　'.join(
            f'{e["ticker"]} {e["data"]["netSub"]:+.2f}億' if e['data'] and e['data']['netSub'] is not None else f'{e["ticker"]} —'
            for e in peer_results
        ),
        image_bytes = img,
    )


async def main():
    if not PUSHOVER_TOKEN or not PUSHOVER_USER:
        sys.exit('ERROR: PUSHOVER_TOKEN and PUSHOVER_USER must be set.')

    today = datetime.now(TZ).date()
    print(f'Date (TST): {today}')

    for etf in ETFS:
        try:
            await process_etf(etf, today)
        except Exception as e:
            print(f'  ERROR: {e}')
            import traceback; traceback.print_exc()

    try:
        await process_peer_redemption(today)
    except Exception as e:
        print(f'  Peer redemption ERROR: {e}')
        import traceback; traceback.print_exc()


if __name__ == '__main__':
    asyncio.run(main())
