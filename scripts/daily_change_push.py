#!/usr/bin/env python3
"""
每日 18:00：00991A / 00981A / 00992A 當日個股加減碼 → 一張圖推 Pushover。

內容＝網站「同業當日加減碼」分頁（?tab=dailychange）預設三檔的那張表：直接打正式站的
/api/daily-change（同一份 lib/dailyChange.ts 計算，口徑與網頁一致，現金類科目已排除），
這裡只負責挑三檔、彙整成列、渲染截圖。

資料庫約 17:40 入庫當日持股；18:00 觸發時若還有檔沒到今天，每 3 分鐘重查（fresh=1），
到 DEADLINE 仍沒到齊就照送、標題帶 ⚠️ 並寫明哪檔停在哪天（per-ETF as-of，不混日）。
冪等：推播成功才把日期寫進 data/daily_change_push/_state.json；FORCE_RESEND=true 可重送。
觸發：cron-job.org 平日 18:00 直打 workflow_dispatch（workflow 沒有 GH schedule，避免重複推）。
"""

import os
import sys
import json
import time
import asyncio
import html as htmlmod
from datetime import datetime
from pathlib import Path

import requests

sys.path.insert(0, os.path.dirname(__file__))
from daily_summary import (  # noqa: E402
    TZ, is_twse_trading_day, screenshot_html, send_pushover, send_pushover_text,
)

TICKERS    = ['00991A', '00981A', '00992A']   # 同網頁 DailyChangeTab 的 DEFAULT_TICKERS（順序依使用者需求）
SITE_URL   = os.environ.get('SITE_URL', 'https://fhactiveetf.vercel.app').rstrip('/')
DEADLINE   = (19, 30)                        # 台北時間；過了就不再等，照現有資料送
POLL_SEC   = 180
STATE_PATH = Path(__file__).resolve().parent.parent / 'data' / 'daily_change_push' / '_state.json'

RED, GREEN, TEXT, SUB, BORDER = '#C00000', '#16a34a', '#1C1C1E', '#6B6460', '#EEE9E4'
MONO = "'IBM Plex Mono', 'Courier New', monospace"
SANS = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif"


# ── 資料 ──────────────────────────────────────────────────────────────────────

def fetch_daily_change(fresh: bool = True) -> dict:
    url = f'{SITE_URL}/api/daily-change' + ('?fresh=1' if fresh else '')
    r = requests.get(url, timeout=150)
    j = r.json()
    if r.status_code != 200:
        raise RuntimeError(f'daily-change HTTP {r.status_code}: {j.get("error")}')
    return j


def build_rows(data: dict, tickers: list[str]) -> tuple[list[dict], float, float]:
    """同 DailyChangeTab 的 rows/buy/sell 計算：每檔個股彙整所選 ETF 的加碼/減碼，依 |金額| 由大到小。"""
    sel = set(tickers)
    order = {t: i for i, t in enumerate(tickers)}
    rows, buy, sell = [], 0.0, 0.0
    for s in data.get('stocks', []):
        ch = [c for c in s['changes'] if c['ticker'] in sel]
        if not ch:
            continue
        close = s.get('close')

        def pill(c):
            d = c['cur'] - c['prev']
            return {'ticker': c['ticker'], 'shares': d,
                    'amount': d * close if close is not None else None,
                    'tag': '新' if c['prev'] == 0 else '清' if c['cur'] == 0 else None}

        def mag(p):
            return abs(p['amount'] if p['amount'] is not None else p['shares'])

        adds = sorted((pill(c) for c in ch if c['cur'] > c['prev']), key=lambda p: (-mag(p), order[p['ticker']]))
        cuts = sorted((pill(c) for c in ch if c['cur'] < c['prev']), key=lambda p: (-mag(p), order[p['ticker']]))
        net = sum(c['cur'] - c['prev'] for c in ch)
        if close is not None:
            for c in ch:
                amt = (c['cur'] - c['prev']) * close
                if amt > 0:
                    buy += amt
                else:
                    sell += -amt
        rows.append({'stockid': s['stockid'], 'stockname': s['stockname'], 'adds': adds, 'cuts': cuts,
                     'net': net, 'amount': net * close if close is not None else None})
    rows.sort(key=lambda r: -abs(r['amount']) if r['amount'] is not None else float('inf'))
    return rows, buy, sell


