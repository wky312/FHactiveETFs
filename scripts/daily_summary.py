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
    {'ticker': '00991A', 'name': '復華主動式ETF', 'fundId': 'ETF23'},
]

PUSHOVER_TOKEN = os.environ.get('PUSHOVER_TOKEN', '')
PUSHOVER_USER  = os.environ.get('PUSHOVER_USER', '')


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


def build_html(etf, base_data, cmp_data, curr_pcf, prev_pcf, rows):
    bs = str(base_data['date'])[5:]
    cs = str(cmp_data['date'])[5:]

    counts = {s: sum(1 for r in rows if r['status'] == s) for s in SC}
    total  = sum(counts.values())

    # Scale card values
    aum_val  = f"{curr_pcf['aum']:.2f} 億"  if curr_pcf else '—'
    nav_val  = f"{curr_pcf['pnav']:.4f}"    if curr_pcf else '—'
    if curr_pcf and prev_pcf:
        da = curr_pcf['aum']  - prev_pcf['aum']
        dn = curr_pcf['pnav'] - prev_pcf['pnav']
        aum_diff = fd(da, 2) + ' 億'
        nav_diff = (f'+{abs(dn):.4f}' if dn > 0 else f'−{abs(dn):.4f}' if dn < 0 else '0')
        aum_color = diff_color(da)
        nav_color = diff_color(dn)
    else:
        aum_diff = nav_diff = '—'
        aum_color = nav_color = '#6B6460'

    def card4(items):
        cells = ''
        for i, (label, val, color) in enumerate(items):
            br = 'border-right:1px solid #EEE9E4;' if i < 3 else ''
            cells += f'''<div style="padding:12px 16px;{br}">
              <div style="font-size:11px;color:#6B6460;font-weight:500;margin-bottom:4px;">{label}</div>
              <div style="font-size:20px;font-weight:700;color:{color};font-family:monospace;line-height:1.1;">{val}</div>
            </div>'''
        return f'<div style="display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #EEE9E4;border-radius:8px;overflow:hidden;margin-bottom:12px;background:#FAFAF9;">{cells}</div>'

    scale_cards = card4([
        (f'基金規模 ({bs})',     aum_val,  '#1C1C1E'),
        (f'規模變化 (vs {cs})', aum_diff, aum_color),
        (f'單位淨值 ({bs})',     nav_val,  '#1C1C1E'),
        (f'淨值變化 (vs {cs})', nav_diff, nav_color),
    ])

    stat_cards = card4([
        ('新增持倉', counts['new'],       '#C00000'),
        ('加碼',     counts['increased'], '#C00000'),
        ('減碼',     counts['decreased'], '#1A6B45'),
        ('總變化筆數', total,             '#1C1C1E'),
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

    curr_pcf = fetch_pcf(base_date, fid)
    prev_pcf = fetch_pcf(cmp_date,  fid)

    rows = build_diff_rows(base_data['holdings'], cmp_data['holdings'])
    html = build_html(etf, base_data, cmp_data, curr_pcf, prev_pcf, rows)

    img = await screenshot_html(html)

    bs    = str(base_data['date'])[5:]
    cs    = str(cmp_data['date'])[5:]
    total = len(rows)
    send_pushover(
        title   = f'{etf["ticker"]} 當日摘要 {bs}',
        message = f'vs {cs}　共 {total} 筆異動',
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


if __name__ == '__main__':
    asyncio.run(main())
