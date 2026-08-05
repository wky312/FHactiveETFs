'use client';
import { useState, useEffect, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { RebalancePrediction, RankedStock } from '@/lib/tw0050';

const RED    = '#C00000';
const GREEN  = '#1a7f37';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

function fmtCap(亿: number): string {
  if (亿 >= 10000) return `${(亿 / 10000).toFixed(1)} 兆`;
  return `${亿.toLocaleString()} 億`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
}

function StockTable({
  title, rows, alternates, accentColor, altLabel,
}: {
  title: string; rows: RankedStock[]; alternates: RankedStock[];
  accentColor: string; altLabel: string;
}) {
  const bgMain = accentColor === RED ? '#fff8f8' : '#f0fdf4';
  const bgAlt  = accentColor === RED ? '#fff5f5' : '#f7fef9';

  const ColHead: React.CSSProperties = {
    padding: '8px 10px', fontWeight: 600, fontSize: '.72rem', letterSpacing: '.3px',
    background: '#1C1C1E', color: '#fff', whiteSpace: 'nowrap', textAlign: 'right',
  };

  const renderRows = (list: RankedStock[], bg: string, dimmed: boolean) =>
    list.map(r => (
      <tr key={r.stockid} style={{ background: bg, borderBottom: `1px solid ${BORDER}` }}>
        <td style={{ padding: '7px 10px', textAlign: 'center', fontFamily: MONO, fontSize: '.78rem', color: dimmed ? SUB : accentColor, fontWeight: 700 }}>{r.rank}</td>
        <td style={{ padding: '7px 10px', textAlign: 'center', fontFamily: MONO, fontSize: '.8rem', color: TEXT }}>{r.stockid}</td>
        <td style={{ padding: '7px 10px', fontSize: '.82rem', color: dimmed ? SUB : TEXT, maxWidth: 140, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</td>
        <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.78rem', color: SUB }}>{fmtCap(r.marketCap)}</td>
        <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.78rem', color: SUB }}>{r.price !== null ? r.price.toFixed(2) : '—'}</td>
      </tr>
    ));

  return (
    <div style={{ flex: '1 1 300px', minWidth: 280 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ display: 'inline-block', width: 4, height: 18, background: accentColor, borderRadius: 2 }} />
        <span style={{ fontWeight: 700, fontSize: '.95rem', color: TEXT, fontFamily: SANS }}>{title}</span>
        <span style={{ marginLeft: 'auto', fontSize: '.72rem', color: accentColor, fontWeight: 600, background: accentColor === RED ? '#fee2e2' : '#dcfce7', padding: '2px 8px', borderRadius: 12 }}>
          {rows.length} 檔{alternates.length > 0 ? ` +${alternates.length} 備選` : ''}
        </span>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: '24px', textAlign: 'center', color: SUB, fontSize: '.85rem', border: `1px solid ${BORDER}`, borderRadius: 8, background: '#FAFAF9' }}>
          目前無預測{title.includes('納入') ? '納入' : '剔除'}個股
        </div>
      ) : (
        <div style={{ border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...ColHead, textAlign: 'center', width: 50 }}>排名</th>
                <th style={{ ...ColHead, textAlign: 'center', width: 60 }}>代碼</th>
                <th style={{ ...ColHead, textAlign: 'left' }}>名稱</th>
                <th style={{ ...ColHead }}>市值</th>
                <th style={{ ...ColHead }}>現價</th>
              </tr>
            </thead>
            <tbody>
              {renderRows(rows, bgMain, false)}
              {alternates.length > 0 && (
                <>
                  <tr>
                    <td colSpan={5} style={{ padding: '4px 10px', fontSize: '.7rem', color: SUB, background: '#F5F5F5', fontWeight: 600, letterSpacing: '.3px' }}>
                      {altLabel}
                    </td>
                  </tr>
                  {renderRows(alternates, bgAlt, true)}
                </>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FullTable({ rows }: { rows: RankedStock[] }) {
  const TH: React.CSSProperties = {
    padding: '8px 10px', fontWeight: 600, fontSize: '.72rem',
    background: '#1C1C1E', color: '#fff', whiteSpace: 'nowrap',
    position: 'sticky', top: 0, zIndex: 1,
  };

  return (
    <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '60vh', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 500 }}>
        <thead>
          <tr>
            <th style={{ ...TH, textAlign: 'center', width: 50, position: 'sticky', left: 0, zIndex: 2 }}>排名</th>
            <th style={{ ...TH, textAlign: 'center', width: 60, position: 'sticky', left: 50, zIndex: 2 }}>代碼</th>
            <th style={{ ...TH, textAlign: 'left', position: 'sticky', left: 110, zIndex: 2 }}>名稱</th>
            <th style={{ ...TH, textAlign: 'right' }}>市值</th>
            <th style={{ ...TH, textAlign: 'right' }}>現價</th>
            <th style={{ ...TH, textAlign: 'center' }}>成分股</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const rowBg = i % 2 === 0 ? '#fff' : '#FAFAF9';
            return (
            <tr key={r.stockid} style={{ background: rowBg, borderBottom: `1px solid ${BORDER}` }}>
              <td style={{ padding: '6px 10px', textAlign: 'center', fontFamily: MONO, fontSize: '.78rem', color: r.rank <= 50 ? TEXT : SUB, fontWeight: r.rank <= 50 ? 600 : 400, position: 'sticky', left: 0, zIndex: 1, background: rowBg }}>{r.rank}</td>
              <td style={{ padding: '6px 10px', textAlign: 'center', fontFamily: MONO, fontSize: '.8rem', color: TEXT, position: 'sticky', left: 50, zIndex: 1, background: rowBg }}>{r.stockid}</td>
              <td style={{ padding: '6px 10px', fontSize: '.82rem', color: TEXT, maxWidth: 160, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', position: 'sticky', left: 110, zIndex: 1, background: rowBg }}>{r.name}</td>
              <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.78rem', color: SUB }}>{fmtCap(r.marketCap)}</td>
              <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.78rem', color: SUB }}>{r.price !== null ? r.price.toFixed(2) : '—'}</td>
              <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                {r.inFund
                  ? <span style={{ fontSize: '.7rem', color: '#fff', background: '#1C1C1E', padding: '2px 6px', borderRadius: 4 }}>✓</span>
                  : <span style={{ fontSize: '.7rem', color: BORDER }}>—</span>}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function exportExcel(data: RebalancePrediction) {
  const stockCols = ['排名', '代碼', '名稱', '市值(億)', '現價'];
  const toRows = (rows: RankedStock[]) =>
    rows.map(r => [r.rank, r.stockid, r.name, parseFloat(r.marketCap.toFixed(1)), r.price ?? '']);
  const makeSheet = (rows: RankedStock[]) => {
    const ws = XLSX.utils.aoa_to_sheet([stockCols, ...toRows(rows)]);
    ws['!cols'] = [{ wch: 6 }, { wch: 8 }, { wch: 22 }, { wch: 12 }, { wch: 8 }];
    return ws;
  };

  const allHeaders = ['排名', '代碼', '名稱', '市值(億)', '現價', '是否成分股'];
  const allRows = data.rankedAll.map(r => [r.rank, r.stockid, r.name, parseFloat(r.marketCap.toFixed(1)), r.price ?? '', r.inFund ? '是' : '否']);
  const allWs = XLSX.utils.aoa_to_sheet([allHeaders, ...allRows]);
  allWs['!cols'] = [{ wch: 6 }, { wch: 8 }, { wch: 22 }, { wch: 12 }, { wch: 8 }, { wch: 10 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, makeSheet([...data.additions, ...data.addAlternates]), '預測納入');
  XLSX.utils.book_append_sheet(wb, makeSheet([...data.deletions, ...data.delAlternates]), '預測剔除');
  XLSX.utils.book_append_sheet(wb, allWs, '完整排行');
  XLSX.writeFile(wb, `0050季調預測_${new Date(data.fetchedAt).toISOString().slice(0, 10)}.xlsx`);
}

export default function Prediction0050Tab() {
  const [data, setData] = useState<RebalancePrediction | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/0050-rebalance');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <p style={{ margin: 0, fontSize: '.8rem', color: SUB }}>
          依上市市值排名推估下次季調可能納入或剔除的個股
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {data && (
            <span style={{ fontSize: '.75rem', color: SUB }}>
              資料時間：{fmtTime(data.fetchedAt)}
            </span>
          )}
          {data && (
            <button
              onClick={() => exportExcel(data)}
              style={{ padding: '6px 14px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, cursor: 'pointer', fontSize: '.78rem', color: SUB, fontFamily: SANS, fontWeight: 500 }}
            >
              ↓ 匯出 Excel
            </button>
          )}
          <button
            onClick={load}
            disabled={loading}
            style={{
              padding: '7px 18px', background: '#1C1C1E', color: '#fff',
              border: 'none', borderRadius: 7, cursor: loading ? 'default' : 'pointer',
              fontSize: '.82rem', fontFamily: SANS, fontWeight: 500,
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? '載入中…' : '重新載入'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: '14px 16px', background: '#fff0f0', border: '1px solid #fca5a5', borderRadius: 8, color: RED, fontSize: '.85rem', marginBottom: 16 }}>
          載入失敗：{error}
        </div>
      )}

      {loading && !data && (
        <div style={{ padding: '60px', textAlign: 'center', color: SUB, fontSize: '.9rem' }}>
          正在抓取市值資料，需要約 30 秒…
        </div>
      )}

      {data && (
        <>
          {/* Summary cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden', marginBottom: 20, background: '#FAFAF9' }}>
            {[
              { label: '成分股數',     value: `${data.memberCount} 檔`,        color: TEXT  },
              { label: '市值排名資料', value: `${data.rankedAll.length} 檔`,     color: TEXT  },
              { label: '預測納入',     value: `${data.additions.length} 檔`,    color: RED   },
              { label: '預測剔除',     value: `${data.deletions.length} 檔`,    color: GREEN },
            ].map((c, i, arr) => (
              <div key={c.label} style={{ padding: '14px 16px', borderRight: i < arr.length - 1 ? `1px solid ${BORDER}` : 'none' }}>
                <div style={{ fontSize: '.72rem', color: SUB, fontWeight: 500, marginBottom: 4 }}>{c.label}</div>
                <div style={{ fontSize: '1.45rem', fontWeight: 700, color: c.color, fontFamily: MONO, lineHeight: 1.1 }}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* Two-column predictions */}
          <div style={{ display: 'flex', gap: 20, marginBottom: 24, flexWrap: 'wrap' }}>
            <StockTable title="預測納入" rows={data.additions} alternates={data.addAlternates} accentColor={RED}   altLabel="備選（前50名非成分股優先，不足再取51–60名）" />
            <StockTable title="預測剔除" rows={data.deletions} alternates={data.delAlternates} accentColor={GREEN} altLabel="邊緣成分股（目前排名 48–50）" />
          </div>

          {/* Full universe toggle */}
          <div>
            <button
              onClick={() => setShowAll(v => !v)}
              style={{ padding: '7px 16px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 7, cursor: 'pointer', fontSize: '.8rem', color: SUB, fontFamily: SANS, fontWeight: 500, marginBottom: 10 }}
            >
              {showAll ? '▲ 收合' : '▼ 顯示完整市值排行'}（{data.rankedAll.length} 檔）
            </button>
            {showAll && <FullTable rows={data.rankedAll} />}
          </div>

          {/* Methodology + Disclaimer */}
          <div style={{ marginTop: 24, padding: '14px 16px', background: '#F7F6F3', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: '.72rem', color: SUB, lineHeight: 1.8 }}>
            <div style={{ fontWeight: 700, color: TEXT, marginBottom: 6, fontSize: '.75rem' }}>計算方式說明</div>
            <div><b>市值</b>＝ 收盤價 × 已發行普通股數 ÷ 1億　（單位：億台幣）</div>
            <div style={{ marginTop: 4 }}><b>收盤價來源：</b>證交所 STOCK_DAY_ALL（最近一個交易日收盤價，非即時）</div>
            <div><b>股數來源：</b>證交所上市公司基本資料（t187ap03_L 已發行普通股數）</div>
            <div><b>0050 現有成分股：</b>元大投信 ETF API（即時），無法取得時改用 2026-Q1 硬編碼清單</div>
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${BORDER}` }}>
              ※ 市值排名每日隨收盤價更動，與 CMoney 等平台可能有 1–2 名差距（因各平台更新時間與股數版本略異）。
              0050 成分股由元大投信依市值排名每季調整，實際結果以公告為準。本頁僅供參考，不構成投資建議。
            </div>
          </div>
        </>
      )}
    </div>
  );
}
