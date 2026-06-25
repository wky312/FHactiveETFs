'use client';
import { useState, useMemo, useRef, useCallback } from 'react';

/* 全 19 檔主動式 ETF「同區間選股」互動四象限散佈圖。
   X＝進場勝率、Y＝賺賠比(或進場報酬)、泡泡大小＝本期投入金額。
   台股配色：紅=強/賺、綠=弱/賠。右上＝高勝率高賺賠的精準經理人。 */

const RED    = '#C00000';
const GREEN  = '#16a34a';
const GOLD   = '#B08F6E';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";
const HIGHLIGHT = '00991A';

export interface QuadFund {
  ticker: string; name: string; issuer: string;
  nPicks: number; winRate: number | null;
  weightedReturn: number | null; payoff: number | null; investedK: number | null;
}

type YKey = 'payoff' | 'weightedReturn';
const Y_OPTS: { key: YKey; label: string; divider: number; unit: string }[] = [
  { key: 'payoff',         label: '賺賠比',   divider: 1, unit: '' },
  { key: 'weightedReturn', label: '進場報酬', divider: 0, unit: '%' },
];

const W = 720, H = 460;
const M = { top: 24, right: 20, bottom: 46, left: 52 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

export default function MarketQuadrant({ funds, startDate, endDate }: { funds: QuadFund[]; startDate: string; endDate: string }) {
  const [yKey, setYKey] = useState<YKey>('payoff');
  const [hover, setHover] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const yOpt = Y_OPTS.find(o => o.key === yKey)!;

  // 可繪製：勝率與該 Y 值皆有(payoff 為 null＝無輸家，特別處理)
  const plotItems = useMemo(() => funds.filter(f => f.winRate != null), [funds]);

  // Y 值（payoff 為 null 視為「無輸家」→ 置頂）
  const yVals = plotItems.map(f => (yKey === 'payoff' ? f.payoff : f.weightedReturn)).filter((v): v is number => v != null);
  const yMaxData = yVals.length ? Math.max(...yVals) : 1;
  const yMinData = yVals.length ? Math.min(...yVals) : 0;
  const yTop = yKey === 'payoff' ? Math.max(yMaxData * 1.15, yOpt.divider * 1.5) : yMaxData + (yMaxData - yMinData) * 0.12 + 1;
  const yBot = yKey === 'payoff' ? 0 : yMinData - (yMaxData - yMinData) * 0.12 - 1;

  const xOf = (winRate: number) => M.left + (winRate / 100) * PW;
  const yOf = (v: number) => M.top + (1 - (v - yBot) / (yTop - yBot)) * PH;
  // 泡泡半徑：面積 ∝ 投入金額
  const invMax = Math.max(1, ...plotItems.map(f => f.investedK ?? 0));
  const rOf = (inv: number | null) => 6 + Math.sqrt((inv ?? 0) / invMax) * 22;

  const bubbles = plotItems.map(f => {
    const raw = yKey === 'payoff' ? f.payoff : f.weightedReturn;
    const isNullPayoff = yKey === 'payoff' && f.payoff == null;
    const yv = raw ?? yTop;                 // 無輸家 → 置頂
    return { f, x: xOf(f.winRate!), y: yOf(yv), r: rOf(f.investedK), isNullPayoff };
  });

  const saveImage = useCallback(async () => {
    const el = cardRef.current; if (!el) return;
    try {
      await document.fonts.ready;
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
      const link = document.createElement('a');
      link.download = `主動ETF選股四象限_${startDate}_${endDate}.jpg`;
      link.href = canvas.toDataURL('image/jpeg', 0.92); link.click();
    } catch (e) { console.error('截圖失敗', e); }
  }, [startDate, endDate]);

  const xDiv = xOf(50);
  const yDiv = yOf(yOpt.divider);
  const hf = hover ? bubbles.find(b => b.f.ticker === hover) : null;

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontSize: '.78rem', color: SUB }}>縱軸：</span>
        {Y_OPTS.map(o => (
          <button key={o.key} onClick={() => setYKey(o.key)}
            style={{
              padding: '6px 12px', borderRadius: 999, cursor: 'pointer', fontFamily: SANS, fontSize: '.8rem',
              border: `1px solid ${yKey === o.key ? RED : BORDER}`,
              background: yKey === o.key ? RED : '#fff', color: yKey === o.key ? '#fff' : SUB,
              fontWeight: yKey === o.key ? 700 : 500,
            }}>{o.label}</button>
        ))}
        <button onClick={saveImage}
          style={{ marginLeft: 'auto', padding: '6px 12px', background: '#fff', color: SUB, border: `1px solid ${BORDER}`, borderRadius: 6, cursor: 'pointer', fontSize: '.78rem', fontFamily: SANS }}>
          儲存圖
        </button>
      </div>

      <div ref={cardRef} style={{ background: '#fff', padding: '6px 4px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
          <span style={{ fontWeight: 700, fontSize: '1rem' }}>主動式ETF 選股四象限</span>
          <span style={{ fontSize: '.76rem', color: SUB, fontFamily: MONO }}>{startDate} ～ {endDate}　泡泡＝投入金額</span>
        </div>

        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}
          onMouseLeave={() => setHover(null)}>
          {/* 象限底色：右上(高勝率高賺賠)淡紅、左下淡綠 */}
          <rect x={xDiv} y={M.top} width={M.left + PW - xDiv} height={yDiv - M.top} fill="#FFF6F4" />
          <rect x={M.left} y={yDiv} width={xDiv - M.left} height={M.top + PH - yDiv} fill="#F4FAF5" />
          {/* 邊框 */}
          <rect x={M.left} y={M.top} width={PW} height={PH} fill="none" stroke={BORDER} />
          {/* 中分線 */}
          <line x1={xDiv} y1={M.top} x2={xDiv} y2={M.top + PH} stroke="#D9C9BC" strokeDasharray="4 3" />
          <line x1={M.left} y1={yDiv} x2={M.left + PW} y2={yDiv} stroke="#D9C9BC" strokeDasharray="4 3" />
          {/* X 軸刻度(勝率) */}
          {[0, 25, 50, 75, 100].map(t => (
            <g key={t}>
              <text x={xOf(t)} y={M.top + PH + 16} textAnchor="middle" fontSize={10} fill={SUB} fontFamily={MONO}>{t}%</text>
            </g>
          ))}
          <text x={M.left + PW / 2} y={H - 6} textAnchor="middle" fontSize={11} fill={TEXT}>進場勝率 →</text>
          {/* Y 軸標題 */}
          <text x={14} y={M.top + PH / 2} textAnchor="middle" fontSize={11} fill={TEXT}
            transform={`rotate(-90 14 ${M.top + PH / 2})`}>{yOpt.label} ↑</text>
          {/* Y 刻度：分隔值與上下界 */}
          {[yBot, yOpt.divider, yTop].map((v, k) => (
            <text key={k} x={M.left - 6} y={yOf(v) + 3} textAnchor="end" fontSize={10} fill={SUB} fontFamily={MONO}>
              {yKey === 'payoff' ? v.toFixed(1) : `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`}
            </text>
          ))}
          {/* 象限提示字 */}
          <text x={M.left + PW - 6} y={M.top + 14} textAnchor="end" fontSize={10} fill={RED} opacity={0.7}>精準（高勝率·高{yOpt.label}）</text>

          {/* 泡泡 */}
          {bubbles.map(b => {
            const hi = b.f.ticker === HIGHLIGHT;
            const active = hover === b.f.ticker;
            const fill = hi ? GOLD : (b.f.winRate! >= 50 ? RED : GREEN);
            return (
              <g key={b.f.ticker} onMouseEnter={() => setHover(b.f.ticker)} style={{ cursor: 'pointer' }}>
                <circle cx={b.x} cy={b.y} r={b.r}
                  fill={fill} fillOpacity={active ? 0.5 : 0.26}
                  stroke={fill} strokeWidth={hi ? 2.4 : active ? 2 : 1.2}
                  strokeDasharray={b.isNullPayoff ? '3 2' : undefined} />
                <text x={b.x} y={b.y + 3} textAnchor="middle" fontSize={9.5} fontFamily={MONO}
                  fill={hi ? '#7a5a3a' : TEXT} fontWeight={hi ? 700 : 500}>{b.f.ticker}</text>
              </g>
            );
          })}
        </svg>

        {/* hover / 預設提示 */}
        <div style={{ minHeight: 22, marginTop: 2, fontSize: '.8rem', fontFamily: MONO, color: SUB, textAlign: 'center' }}>
          {hf
            ? <span><b style={{ color: hf.f.ticker === HIGHLIGHT ? GOLD : TEXT, fontFamily: SANS }}>{hf.f.ticker} {hf.f.name}</b>　勝率 {hf.f.winRate!.toFixed(0)}%　賺賠比 {hf.f.payoff == null ? '∞(無輸家)' : hf.f.payoff.toFixed(2)}　進場報酬 {hf.f.weightedReturn == null ? '—' : `${hf.f.weightedReturn >= 0 ? '+' : ''}${hf.f.weightedReturn.toFixed(1)}%`}　投入 {hf.f.investedK == null ? '—' : Math.round(hf.f.investedK).toLocaleString() + '仟'}　加碼 {hf.f.nPicks} 檔</span>
            : <span style={{ opacity: 0.6 }}>滑鼠移到泡泡上看細節；<span style={{ color: GOLD }}>金色＝復華未來50</span>，泡泡大小＝本期投入金額</span>}
        </div>

        <div style={{ marginTop: 8, fontSize: '.7rem', color: SUB, lineHeight: 1.8 }}>
          <b>讀法：</b>X＝進場勝率、Y＝{yOpt.label}、泡泡大小＝本期投入金額。<b>右上＝高勝率高{yOpt.label}</b>（選股又準又會凹，精準經理人）；左下＝又不準又賠。虛線泡泡＝本區間無輸家（賺賠比視為 ∞，置頂）。口徑同總覽表：本區間加碼股數×當日成交均價＝進場成本，與現價比。報酬未還原息。
        </div>
      </div>
    </div>
  );
}
