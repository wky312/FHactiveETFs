'use client';

import { useState } from 'react';
import { useIsMobile } from '@/lib/useIsMobile';
import type { FactPack, Periods, ChangeSet } from '@/lib/complaint/facts';

/* 客訴回覆助手（內部用，密碼閘門）。資料與文字都在 /api/complaint 產生；這裡只管輸入、顯示、編輯、複製。 */

const RED = '#C00000', GREEN = '#1E7B34', GOLD = '#B08F6E', TEXT = '#1C1C1E', SUB = '#6B6460';
const BORDER = '#E8E3DF', HEADER = '#F7F4F0', MONO = "'IBM Plex Mono', 'Courier New', monospace";

const FUNDS = [
  { ticker: '00991A', short: '主動復華未來50' },
  { ticker: '00418A', short: '主動復華台灣新星' },
  { ticker: '00998A', short: '主動復華全球金融' },
  { ticker: '00409A', short: '主動復華全球50' },
];
const SCENARIOS = [
  { id: 'short_drop', label: '短期下跌／虧損' },
  { id: 'lag',        label: '落後大盤或同業' },
  { id: 'entry_loss', label: '買在高點套牢' },
  { id: 'manager',    label: '經理人在做什麼' },
];
const PERIODS: [keyof Periods, string][] = [['d1', '1日'], ['wtd', '本週'], ['mtd', '本月'], ['m1', '1個月'], ['m3', '3個月'], ['ytd', '今年']];
const KEY_STORE = 'complaint-key';

interface ApiResult {
  facts: FactPack; reply: string; draft: string;
  source: 'gemini' | 'template'; model: string | null; warnings: string[]; aiNote: string | null;
}

const pctColor = (v: number | null | undefined) => (v == null ? SUB : v > 0 ? RED : v < 0 ? GREEN : TEXT); // 台股慣例：紅漲綠跌
const fmt = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} style={{
      padding: '7px 14px', borderRadius: 999, fontSize: '.85rem', cursor: 'pointer',
      border: `1px solid ${on ? RED : BORDER}`, background: on ? RED : '#fff', color: on ? '#fff' : TEXT,
      fontWeight: on ? 600 : 400,
    }}>{children}</button>
  );
}

