'use client';
import { useMemo } from 'react';
import type { GicsExposureResult } from '@/lib/gicsExposure';

/* 「族群曝險 → 海外GICS分類」的彙總表：列＝ETF、欄＝GICS 11 大類別（有未對應持股時多一欄）。
   點欄標題＝依該類別權重排序並在下方展開個股明細（列＝個股、欄＝ETF），
   個股明細是縱向清單，所以不受「一檔一欄」表格的 30 檔上限限制。
   樣式常數與 SectorExposureTab.tsx 同色系；那邊沒有 export，這裡照抄一份避免循環 import。 */

const RED    = '#C00000';
const GOLD   = '#B08F6E';
const CARD   = '#FFFFFF';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";

const TH: React.CSSProperties = {
  padding: '9px 10px', fontWeight: 600, fontSize: '.74rem', background: '#1C1C1E', color: '#fff',
  whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1,
};

const pct = (v: number, d = 2) => v.toFixed(d) + '%';

/** 類別加總動輒 20~80%，色階到 30% 封頂（個股表是 10%）。 */
function heat(w: number): React.CSSProperties {
  if (w <= 0) return { color: '#C9C4BF' };
  const a = Math.min(w / 30, 1);
  return { background: `rgba(192,0,0,${(a * 0.2).toFixed(3)})`, color: TEXT, fontWeight: w >= 15 ? 700 : 500 };
}
function heatStock(w: number): React.CSSProperties {
  if (w <= 0) return { color: '#C9C4BF' };
  const a = Math.min(w / 10, 1);
  return { background: `rgba(192,0,0,${(a * 0.16).toFixed(3)})`, color: TEXT, fontWeight: w >= 5 ? 700 : 500 };
}

