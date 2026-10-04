'use client';
import { useState } from 'react';
import { SectorExposureResult, SectorFundRow } from '@/lib/sectorExposure';

/* 手機版族群曝險：矩陣表在 390px 寬度下，固定的 ETF 欄就吃掉一半畫面、旁邊的個股欄只能一欄一欄滑。
   改成「排行清單」：每檔 ETF 一列，只顯示目前排序依據的那個數字＋橫條，點開才看各股明細；
   各股的全市場統計（等權/市值加權/持有檔數）轉置成一張只有 4 欄的小表，手機也放得下。 */

const RED    = '#C00000';
const CARD   = '#FFFFFF';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";

function pct(v: number, d = 2): string { return v.toFixed(d) + '%'; }
function shortDate(d: string | null): string { return d ? d.slice(5).replace('-', '/') : '—'; }

interface Props {
  result: SectorExposureResult;
  rows: SectorFundRow[];          // 已依 sortBy / onlyHolders 處理過
  sortBy: string;                 // 'group' | stockid
  onSort: (k: string) => void;
  showMkt: boolean;               // 國內才有規模與市值加權
}

export default function SectorExposureMobileList({ result, rows, sortBy, onSort, showMkt }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const metric = (f: SectorFundRow) => (sortBy === 'group' ? f.groupWeight : f.weights[sortBy] ?? 0);
  const max = Math.max(...rows.map(metric), 0.0001);
  const multi = result.stocks.length > 1;
  const sortLabel = sortBy === 'group' ? '族群合計' : result.stocks.find(s => s.stockid === sortBy)?.stockname ?? sortBy;

  return (
    <div>
      {/* 排序依據：取代桌機版「點表頭排序」 */}
      {multi && (
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 6, marginBottom: 6, WebkitOverflowScrolling: 'touch' }}>
          {[{ k: 'group', label: '族群合計' }, ...result.stocks.map(s => ({ k: s.stockid, label: s.stockname }))].map(({ k, label }) => (
            <button key={k} onClick={() => onSort(k)}
              style={{ flex: '0 0 auto', padding: '5px 12px', borderRadius: 14, fontSize: '.76rem', cursor: 'pointer',
                border: `1px solid ${sortBy === k ? RED : BORDER}`, background: sortBy === k ? RED : CARD,
                color: sortBy === k ? '#fff' : SUB, fontWeight: sortBy === k ? 700 : 500 }}>
              {label}
            </button>
          ))}
        </div>
      )}

      <div style={{ fontSize: '.7rem', color: SUB, display: 'flex', justifyContent: 'space-between', padding: '0 2px 4px' }}>
        <span>ETF（持股日{showMkt ? '・規模' : ''}）</span>
        <span>{sortLabel} 佔比{multi ? '・點列看明細' : ''}</span>
      </div>

      <div style={{ border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden' }}>
        {rows.map((f, i) => {
          const v = metric(f);
          const isOpen = open === f.ticker;
          const held = result.stocks
            .map(s => ({ s, w: f.weights[s.stockid] ?? 0 }))
            .filter(x => x.w > 0)
            .sort((a, b) => b.w - a.w);
          return (
            <div key={f.ticker} style={{ borderTop: i ? `1px solid ${BORDER}` : 'none', background: isOpen ? '#FBF8F5' : CARD }}>
              <div onClick={() => multi && setOpen(isOpen ? null : f.ticker)}
                style={{ padding: '9px 12px', cursor: multi ? 'pointer' : 'default' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: '.84rem', flex: '0 0 auto' }}>{f.ticker}</span>
                  <span style={{ fontSize: '.74rem', color: SUB, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.name}
                  </span>
                  <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: '.92rem', color: v > 0 ? RED : '#C9C4BF', flex: '0 0 auto' }}>
                    {v > 0 ? pct(v) : '–'}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 }}>
                  <div style={{ flex: 1, height: 6, background: '#F3EFEB', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${(v / max) * 100}%`, height: '100%', background: RED, opacity: .75, borderRadius: 3 }} />
                  </div>
                  <span style={{ fontFamily: MONO, fontSize: '.66rem', color: SUB, flex: '0 0 auto' }}>
                    {shortDate(f.holdingDate)}{showMkt && f.navProxy != null ? `・${(f.navProxy / 1e8).toFixed(0)}億` : ''}
                  </span>
                  {multi && <span style={{ fontSize: '.66rem', color: SUB, flex: '0 0 auto' }}>{isOpen ? '▲' : '▼'}</span>}
                </div>
              </div>

              {isOpen && (
                <div style={{ padding: '0 12px 10px', display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 4, columnGap: 10, fontSize: '.76rem' }}>
                  {held.map(({ s, w }) => (
                    <div key={s.stockid} style={{ display: 'contents' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <span style={{ fontFamily: MONO, color: SUB, marginRight: 6 }}>{s.stockid}</span>{s.stockname}
                      </span>
                      <span style={{ fontFamily: MONO, textAlign: 'right', fontWeight: w >= 5 ? 700 : 500 }}>{pct(w)}</span>
                    </div>
                  ))}
                  {held.length < result.stocks.length && (
                    <span style={{ gridColumn: '1 / -1', color: SUB, fontSize: '.7rem' }}>
                      未持有：{result.stocks.filter(s => !(f.weights[s.stockid] > 0)).map(s => s.stockname).join('、')}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 各股全市場統計（桌機版的 tfoot，轉置成直的） */}
      <div style={{ fontSize: '.78rem', fontWeight: 600, margin: '14px 2px 6px' }}>各股全市場統計</div>
      <div style={{ border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '.74rem' }}>
          <thead>
            <tr style={{ background: '#1C1C1E', color: '#fff' }}>
              <th style={{ padding: '7px 8px', textAlign: 'left', fontWeight: 600 }}>個股</th>
              <th style={{ padding: '7px 8px', textAlign: 'right', fontWeight: 600 }}>等權</th>
              {showMkt && <th style={{ padding: '7px 8px', textAlign: 'right', fontWeight: 600 }}>市值加權</th>}
              <th style={{ padding: '7px 8px', textAlign: 'right', fontWeight: 600 }}>持有</th>
            </tr>
          </thead>
          <tbody>
            {result.stocks.map(s => (
              <tr key={s.stockid} style={{ borderTop: `1px solid ${BORDER}` }}>
                <td style={{ padding: '6px 8px', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.stockname}<span style={{ fontFamily: MONO, color: SUB, marginLeft: 4, fontSize: '.66rem' }}>{s.stockid}</span>
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: MONO }}>{pct(s.equalAvg)}</td>
                {showMkt && <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: MONO, color: RED, fontWeight: 600 }}>{pct(s.mktWeight)}</td>}
                <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: MONO, color: SUB }}>{s.heldBy}</td>
              </tr>
            ))}
            {multi && (
              <tr style={{ borderTop: `2px solid ${TEXT}`, background: '#F7F4F0', fontWeight: 700 }}>
                <td style={{ padding: '6px 8px' }}>族群合計</td>
                <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: MONO }}>{pct(result.totals.equalAvg)}</td>
                {showMkt && <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: MONO, color: RED }}>{pct(result.totals.mktWeight)}</td>}
                <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: MONO, color: SUB }}>{result.totals.heldByAny}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