def lagging_funds(data: dict, tickers: list[str], today_iso: str) -> list[dict]:
    """還沒到今天的那幾檔（含完全查無資料、或沒有前一日可比的）。"""
    by = {f['ticker']: f for f in data.get('funds', [])}
    out = []
    for t in tickers:
        f = by.get(t) or {'ticker': t, 'curDate': None, 'prevDate': None}
        if (f.get('curDate') or '') < today_iso or not f.get('prevDate'):
            out.append(f)
    return out


# ── 渲染 ──────────────────────────────────────────────────────────────────────

def fmt_lots(shares: float) -> str:
    lots = shares / 1000
    sign = '+' if lots > 0 else '-' if lots < 0 else ''
    return f'{sign}{abs(lots):,.0f}'


def fmt_money(v: float) -> str:
    a, sign = abs(v), ('+' if v > 0 else '-' if v < 0 else '')
    return f'{sign}{a / 1e8:.2f} 億' if a >= 1e8 else f'{sign}{a / 1e4:.0f} 萬'


def fmt_money_plain(v: float) -> str:
    return f'{v / 1e8:.2f} 億' if v >= 1e8 else f'{v / 1e4:.0f} 萬'


def dir_color(v) -> str:
    return SUB if not v else (RED if v > 0 else GREEN)


def _pills(items: list[dict]) -> str:
    if not items:
        return f'<span style="color:{SUB}">—</span>'
    out = []
    for p in items:
        # 手機上圖會被縮小 → 不畫框/底色，只留「代號＋金額」，加減碼靠金額的紅綠色判斷
        c = dir_color(p['shares'])
        tag = f'<span style="color:{c};font-size:11px">({p["tag"]})</span>' if p['tag'] else ''
        val = fmt_money(p['amount']) if p['amount'] is not None else f'{fmt_lots(p["shares"])} 張'
        out.append(f'<span class="pill"><b>{p["ticker"]}</b>{tag}'
                   f'<span style="color:{c}">{val}</span></span>')
    return '<div class="pills">' + ''.join(out) + '</div>'


def build_html(data: dict, tickers: list[str], rows: list[dict], buy: float, sell: float,
               lagging: list[dict]) -> str:
    by = {f['ticker']: f for f in data.get('funds', [])}
    funds = [by.get(t, {'ticker': t, 'name': '', 'curDate': None, 'prevDate': None}) for t in tickers]
    cur_dates = sorted({f['curDate'] for f in funds if f.get('curDate')})
    fund_line = '　'.join(
        f'<b style="font-family:{MONO}">{f["ticker"]}</b> {htmlmod.escape(f.get("name") or "")}'
        f'<span style="color:{SUB};font-family:{MONO}">（{(f.get("prevDate") or "—")[5:]}→{(f.get("curDate") or "無資料")[5:]}）</span>'
        for f in funds)
    warn = ''
    if lagging:
        warn = ('<div class="warn">⚠ 尚未更新到今天：'
                + '、'.join(f'{f["ticker"]}（{f.get("curDate") or "無資料"}）' for f in lagging)
                + '；表中該檔為其最新持股日的異動。</div>')

    body_rows = ''.join(
        f'<tr><td><span style="font-family:{MONO};color:{SUB};margin-right:8px">{htmlmod.escape(r["stockid"])}</span>'
        f'<b>{htmlmod.escape(r["stockname"])}</b></td>'
        f'<td>{_pills(r["adds"])}</td><td>{_pills(r["cuts"])}</td>'
        f'<td class="num" style="color:{dir_color(r["net"])}">{fmt_lots(r["net"])}</td>'
        f'<td class="num" style="color:{dir_color(r["amount"])}">'
        f'{fmt_money(r["amount"]) if r["amount"] is not None else "—"}</td></tr>'
        for r in rows)
    table = (f'<table><thead><tr><th>個股</th><th>加碼 / 新倉 ETF</th><th>減碼 / 清倉 ETF</th>'
             f'<th class="num">淨變動張數</th><th class="num">變動金額</th></tr></thead><tbody>{body_rows}</tbody></table>'
             if rows else f'<div style="color:{SUB};padding:24px;text-align:center">三檔最新一日都沒有持股變動。</div>')

    gen = datetime.now(TZ).strftime('%Y/%m/%d %H:%M')
    return f'''<!doctype html><html><head><meta charset="utf-8"><style>
body{{margin:0;padding:22px 24px;font-family:{SANS};color:{TEXT};background:#fff;font-size:14px}}
h1{{margin:0 0 4px;font-size:19px;border-left:3px solid {RED};padding-left:10px}}
.sub{{color:{SUB};font-size:12.5px;margin:6px 0 12px;line-height:1.7}}
.stats{{display:flex;gap:26px;margin:4px 0 12px;font-size:14px}}
.stats b{{font-family:{MONO}}}
.warn{{font-size:12.5px;color:#b45309;background:#FFF7ED;border:1px solid #FED7AA;border-radius:6px;padding:7px 11px;margin-bottom:10px}}
table{{border-collapse:collapse;width:100%;border:1px solid {BORDER}}}
th{{background:{TEXT};color:#fff;font-size:12px;font-weight:600;padding:8px 12px;text-align:left;white-space:nowrap}}
td{{padding:8px 12px;border-bottom:1px solid {BORDER};vertical-align:top;font-size:13.5px}}
.num{{text-align:right;font-family:{MONO};white-space:nowrap}}
.pills{{display:flex;flex-wrap:wrap;gap:4px 16px}}
.pill{{display:inline-flex;align-items:baseline;gap:6px;font-family:{MONO};font-size:13.5px;white-space:nowrap}}
.foot{{color:{SUB};font-size:11.5px;text-align:right;margin-top:10px}}
</style></head><body>
<h1>同業當日加減碼　{" / ".join(d[5:].replace("-", "/") for d in cur_dates) or "—"}</h1>
<div class="sub">{fund_line}<br>原始股數變動（未扣申購贖回稀釋）；金額＝變動股數 × 最新持股日收盤價。</div>
<div class="stats"><span>變動個股 <b>{len(rows)}</b> 檔</span>
<span>合計買超 <b style="color:{RED}">{fmt_money_plain(buy)}</b></span>
<span>合計賣超 <b style="color:{GREEN}">{fmt_money_plain(sell)}</b></span></div>
{warn}{table}
<div class="foot">資料來源：各投信官網持股（{SITE_URL.replace("https://", "")}/?tab=dailychange）　生成時間：{gen} TST</div>
</body></html>'''