export default function GicsExposureView({ data, sec, onSec }: {
  data: GicsExposureResult;
  sec: string | null;                    // 目前展開的類別 id
  onSec: (id: string | null) => void;
}) {
  const current = data.sectors.find(s => s.id === sec) ?? null;

  const fundRows = useMemo(() => {
    if (!current) return data.funds;
    return [...data.funds].sort((a, b) => (b.bySector[current.id] ?? 0) - (a.bySector[current.id] ?? 0));
  }, [data, current]);

  const toggle = (id: string) => onSec(sec === id ? null : id);

  return (
    <>
      <div className="mt" style={{ overflowX: 'auto', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 900 }}>
          <thead>
            <tr>
              <th className="m-stick0" style={{ ...TH, textAlign: 'left', position: 'sticky', left: 0, zIndex: 2 }}>ETF</th>
              <th style={{ ...TH, textAlign: 'left' }}>持股日</th>
              {data.sectors.map(s => (
                <th key={s.id} onClick={() => toggle(s.id)} title="點擊依此類別排序並展開個股"
                  style={{ ...TH, textAlign: 'right', cursor: 'pointer', ...(s.id === sec ? { background: RED } : {}) }}>
                  {s.zh}<br /><span style={{ fontWeight: 400, opacity: .7, fontSize: '.64rem' }}>{s.nStocks} 檔</span>
                </th>
              ))}
              <th style={{ ...TH, textAlign: 'right' }}>股票合計</th>
            </tr>
          </thead>
          <tbody>
            {fundRows.map(f => (
              <tr key={f.ticker} style={{ borderTop: `1px solid ${BORDER}` }}>
                <td className="m-stick0" style={{ padding: '7px 10px', whiteSpace: 'nowrap', position: 'sticky', left: 0, zIndex: 1, background: CARD }}>
                  <span style={{ fontFamily: MONO, fontWeight: 600 }}>{f.ticker}</span>
                  <span style={{ color: SUB, fontSize: '.74rem', marginLeft: 6 }}>{f.name}</span>
                </td>
                <td style={{ padding: '7px 10px', fontFamily: MONO, fontSize: '.72rem', color: SUB }}>{f.holdingDate ?? '—'}</td>
                {data.sectors.map(s => (
                  <td key={s.id} style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', ...heat(f.bySector[s.id] ?? 0) }}>
                    {(f.bySector[s.id] ?? 0) > 0 ? pct(f.bySector[s.id]) : '—'}
                  </td>
                ))}
                <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>{pct(f.total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: `2px solid ${BORDER}`, background: '#FAF7F4' }}>
              <td colSpan={2} style={{ padding: '7px 10px', fontSize: '.78rem', fontWeight: 600, position: 'sticky', left: 0, background: '#FAF7F4' }}>全市場等權平均</td>
              {data.sectors.map(s => (
                <td key={s.id} style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', fontWeight: 700, color: RED }}>{pct(s.equalAvg)}</td>
              ))}
              <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', fontWeight: 700, color: RED }}>{pct(data.totalEqualAvg)}</td>
            </tr>
            <tr style={{ background: '#FAF7F4' }}>
              <td colSpan={2} style={{ padding: '7px 10px', fontSize: '.78rem', fontWeight: 600, color: SUB, position: 'sticky', left: 0, background: '#FAF7F4' }}>持有檔數</td>
              {data.sectors.map(s => (
                <td key={s.id} style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.78rem', color: SUB }}>{s.heldBy} / {data.nFunds}</td>
              ))}
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      {current && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: '.9rem', fontWeight: 700 }}>{current.zh}</span>
            <span style={{ fontSize: '.74rem', color: SUB }}>{current.en}．{current.nStocks} 檔個股，依各檔佔比合計排序</span>
            <span onClick={() => onSec(null)} style={{ cursor: 'pointer', color: SUB, fontSize: '.78rem', marginLeft: 'auto' }}>收合 ×</span>
          </div>
          {current.stocks.length === 0 ? (
            <p style={{ color: SUB, fontSize: '.82rem' }}>目前 {data.nFunds} 檔海外主動式ETF 沒有持有這個類別的個股。</p>
          ) : (
            <div style={{ overflow: 'auto', maxHeight: 460, border: `1px solid ${BORDER}`, borderRadius: 8 }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 760 }}>
                <thead>
                  <tr>
                    <th style={{ ...TH, textAlign: 'left', left: 0, zIndex: 2 }}>個股</th>
                    <th style={{ ...TH, textAlign: 'right' }}>持有檔數</th>
                    {data.funds.map(f => (
                      <th key={f.ticker} style={{ ...TH, textAlign: 'right', fontFamily: MONO }}>{f.ticker}</th>
                    ))}
                    <th style={{ ...TH, textAlign: 'right', background: RED }}>合計</th>
                  </tr>
                </thead>
                <tbody>
                  {current.stocks.map(s => (
                    <tr key={s.stockid} style={{ borderTop: `1px solid ${BORDER}` }}>
                      <td className="m-stick0" style={{ padding: '6px 10px', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: CARD }}>
                        <span style={{ fontFamily: MONO, color: SUB, fontSize: '.74rem' }}>{s.stockid}</span>
                        <span style={{ marginLeft: 8, fontSize: '.8rem' }}>{s.stockname}</span>
                      </td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.76rem', color: SUB }}>{s.heldBy}</td>
                      {data.funds.map(f => (
                        <td key={f.ticker} style={{ padding: '6px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.78rem', ...heatStock(s.weights[f.ticker] ?? 0) }}>
                          {(s.weights[f.ticker] ?? 0) > 0 ? (s.weights[f.ticker]).toFixed(2) : '—'}
                        </td>
                      ))}
                      <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.78rem', fontWeight: 700, color: RED }}>{s.sumWeight.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <p style={{ fontSize: '.7rem', color: SUB, marginTop: 10, lineHeight: 1.7 }}>
        資料日 {data.asOf}。各檔 ETF 申報持股的日期不同，表中「持股日」為該檔自身最新申報日。<br />
        依 GICS（全球產業分類標準）11 大類別加總；權重為佔該基金淨值比例，「股票合計」不含現金與期貨部位。「等權平均」把每檔 ETF 等重看待，未持有記 0。<br />
        GICS 類別為人工對照（<span style={{ color: GOLD }}>lib/gicsOverseas.ts</span>），一檔股票只歸一個類別；
        {data.sectors.some(s => s.id === 'UNMAPPED') && '「未對應」是尚未歸類的新持股，'}
        ETF（如 GDX、COPX）依底層資產歸類。點欄標題可排序並展開個股明細。
      </p>
    </>
  );
}
