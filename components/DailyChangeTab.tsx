'use client';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { DailyChangeResult } from '@/lib/dailyChange';

// 台灣慣例：買超（加碼）紅、賣超（減碼）綠
const RED    = '#C00000';
const GREEN  = '#16a34a';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

const DEFAULT_TICKERS = ['00981A', '00991A', '00992A'];

type SortKey = 'stock' | 'lots' | 'amount';

interface Pill { ticker: string; shares: number; amount: number | null; tag?: '新' | '清' }

interface Row {
  stockid: string;
  stockname: string;
  close: number | null;
  adds: Pill[];
  cuts: Pill[];
  netShares: number;
  amount: number | null;       // 淨變動金額（無報價為 null）
  detail: { ticker: string; prev: number; cur: number }[];
}

function fmtLots(shares: number): string {
  const lots = shares / 1000;
  const s = Math.abs(lots).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return `${lots > 0 ? '+' : lots < 0 ? '-' : ''}${s}`;
}
function fmtMoney(v: number): string {
  const a = Math.abs(v);
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(2)} 億`;
  return `${sign}${(a / 1e4).toFixed(0)} 萬`;
}
function fmtMoneyPlain(v: number): string {
  return v >= 1e8 ? `${(v / 1e8).toFixed(2)} 億` : `${(v / 1e4).toFixed(0)} 萬`;
}
const dirColor = (v: number | null) => (v == null || v === 0 ? SUB : v > 0 ? RED : GREEN);

const TH: React.CSSProperties = {
  padding: '8px 14px', fontWeight: 600, fontSize: '.75rem',
  background: TEXT, color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1, userSelect: 'none',
};
const TD: React.CSSProperties = { padding: '8px 14px', fontSize: '.84rem', borderBottom: `1px solid ${BORDER}`, verticalAlign: 'top' };

export default function DailyChangeTab() {
  const [data,     setData]     = useState<DailyChangeResult | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const [selected, setSelected] = useState<string[]>(DEFAULT_TICKERS);
  const [sortKey,  setSortKey]  = useState<SortKey>('amount');
  const [sortAsc,  setSortAsc]  = useState(false);
  const [openId,   setOpenId]   = useState<string | null>(null);
  const [queryDate, setQueryDate] = useState('');            // ''＝最新持股日
  const [now,       setNow]       = useState(() => Date.now());
  const [lastTry,   setLastTry]   = useState<number | null>(null);

  const load = useCallback(async (opts: { date?: string; fresh?: boolean; live?: boolean } = {}) => {
    setLoading(true); setError('');
    try {
      const qs = new URLSearchParams();
      if (opts.date) qs.set('date', opts.date);
      if (opts.fresh) qs.set('fresh', '1');
      if (opts.live) qs.set('live', '1');
      const res  = await fetch(`/api/daily-change${qs.size ? `?${qs}` : ''}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json as DailyChangeResult);
      setLastTry(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    load();
  }, [load]);

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);

  /* 台北時間：今天日期、是否已過 18:00（各投信約 17:30 公告當日持股，資料庫約 17:40 入庫；18:00 起伺服器對尚未入庫的 ETF 直接問投信官網） */
  const tpe = useMemo(() => {
    const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', hourCycle: 'h23', ...o }).format(new Date(now));
    const ymd = f({ year: 'numeric', month: '2-digit', day: '2-digit' });
    const [h, m] = f({ hour: '2-digit', minute: '2-digit' }).split(':').map(Number);
    const wd = new Date(ymd + 'T00:00:00Z').getUTCDay();
    return { ymd, mins: h * 60 + m, weekday: wd >= 1 && wd <= 5 };
  }, [now]);

  const toggleTicker = (t: string) =>
    setSelected(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);

  const { rows, buy, sell } = useMemo(() => {
    const out: Row[] = [];
    let buyAmt = 0, sellAmt = 0;
    if (!data) return { rows: out, buy: 0, sell: 0 };
    const sel = new Set(selected);
    for (const s of data.stocks) {
      const ch = s.changes.filter(c => sel.has(c.ticker));
      if (!ch.length) continue;
      const pill = (c: { ticker: string; prev: number; cur: number }): Pill => ({
        ticker: c.ticker, shares: c.cur - c.prev,
        amount: s.close != null ? (c.cur - c.prev) * s.close : null,
        tag: c.prev === 0 ? '新' : c.cur === 0 ? '清' : undefined,
      });
      const adds = ch.filter(c => c.cur > c.prev).map(pill).sort((a, b) => Math.abs(b.amount ?? b.shares) - Math.abs(a.amount ?? a.shares));
      const cuts = ch.filter(c => c.cur < c.prev).map(pill).sort((a, b) => Math.abs(b.amount ?? b.shares) - Math.abs(a.amount ?? a.shares));
      const netShares = ch.reduce((sum, c) => sum + (c.cur - c.prev), 0);
      if (s.close != null) {
        for (const c of ch) {
          const amt = (c.cur - c.prev) * s.close;
          if (amt > 0) buyAmt += amt; else sellAmt += -amt;
        }
      }
      out.push({
        stockid: s.stockid, stockname: s.stockname, close: s.close, adds, cuts, netShares,
        amount: s.close != null ? netShares * s.close : null,
        detail: ch.map(c => ({ ticker: c.ticker, prev: c.prev, cur: c.cur })),
      });
    }
    return { rows: out, buy: buyAmt, sell: sellAmt };
  }, [data, selected]);

  const sorted = useMemo(() => {
    const dir = sortAsc ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortKey === 'stock') return dir * a.stockid.localeCompare(b.stockid);
      if (sortKey === 'lots')  return dir * (a.netShares - b.netShares);
      // 金額排序以絕對值為準；無報價者排最後
      const av = a.amount == null ? -Infinity : Math.abs(a.amount);
      const bv = b.amount == null ? -Infinity : Math.abs(b.amount);
      return dir * (av - bv);
    });
  }, [rows, sortKey, sortAsc]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc(p => !p);
    else { setSortKey(key); setSortAsc(key === 'stock'); }
  };
  const label = (key: SortKey, text: string) => sortKey === key ? `${text} ${sortAsc ? '↑' : '↓'}` : text;

  const selFunds = data?.funds.filter(f => selected.includes(f.ticker)) ?? [];
  const curDates = [...new Set(selFunds.map(f => f.curDate).filter(Boolean))] as string[];
  const noPrev = selFunds.filter(f => f.curDate && !f.prevDate);

  /* 18:00 之後、查「最新」時，今日持股還沒取得的 ETF（連官網即時也沒有）→ 每 3 分鐘自動重查，到 22:00 或全數更新為止 */
  const pending = !queryDate && tpe.weekday && tpe.mins >= 18 * 60 && tpe.mins < 22 * 60 && selected.length > 0 && data
    ? selFunds.filter(f => (f.curDate ?? '') < tpe.ymd) : [];
  const polling = pending.length > 0;
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => load({ fresh: true }), 3 * 60_000);   // 18:00 後伺服器會自動對落後的 ETF 問官網
    return () => clearInterval(t);
  }, [polling, load]);

  const chip = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: 999, fontSize: '.8rem', fontFamily: MONO, cursor: 'pointer',
    border: `1px solid ${active ? RED : BORDER}`, background: active ? RED : '#fff', color: active ? '#fff' : TEXT,
  });

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>
      <div style={{ fontSize: '.82rem', color: SUB, marginBottom: 12, lineHeight: 1.6 }}>
        各檔 ETF 最新持股日 vs 前一個持股日的個股加減碼（原始股數變動，未扣除申購贖回稀釋）。
        金額 = 變動股數 × 最新持股日收盤價。
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        {(data?.funds ?? DEFAULT_TICKERS.map(t => ({ ticker: t, name: '' }))).map(f => (
          <button key={f.ticker} onClick={() => toggleTicker(f.ticker)} style={chip(selected.includes(f.ticker))}
            title={f.name}>{f.ticker}{'live' in f && f.live ? ' ●' : ''}</button>
        ))}
        <button onClick={() => setSelected(DEFAULT_TICKERS)} style={{ ...chip(false), fontFamily: SANS }}>預設三檔</button>
        {data && <button onClick={() => setSelected(data.funds.map(f => f.ticker))} style={{ ...chip(false), fontFamily: SANS }}>全部 {data.funds.length} 檔</button>}
        <button onClick={() => load({ date: queryDate || undefined, fresh: true, live: !queryDate })} disabled={loading}
          title="繞過快取，直接向各投信官網查當下最新持股（約需 10～30 秒）"
          style={{ marginLeft: 'auto', padding: '6px 18px', background: loading ? '#999' : RED, color: '#fff', border: 'none', borderRadius: 6,
            cursor: loading ? 'not-allowed' : 'pointer', fontSize: '.84rem', fontWeight: 600, fontFamily: SANS }}>
          {loading ? '向投信官網查詢中…' : '強制查最新（問投信官網）'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14, fontSize: '.82rem' }}>
        <span style={{ color: SUB }}>查詢持股日</span>
        <input type="date" value={queryDate} max={tpe.ymd} onChange={e => { const v = e.target.value; setQueryDate(v); load({ date: v || undefined, fresh: true }); }}
          style={{ padding: '4px 8px', border: `1px solid ${BORDER}`, borderRadius: 6, fontFamily: MONO, fontSize: '.82rem' }} />
        <button onClick={() => { setQueryDate(''); load({ fresh: true }); }} style={{ ...chip(!queryDate), fontFamily: SANS }}>最新</button>
        <span style={{ color: SUB }}>{queryDate ? `顯示 ${queryDate} 相對其前一持股日的加減碼；該日沒資料的 ETF 會標示。` : '顯示各檔最新持股日。'}</span>
      </div>

      {polling && (
        <div style={{ fontSize: '.8rem', color: '#b45309', background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 6, padding: '8px 12px', marginBottom: 12, lineHeight: 1.6 }}>
          ⏳ 今日（{tpe.ymd}）持股尚未入庫：{pending.map(f => `${f.ticker}（${f.curDate ?? '無資料'}）`).join('、')}。
          各投信約 17:30 起公告（部分更晚）；18:00 起本頁會直接問投信官網，仍沒有的 ETF 表示投信尚未公布，本頁每 3 分鐘自動重查{lastTry ? `（上次 ${new Date(lastTry).toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' })}）` : ''}，更新後會直接換成今日資料。
        </div>
      )}
      {data && selFunds.some(f => f.live) && (
        <div style={{ fontSize: '.78rem', color: '#1d4ed8', marginBottom: 8, lineHeight: 1.6 }}>
          ● 即時取自投信官網（資料庫尚未入庫）：{selFunds.filter(f => f.live).map(f => `${f.ticker}（${f.curDate}）`).join('、')}
        </div>
      )}
      {data && selFunds.some(f => f.liveError) && (
        <div style={{ fontSize: '.78rem', color: '#b45309', marginBottom: 8, lineHeight: 1.6 }}>
          ⚠ 官網即時查詢失敗，沿用資料庫：{selFunds.filter(f => f.liveError).map(f => `${f.ticker}（${f.liveError}）`).join('、')}
        </div>
      )}
      {queryDate && data && selFunds.some(f => !f.curDate) && (
        <div style={{ fontSize: '.78rem', color: '#b45309', marginBottom: 8 }}>
          ⚠ {queryDate} 沒有持股資料的 ETF：{selFunds.filter(f => !f.curDate).map(f => f.ticker).join('、')}（休市日或尚未揭露）。
        </div>
      )}

      {error && <div style={{ color: RED, marginBottom: 12, fontSize: '.85rem' }}>⚠ {error}</div>}
      {loading && !data && <div style={{ color: SUB, padding: 24 }}>載入中…（首次約需數十秒）</div>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 10, fontSize: '.88rem' }}>
            <span>異動日期 <b style={{ fontFamily: MONO }}>{curDates.length ? curDates.join(' / ') : '—'}</b></span>
            <span>變動個股 <b style={{ fontFamily: MONO }}>{rows.length}</b> 檔</span>
            <span>合計買超 <b style={{ fontFamily: MONO, color: RED }}>{fmtMoneyPlain(buy)}</b></span>
            <span>合計賣超 <b style={{ fontFamily: MONO, color: GREEN }}>{fmtMoneyPlain(sell)}</b></span>
          </div>
          {curDates.length > 1 && (
            <div style={{ fontSize: '.78rem', color: '#b45309', marginBottom: 8 }}>
              ⚠ 所選 ETF 的最新持股日不一致：{selFunds.map(f => `${f.ticker} ${f.curDate ?? '無資料'}`).join('、')}
            </div>
          )}
          {(() => {
            // 只列離群的檔：前一持股日不是多數檔共同的那一天（通常是資料庫缺漏中間幾天 → 變動為跨多日累計）
            const withPrev = selFunds.filter(f => f.prevDate);
            const freq = new Map<string, number>();
            withPrev.forEach(f => freq.set(`${f.prevDate}|${f.curDate}`, (freq.get(`${f.prevDate}|${f.curDate}`) ?? 0) + 1));
            const mode = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
            const odd = withPrev.filter(f => `${f.prevDate}|${f.curDate}` !== mode);
            return odd.length > 0 && (
              <div style={{ fontSize: '.78rem', color: '#b45309', marginBottom: 8, lineHeight: 1.6 }}>
                ⚠ 比較基準日與多數檔不同，變動為跨多個交易日的累計（可能是資料庫缺漏中間幾天持股）：
                {odd.map(f => `${f.ticker} ${f.prevDate}→${f.curDate}`).join('、')}
              </div>
            );
          })()}
          {noPrev.length > 0 && (
            <div style={{ fontSize: '.78rem', color: '#b45309', marginBottom: 8 }}>
              ⚠ {noPrev.map(f => f.ticker).join('、')} 沒有可比較的前一持股日（資料庫尚無前一日，或間隔超過 14 天），未納入。
            </div>
          )}

          {selected.length === 0 ? (
            <div style={{ color: SUB, padding: 24 }}>請至少選一檔 ETF。</div>
          ) : rows.length === 0 ? (
            <div style={{ color: SUB, padding: 24 }}>所選 ETF 最新一日沒有持股變動。</div>
          ) : (
            <div className="mt" style={{ overflowX: 'auto', maxHeight: '70vh', border: `1px solid ${BORDER}`, borderRadius: 6 }}>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ ...TH, textAlign: 'left', cursor: 'pointer' }} onClick={() => toggleSort('stock')}>{label('stock', '個股')}</th>
                    <th style={{ ...TH, textAlign: 'left' }}>加碼 / 新倉 ETF</th>
                    <th style={{ ...TH, textAlign: 'left' }}>減碼 / 清倉 ETF</th>
                    <th style={{ ...TH, textAlign: 'right', cursor: 'pointer' }} onClick={() => toggleSort('lots')}>{label('lots', '淨變動張數')}</th>
                    <th style={{ ...TH, textAlign: 'right', cursor: 'pointer' }} onClick={() => toggleSort('amount')}>{label('amount', '變動金額')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(r => {
                    const open = openId === r.stockid;
                    return (
                      <FragmentRow key={r.stockid} r={r} open={open} onToggle={() => setOpenId(open ? null : r.stockid)} />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Pills({ items }: { items: Pill[] }) {
  if (!items.length) return <span style={{ color: SUB }}>—</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {items.map(p => {
        const c = dirColor(p.shares);
        return (
          <span key={p.ticker} className="m-pill" style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 12px', borderRadius: 999,
            border: `1px solid ${c}`, background: p.shares > 0 ? '#FDECEC' : '#E8F7EE',
            fontFamily: MONO, fontSize: '.8rem', whiteSpace: 'nowrap',
          }}>
            <b style={{ color: TEXT }}>{p.ticker}</b>
            {p.tag && <span style={{ color: c, fontSize: '.68rem' }}>({p.tag})</span>}
            <span style={{ color: c }}>{p.amount != null ? fmtMoney(p.amount) : `${fmtLots(p.shares)} 張`}</span>
          </span>
        );
      })}
    </div>
  );
}

function FragmentRow({ r, open, onToggle }: { r: Row; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer', background: open ? '#FAF7F4' : undefined }}>
        <td style={TD}>
          <span style={{ fontFamily: MONO, color: SUB, marginRight: 8 }}>{r.stockid}</span>
          <b>{r.stockname}</b>
        </td>
        <td style={TD}><Pills items={r.adds} /></td>
        <td style={TD}><Pills items={r.cuts} /></td>
        <td style={{ ...TD, textAlign: 'right', fontFamily: MONO, color: dirColor(r.netShares) }}>{fmtLots(r.netShares)}</td>
        <td style={{ ...TD, textAlign: 'right', fontFamily: MONO, color: dirColor(r.amount) }}>
          {r.amount == null ? <span style={{ color: SUB }}>—</span> : fmtMoney(r.amount)}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ ...TD, background: '#FAF7F4', padding: '10px 14px 14px' }}>
            <div style={{ fontSize: '.78rem', color: SUB, marginBottom: 6 }}>
              各檔持股張數（前一日 → 最新）{r.close != null ? `　收盤價 ${r.close}` : '　（無報價）'}
            </div>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontFamily: MONO, fontSize: '.8rem' }}>
              {r.detail.map(d => {
                const delta = d.cur - d.prev;
                return (
                  <span key={d.ticker}>
                    {d.ticker}　{(d.prev / 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })} → {(d.cur / 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                    <b style={{ color: dirColor(delta), marginLeft: 6 }}>({fmtLots(delta)})</b>
                  </span>
                );
              })}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