# ── 狀態（冪等） ───────────────────────────────────────────────────────────────

def load_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text())
    except Exception:
        return {'pushed_dates': []}


def mark_pushed(day_iso: str):
    st = load_state()
    st['pushed_dates'] = sorted(set(st.get('pushed_dates', [])) | {day_iso})[-60:]
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(st, ensure_ascii=False, indent=2) + '\n')


# ── main ──────────────────────────────────────────────────────────────────────

async def main():
    now = datetime.now(TZ)
    today = now.date()
    today_iso = today.isoformat()
    force = os.environ.get('FORCE_RESEND', '').lower() == 'true'
    print(f'daily_change_push {today_iso} force={force} tickers={TICKERS}')

    if is_twse_trading_day(today) is False:
        print('Non-trading day, exit quietly.')
        return
    if not force and today_iso in load_state().get('pushed_dates', []):
        print('Already pushed today, skip (FORCE_RESEND=true to resend).')
        return

    deadline = now.replace(hour=DEADLINE[0], minute=DEADLINE[1], second=0, microsecond=0)
    while True:
        data = fetch_daily_change(fresh=True)
        lagging = lagging_funds(data, TICKERS, today_iso)
        print(f'  {datetime.now(TZ):%H:%M} lagging={[(f["ticker"], f.get("curDate")) for f in lagging]}')
        if not lagging or datetime.now(TZ) >= deadline:
            break
        time.sleep(POLL_SEC)

    rows, buy, sell = build_rows(data, TICKERS)
    img = await screenshot_html(build_html(data, TICKERS, rows, buy, sell, lagging))
    title = f'{"⚠️ " if lagging else ""}當日加減碼 {today:%m/%d}　{" · ".join(TICKERS)}'
    msg = f'變動 {len(rows)} 檔　買超 {fmt_money_plain(buy)}／賣超 {fmt_money_plain(sell)}'
    if lagging:
        msg += '\n⚠️ 未更新到今天：' + '、'.join(f'{f["ticker"]}（{f.get("curDate") or "無資料"}）' for f in lagging)
    try:
        send_pushover(title, msg, img)
    except Exception as e:
        # 圖太大等狀況：退成純文字，至少讓使用者知道今天有跑
        print(f'  image push failed: {e} → fallback text')
        send_pushover_text(title, msg + '\n（圖片推送失敗，請看網站 ?tab=dailychange）')
    mark_pushed(today_iso)


if __name__ == '__main__':
    asyncio.run(main())