const label: React.CSSProperties = { display: 'block', fontSize: '.78rem', color: SUB, marginBottom: 6, fontWeight: 500 };
const input: React.CSSProperties = { padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.9rem', width: '100%', boxSizing: 'border-box', background: '#fff', color: TEXT };
const section: React.CSSProperties = { minWidth: 0, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 14, background: '#fff' };
const h4: React.CSSProperties = { margin: '0 0 10px', fontSize: '.92rem', color: TEXT, fontWeight: 700 };

function Changes({ title, c }: { title: string; c: ChangeSet | null }) {
  if (!c) return null;
  const rows: [string, string, string][] = [
    ...c.increased.map(m => ['加碼', m.name, `${m.from.toFixed(2)}→${m.to.toFixed(2)}%`] as [string, string, string]),
    ...c.added.map(m => ['新增', m.name, `${m.weight.toFixed(2)}%`] as [string, string, string]),
    ...c.decreased.map(m => ['調降', m.name, `${m.from.toFixed(2)}→${m.to.toFixed(2)}%`] as [string, string, string]),
    ...c.exited.map(m => ['出清', m.name, `原 ${m.prevWeight.toFixed(2)}%`] as [string, string, string]),
  ];
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: '.8rem', color: SUB, marginBottom: 4 }}>{title}（{c.fromDate} → {c.toDate}）</div>
      {rows.length === 0 ? <div style={{ fontSize: '.85rem' }}>持股結構大致維持</div> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.84rem' }}>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderTop: `1px solid ${BORDER}` }}>
                <td style={{ padding: '4px 6px', width: 44, color: r[0] === '加碼' || r[0] === '新增' ? RED : GREEN, fontWeight: 600 }}>{r[0]}</td>
                <td style={{ padding: '4px 6px' }}>{r[1]}</td>
                <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: MONO }}>{r[2]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function FactsCard({ f }: { f: FactPack }) {
  const rows: { name: string; p: Periods; bold?: boolean }[] = [
    { name: f.ticker + ' 本基金', p: f.fund, bold: true },
    ...f.benches.map(b => ({ name: b.name, p: b.periods })),
    { name: `同業平均（${f.peerCount}檔）`, p: f.peerAvg },
  ];
  return (
    <div style={section}>
      <h4 style={h4}>事實摘要 <span style={{ fontWeight: 400, color: SUB, fontSize: '.78rem' }}>績效資料日 {f.asOf ?? '—'}</span></h4>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.84rem', minWidth: 460 }}>
          <thead>
            <tr style={{ background: HEADER }}>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>標的</th>
              {PERIODS.map(([, l]) => <th key={l} style={{ textAlign: 'right', padding: '6px 8px' }}>{l}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.name} style={{ borderTop: `1px solid ${BORDER}`, fontWeight: r.bold ? 700 : 400 }}>
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{r.name}</td>
                {PERIODS.map(([k]) => (
                  <td key={k} style={{ padding: '6px 8px', textAlign: 'right', fontFamily: MONO, color: pctColor(r.p[k]) }}>{fmt(r.p[k])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: '.82rem', color: SUB, marginTop: 8, lineHeight: 1.7 }}>
        {f.sinceListing != null && <div>掛牌以來（{f.listingDate}，首日收盤為基準）：<b style={{ color: pctColor(f.sinceListing) }}>{fmt(f.sinceListing)}</b>（{f.tradingDaysSinceListing} 個交易日）</div>}
        {f.ranks.length > 0 && <div>同類排名：{f.ranks.map(r => `${r.label} ${r.rank}/${r.total}`).join('　')}</div>}
        {f.drawdown.fund && <div>距近期高點：本基金 {fmt(f.drawdown.fund.ddPct)}（高點 {f.drawdown.fund.peakDate}）{f.drawdown.bench && `；${f.drawdown.bench.name} ${fmt(f.drawdown.bench.ddPct)}`}</div>}
        {f.contributors && (
          <div>{f.contributors.period}前十大估算貢獻：
            {[...f.contributors.top, ...f.contributors.bottom].map(c => (
              <span key={c.code} style={{ marginRight: 10, color: pctColor(c.contrib) }}>{c.name} {c.contrib > 0 ? '+' : ''}{c.contrib.toFixed(2)}pp</span>
            ))}
          </div>
        )}
        {f.entry && <div>進場 {f.entry.date}（以 {f.entry.entryPriceDate} 收盤）：至今 <b style={{ color: pctColor(f.entry.fundReturn) }}>{fmt(f.entry.fundReturn)}</b>，期間最高 {fmt(f.entry.highSinceEntry)}，距高點 {fmt(f.entry.fromHighPct)}；同期 {f.entry.benchName} {fmt(f.entry.benchReturn)}</div>}
        {f.notes.map(n => <div key={n} style={{ color: GOLD }}>※ {n}</div>)}
      </div>
      {f.holdings.top10.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: '.8rem', color: SUB, marginBottom: 4 }}>前十大持股（{f.holdings.latestDate}）</div>
          <div style={{ fontSize: '.84rem', lineHeight: 1.8 }}>
            {f.holdings.top10.map(t => <span key={t.code} style={{ marginRight: 12, whiteSpace: 'nowrap' }}>{t.name} <span style={{ fontFamily: MONO, color: SUB }}>{t.weight.toFixed(2)}%</span></span>)}
          </div>
        </div>
      )}
      <Changes title="近一週持股調整" c={f.holdings.short} />
      <Changes title="近一個月持股調整" c={f.holdings.long} />
    </div>
  );
}

export default function ComplaintTab({ defaultTicker }: { defaultTicker: string }) {
  const isMobile = useIsMobile();
  // 分頁只在進站後依 ?tab= 掛載（不參與 SSR hydration），可以直接用 lazy init 讀 sessionStorage
  const [key, setKey] = useState(() => {
    try { return typeof window === 'undefined' ? '' : sessionStorage.getItem(KEY_STORE) ?? ''; } catch { return ''; }
  });
  const [ticker, setTicker] = useState(FUNDS.some(f => f.ticker === defaultTicker) ? defaultTicker : FUNDS[0].ticker);
  const [scen, setScen] = useState<string[]>(['short_drop']);
  const [entryDate, setEntryDate] = useState('');
  const [msg, setMsg] = useState('');
  const [useAi, setUseAi] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<ApiResult | null>(null);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);

  const toggle = (id: string) => setScen(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]));

  async function generate() {
    setLoading(true); setErr(null); setCopied(false);
    try {
      const r = await fetch('/api/complaint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-complaint-key': key },
        body: JSON.stringify({ ticker, scenarios: scen, entryDate: scen.includes('entry_loss') ? entryDate : '', customerMessage: msg, useAi }),
        cache: 'no-store',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(j.error ?? `錯誤 ${r.status}`);
        if (r.status === 401) { try { sessionStorage.removeItem(KEY_STORE); } catch { /* */ } }
        return;
      }
      try { sessionStorage.setItem(KEY_STORE, key); } catch { /* */ }
      setRes(j as ApiResult);
      setText((j as ApiResult).reply);
    } catch {
      setErr('連線失敗，請稍後再試');
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch { setErr('瀏覽器不允許自動複製，請手動選取文字'); }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 14, color: TEXT, minWidth: 0 }}>
      <div style={{ fontSize: '.82rem', color: SUB, lineHeight: 1.7 }}>
        內部使用：依真實績效、市場與持股調整產生客訴回覆底稿。<b>送出前請務必人工確認內容與數字</b>，系統會自動附上法定警語並標示可疑用語。
      </div>

      <div style={{ ...section, display: 'grid', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0,1fr)' : '220px minmax(0,1fr)', gap: 14 }}>
          <div>
            <label style={label} htmlFor="ck">內部密碼</label>
            <input id="ck" type="password" autoComplete="current-password" value={key} onChange={e => setKey(e.target.value)} style={input} placeholder="輸入密碼" />
          </div>
          <div>
            <span style={label}>基金</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {FUNDS.map(f => <Chip key={f.ticker} on={ticker === f.ticker} onClick={() => setTicker(f.ticker)}>{f.ticker} {f.short}</Chip>)}
            </div>
          </div>
        </div>
        <div>
          <span style={label}>客戶抱怨情境（可複選）</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {SCENARIOS.map(s => <Chip key={s.id} on={scen.includes(s.id)} onClick={() => toggle(s.id)}>{s.label}</Chip>)}
          </div>
        </div>
        {scen.includes('entry_loss') && (
          <div style={{ maxWidth: 220 }}>
            <label style={label} htmlFor="ed">客戶進場日（選填）</label>
            <input id="ed" type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)} style={input} />
          </div>
        )}
        <div>
          <label style={label} htmlFor="cm">客戶原文（選填，1,000 字內；幫助 AI 抓重點，請先去除姓名、電話等個資）</label>
          <textarea id="cm" value={msg} onChange={e => setMsg(e.target.value.slice(0, 1000))} rows={3} style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
          <button type="button" onClick={generate} disabled={loading || !key || !scen.length} style={{
            padding: '9px 22px', background: loading || !key || !scen.length ? '#ccc' : RED, color: '#fff', border: 'none',
            borderRadius: 6, fontSize: '.92rem', fontWeight: 600, cursor: loading ? 'wait' : 'pointer',
          }}>{loading ? '整理資料中…（約 10–30 秒）' : res ? '重新產生' : '產生回覆'}</button>
          <label style={{ fontSize: '.85rem', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={useAi} onChange={e => setUseAi(e.target.checked)} /> 使用 AI 潤飾（Gemini）
          </label>
        </div>
        {err && <div style={{ color: RED, fontSize: '.88rem' }}>{err}</div>}
      </div>

      {res && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0,1fr)' : 'minmax(0,1.15fr) minmax(0,1fr)', gap: 14, alignItems: 'start' }}>
          <div style={section}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <h4 style={{ ...h4, margin: 0 }}>回覆底稿</h4>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: '.75rem', padding: '2px 8px', borderRadius: 999, background: res.source === 'gemini' ? '#EEF4FF' : HEADER, color: res.source === 'gemini' ? '#2851A3' : SUB }}>
                  {res.source === 'gemini' ? `AI 潤飾 · ${res.model}` : '規則模板'}
                </span>
                {res.source === 'gemini' && (
                  <button type="button" onClick={() => setText(text === res.draft ? res.reply : res.draft)} style={{ fontSize: '.78rem', border: `1px solid ${BORDER}`, background: '#fff', borderRadius: 6, padding: '4px 8px', cursor: 'pointer' }}>
                    {text === res.draft ? '看 AI 版' : '看模板版'}
                  </button>
                )}
                <button type="button" onClick={copy} style={{ fontSize: '.82rem', border: 'none', background: copied ? GREEN : GOLD, color: '#fff', borderRadius: 6, padding: '5px 12px', cursor: 'pointer' }}>
                  {copied ? '已複製' : '複製'}
                </button>
              </div>
            </div>
            {res.aiNote && <div style={{ fontSize: '.8rem', color: GOLD, marginBottom: 8 }}>{res.aiNote}</div>}
            {res.warnings.length > 0 && (
              <div style={{ border: `1px solid #F2C94C`, background: '#FFF8E1', borderRadius: 6, padding: '8px 10px', marginBottom: 10, fontSize: '.82rem', lineHeight: 1.7 }}>
                <b>法遵提醒：</b>
                {res.warnings.map(w => <div key={w}>• {w}</div>)}
              </div>
            )}
            <textarea value={text} onChange={e => setText(e.target.value)} rows={isMobile ? 18 : 24}
              style={{ ...input, fontFamily: 'inherit', lineHeight: 1.8, resize: 'vertical', fontSize: '.92rem' }} />
          </div>
          <FactsCard f={res.facts} />
        </div>
      )}
    </div>
  );
}
