'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RtPremiumRow } from '@/app/api/rt-premium/route';

/* ── 復華設計 token（與 Dashboard 一致）── */
const RED    = '#C00000';   // 溢價 = 紅（台股慣例）
const GREEN  = '#1A6B45';   // 折價 = 綠
const CARD   = '#FFFFFF';
const HEADER = '#F7F4F0';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#E8E3DF';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

const THRESHOLD = 1;          // 折溢價警示門檻（%，絕對值）
const POLL_MS = 60_000;       // 盤中每分鐘更新一次

/* 台北時間是否在盤中（週一～五 9:00–13:30）。假日由官網 f_workDay 另外判斷。 */
function inSession(now = new Date()): boolean {
  const t = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const d = t.getDay();
  const m = t.getHours() * 60 + t.getMinutes();
  return d >= 1 && d <= 5 && m >= 9 * 60 && m <= 13 * 60 + 30;
}

const fmt = (v: number | null, digits = 2) => v == null ? '—' : v.toFixed(digits);
const fmtPct = (v: number | null) => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
const colorOf = (v: number | null) => v == null || v === 0 ? TEXT : v > 0 ? RED : GREEN;

interface Hit { time: string; code: string; name: string; dpPct: number }

export default function RtPremiumTab() {
  const [rows, setRows] = useState<RtPremiumRow[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(false);
  const [hits, setHits] = useState<Hit[]>([]);       // 本次開啟頁面以來超過門檻的紀錄
  const overRef = useRef<Set<string>>(new Set());     // 目前在門檻外的基金（回到門檻內才會再記一次）

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/rt-premium', { cache: 'no-store' });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
      const list = j.rows as RtPremiumRow[];
      setRows(list);
      setError('');
      const newHits: Hit[] = [];
      for (const r of list) {
        const over = r.dpPct != null && Math.abs(r.dpPct) >= THRESHOLD;
        if (over && !overRef.current.has(r.code)) newHits.push({ time: r.time, code: r.code, name: r.name, dpPct: r.dpPct! });
        if (over) overRef.current.add(r.code); else overRef.current.delete(r.code);
      }
      if (newHits.length) setHits(h => [...newHits, ...h].slice(0, 50));
    } catch (e) {
      setError(e instanceof Error ? e.message : '讀取失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 進頁先載入一次
    load();
    const tick = () => {
      const on = inSession();
      setLive(on);
      if (on) load();
    };
    setLive(inSession());
    const id = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const th: React.CSSProperties = {
    padding: '10px 12px', background: HEADER, color: SUB, fontWeight: 600, fontSize: '.8rem',
    textAlign: 'right', borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap', fontFamily: SANS,
  };
  const td: React.CSSProperties = {
    padding: '10px 12px', textAlign: 'right', fontFamily: MONO, fontSize: '.88rem',
    borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap',
  };
  const updated = rows[0]?.time ?? '';
  const notWorkDay = rows.length > 0 && rows.every(r => !r.workDay);

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{
          padding: '4px 10px', borderRadius: 999, fontSize: '.78rem', fontWeight: 600,
          background: live ? '#FDECEC' : HEADER, color: live ? RED : SUB, border: `1px solid ${live ? RED : BORDER}`,
        }}>
          {live ? '● 盤中自動更新（每分鐘）' : '盤後／非交易時段（不自動更新）'}
        </span>
        <span style={{ fontSize: '.82rem', color: SUB }}>官網資料時間 {updated || '—'}</span>
        <button onClick={load} disabled={loading} style={{
          marginLeft: 'auto', padding: '6px 14px', background: '#fff', color: RED, border: `1.4px solid ${RED}`,
          borderRadius: 6, cursor: loading ? 'default' : 'pointer', fontSize: '.8rem', fontWeight: 600, fontFamily: SANS,
        }}>{loading ? '更新中…' : '立即更新'}</button>
      </div>

      {error && <div style={{ padding: 12, marginBottom: 12, borderRadius: 8, background: '#FDECEC', color: RED, fontSize: '.85rem' }}>讀取失敗：{error}</div>}
      {notWorkDay && <div style={{ padding: 12, marginBottom: 12, borderRadius: 8, background: HEADER, color: SUB, fontSize: '.85rem' }}>今天不是基金營業日，以下為最近一次資料。</div>}

      <div style={{ overflowX: 'auto', border: `1px solid ${BORDER}`, borderRadius: 10, background: CARD }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>基金</th>
              <th style={th}>昨收淨值</th>
              <th style={th}>預估淨值</th>
              <th style={th}>淨值漲跌</th>
              <th style={th}>最新市價</th>
              <th style={th}>市價漲跌</th>
              <th style={th}>即時折溢價</th>
              <th style={th}>折溢價幅度</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const over = r.dpPct != null && Math.abs(r.dpPct) >= THRESHOLD;
              return (
                <tr key={r.code} style={{ background: over ? (r.dpPct! > 0 ? '#FDECEC' : '#E8F3EC') : undefined }}>
                  <td style={{ ...td, textAlign: 'left', fontFamily: SANS }}>
                    <b style={{ fontFamily: MONO }}>{r.code}</b> <span style={{ color: SUB }}>{r.name}</span>
                    {over && <span style={{
                      marginLeft: 8, padding: '2px 8px', borderRadius: 999, fontSize: '.72rem', fontWeight: 700,
                      color: '#fff', background: r.dpPct! > 0 ? RED : GREEN,
                    }}>{r.dpPct! > 0 ? '溢價' : '折價'}超過 {THRESHOLD}%</span>}
                  </td>
                  <td style={td}>{fmt(r.prePnav)}<span style={{ color: SUB, fontSize: '.74rem' }}> ({r.preDate})</span></td>
                  <td style={td}>{fmt(r.pnav)}</td>
                  <td style={{ ...td, color: colorOf(r.pnavChgPct) }}>{fmtPct(r.pnavChgPct)}</td>
                  <td style={td}>{fmt(r.mVal)}</td>
                  <td style={{ ...td, color: colorOf(r.mValChgPct) }}>{fmtPct(r.mValChgPct)}</td>
                  <td style={{ ...td, color: colorOf(r.dp) }}>{fmt(r.dp)}</td>
                  <td style={{ ...td, color: colorOf(r.dpPct), fontWeight: over ? 700 : 400 }}>{fmtPct(r.dpPct)}</td>
                </tr>
              );
            })}
            {!rows.length && !error && (
              <tr><td colSpan={8} style={{ ...td, textAlign: 'center', color: SUB, fontFamily: SANS }}>{loading ? '載入中…' : '沒有資料'}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 18 }}>
        <div style={{ fontWeight: 700, fontSize: '.92rem', marginBottom: 6 }}>超過 ±{THRESHOLD}% 紀錄（本次開啟頁面以來）</div>
        {hits.length === 0
          ? <div style={{ fontSize: '.84rem', color: SUB }}>目前沒有基金超過門檻。</div>
          : <ul style={{ margin: 0, paddingLeft: 18, fontSize: '.86rem', lineHeight: 1.8 }}>
              {hits.map((h, i) => (
                <li key={i}>
                  <span style={{ fontFamily: MONO, color: SUB, marginRight: 14 }}>{h.time}</span>
                  <b>{h.code}</b> {h.name}
                  <span style={{ color: colorOf(h.dpPct), fontWeight: 700, marginLeft: 14 }}>{fmtPct(h.dpPct)}</span>
                </li>
              ))}
            </ul>}
      </div>

      <p style={{ marginTop: 16, fontSize: '.76rem', color: SUB, lineHeight: 1.7 }}>
        資料來源：復華投信官網「即時預估淨值」（每個營業日 8:30–17:00 更新）。預估淨值以前一日持股估算，不含當日交易，與實際淨值可能有差異。
        折溢價 =（最新市價 − 預估淨值）÷ 預估淨值；正值為溢價（紅）、負值為折價（綠）。本頁開著時，週一至週五 9:00–13:30 每分鐘自動更新。
      </p>
    </div>
  );
}
