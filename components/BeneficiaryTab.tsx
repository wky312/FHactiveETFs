'use client';
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import PlotlyWrapper from './PlotlyWrapper';
import {
  BENEFICIARY_TICKERS, LEVEL_GROUPS, Week, avgUnitsOf, commonWeeks, diffLevels,
  fundStats, groupShares, trendPoints,
} from '@/lib/beneficiary';

const RED    = '#C00000';
const GREEN  = '#16a34a';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

const CHART_ID = 'beneficiary-chart';

const int = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 0 });
const signed = (v: number | null, digits = 0) =>
  v === null ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
/* 紅增綠減——與站上其他分頁同一套台股慣例。 */
const deltaColor = (v: number | null) => (v === null || v === 0 ? SUB : v > 0 ? RED : GREEN);

const TH: React.CSSProperties = {
  padding: '8px 12px', fontWeight: 600, fontSize: '.75rem',
  background: TEXT, color: '#fff', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1,
};
const SUBTH: React.CSSProperties = {
  fontWeight: 500, fontSize: '.7rem', textAlign: 'right', background: '#3A3A3C',
};
const TD: React.CSSProperties = {
  padding: '7px 12px', fontSize: '.8rem', fontFamily: MONO,
  borderBottom: `1px solid ${BORDER}`, textAlign: 'right', whiteSpace: 'nowrap',
};

type Mode = 'trend' | 'structure' | 'compare';

interface ApiResult { ticker: string; name: string; weeks: Week[] }

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ padding: '12px 16px', borderRight: `1px solid ${BORDER}` }}>
      <div style={{ fontSize: '.72rem', color: SUB, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: '1.05rem', fontWeight: 700, fontFamily: MONO, color: color ?? TEXT }}>{value}</div>
      {sub && <div style={{ fontSize: '.7rem', color: SUB, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export default function BeneficiaryTab() {
  const [ticker,  setTicker]  = useState('00991A');
  const [mode,    setMode]    = useState<Mode>('trend');
  const [data,    setData]    = useState<ApiResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [curDate,  setCurDate]  = useState('');
  const [baseDate, setBaseDate] = useState('');
  /* 對照檢視：第二檔基金獨立抓取、獨立的週次選擇（只能選兩檔都有的週）。 */
  const [tickerB,  setTickerB]  = useState('00981A');
  const [dataB,    setDataB]    = useState<ApiResult | null>(null);
  const [loadingB, setLoadingB] = useState(false);
  const [errorB,   setErrorB]   = useState('');
  const [cmpCur,   setCmpCur]   = useState('');
  const [cmpBase,  setCmpBase]  = useState('');

  const load = useCallback(async (t: string) => {
    setLoading(true); setError(''); setData(null);
    try {
      const res  = await fetch(`/api/beneficiary?ticker=${encodeURIComponent(t)}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const result = json as ApiResult;
      setData(result);
      // 預設比較「最新一週 vs 前一週」。
      const ws = result.weeks;
      setCurDate(ws.length ? ws[ws.length - 1].date : '');
      setBaseDate(ws.length > 1 ? ws[ws.length - 2].date : '');
    } catch (e) {
      setError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadB = useCallback(async (t: string) => {
    setLoadingB(true); setErrorB(''); setDataB(null);
    try {
      const res  = await fetch(`/api/beneficiary?ticker=${encodeURIComponent(t)}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setDataB(json as ApiResult);
    } catch (e) {
      setErrorB(e instanceof Error ? e.message : '載入失敗');
    } finally {
      setLoadingB(false);
    }
  }, []);

  const enterCompare = useCallback(() => {
    setMode('compare');
    if (!dataB && !loadingB) loadB(tickerB);
  }, [dataB, loadingB, loadB, tickerB]);

  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    load(ticker);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const weeks = useMemo(() => data?.weeks ?? [], [data]);
  const points = useMemo(() => trendPoints(weeks), [weeks]);
  const latest = points.length ? points[points.length - 1] : null;

  const current = weeks.find(w => w.date === curDate) ?? null;
  const base    = weeks.find(w => w.date === baseDate) ?? null;
  const levelRows = useMemo(() => (current ? diffLevels(current, base) : []), [current, base]);
  const totalAvg     = current ? avgUnitsOf(current.units, current.people) : 0;
  const baseTotalAvg = base ? avgUnitsOf(base.units, base.people) : null;

  /* ── 趨勢圖：上半人數＋單位數（雙軸），下半平均持有張數，共用 X 軸 ── */
  const axisFont  = { family: SANS, size: 11, color: SUB };
  const titleFont = { family: SANS, size: 12, color: SUB };

  const trendTraces = useMemo(() => {
    const x = points.map(p => p.date);
    return [
      {
        x, y: points.map(p => p.people), name: '受益人數', type: 'scatter', mode: 'lines+markers',
        line: { color: RED, width: 2 }, marker: { size: 4 }, yaxis: 'y',
        hovertemplate: '受益人數 %{y:,.0f} 人<extra></extra>',
      },
      {
        x, y: points.map(p => p.units / 1e8), name: '受益權單位數（億單位）', type: 'scatter', mode: 'lines',
        line: { color: '#8B6F47', width: 2, dash: 'dot' }, yaxis: 'y2',
        hovertemplate: '單位數 %{y:,.2f} 億<extra></extra>',
      },
      {
        x, y: points.map(p => p.avgLots), name: '平均每人持有張數', type: 'scatter', mode: 'lines',
        line: { color: '#2E5E8A', width: 2 }, yaxis: 'y3', fill: 'tozeroy',
        fillcolor: 'rgba(46,94,138,.08)',
        hovertemplate: '平均 %{y:,.2f} 張/人<extra></extra>',
      },
    ];
  }, [points]);

  const trendLayout = useMemo(() => ({
    paper_bgcolor: '#fff', plot_bgcolor: '#fff',
    margin: { l: 70, r: 70, t: 10, b: 80 }, height: 540,
    hovermode: 'x unified',
    legend: { orientation: 'h', x: 0, y: -0.16, font: { family: SANS, size: 11 } },
    xaxis: {
      type: 'category', tickangle: -45, tickfont: axisFont, gridcolor: BORDER,
      automargin: true, nticks: 14, anchor: 'y3',
      showspikes: true, spikemode: 'across', spikethickness: 1,
      spikecolor: '#999', spikedash: 'dot', spikesnap: 'cursor',
    },
    yaxis:  { domain: [0.56, 1.0], title: { text: '受益人數 (人)', font: titleFont }, tickfont: axisFont, gridcolor: BORDER, rangemode: 'tozero' },
    yaxis2: { title: { text: '單位數 (億)', font: titleFont }, tickfont: axisFont, overlaying: 'y', side: 'right', showgrid: false, rangemode: 'tozero' },
    yaxis3: { domain: [0, 0.44], anchor: 'x', title: { text: '平均張數/人', font: titleFont }, tickfont: axisFont, gridcolor: BORDER, rangemode: 'tozero' },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [points]);

  /* ── 結構圖：五組單位數佔比隨週變化（100% 堆疊） ── */
  const structureTraces = useMemo(() => {
    const x = weeks.map(w => w.date);
    const shares = weeks.map(w => groupShares(w));
    return LEVEL_GROUPS.map((g, gi) => ({
      x,
      y: shares.map(s => s[gi].units),
      name: `${g.label}（${g.note}）`,
      type: 'scatter', mode: 'lines', stackgroup: 'one', groupnorm: 'percent',
      line: { width: 0.5, color: g.color }, fillcolor: g.color,
      hovertemplate: `${g.label} %{y:.2f}%<extra></extra>`,
    }));
  }, [weeks]);

  const structureLayout = useMemo(() => ({
    paper_bgcolor: '#fff', plot_bgcolor: '#fff',
    margin: { l: 60, r: 30, t: 10, b: 80 }, height: 380,
    hovermode: 'x unified',
    legend: { orientation: 'h', x: 0, y: -0.22, font: { family: SANS, size: 11 } },
    xaxis: { type: 'category', tickangle: -45, tickfont: axisFont, gridcolor: BORDER, automargin: true, nticks: 14 },
    yaxis: { title: { text: '受益權單位數佔比 (%)', font: titleFont }, tickfont: axisFont, gridcolor: BORDER, range: [0, 100] },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [weeks]);

  /* 兩檔共同有資料的週次；各檔掛牌時間不同，交集才畫得出對照。
     選擇值不在交集內（換檔後）就退回預設，不用 effect 改 state。 */
  const weeksB   = useMemo(() => dataB?.weeks ?? [], [dataB]);
  const common   = useMemo(() => commonWeeks(weeks, weeksB), [weeks, weeksB]);
  /* 預設比「最新 vs 4 週前」——結構變化用週對週太小，看不出形狀差異。 */
  const cmpCurEff  = cmpCur  && common.includes(cmpCur)  ? cmpCur  : (common[0] ?? '');
  const cmpBaseEff = cmpBase && common.includes(cmpBase) ? cmpBase : (common[4] ?? common[common.length - 1] ?? '');

  const statsA = useMemo(() => {
    const c = weeks.find(w => w.date === cmpCurEff), b = weeks.find(w => w.date === cmpBaseEff);
    return data && c && b ? fundStats(data.ticker, data.name, c, b) : null;
  }, [weeks, data, cmpCurEff, cmpBaseEff]);
  const statsB = useMemo(() => {
    const c = weeksB.find(w => w.date === cmpCurEff), b = weeksB.find(w => w.date === cmpBaseEff);
    return dataB && c && b ? fundStats(dataB.ticker, dataB.name, c, b) : null;
  }, [weeksB, dataB, cmpCurEff, cmpBaseEff]);

  const compareTraces = useMemo(() => {
    if (!statsA || !statsB) return [];
    return [statsA, statsB].map((st, i) => ({
      y: st.levels.map(l => l.label),
      x: st.levels.map(l => l.peoplePctChange),
      name: `${st.ticker}`,
      type: 'bar', orientation: 'h',
      marker: { color: i === 0 ? RED : '#2E5E8A' },
      hovertemplate: `${st.ticker} %{y}：%{x:+.2f}%<extra></extra>`,
    }));
  }, [statsA, statsB]);

  const compareLayout = useMemo(() => ({
    paper_bgcolor: '#fff', plot_bgcolor: '#fff',
    margin: { l: 130, r: 30, t: 10, b: 50 }, height: 560,
    barmode: 'group', bargap: 0.25,
    legend: { orientation: 'h', x: 0, y: -0.08, font: { family: SANS, size: 11 } },
    xaxis: { title: { text: '受益人數變動率 (%)', font: titleFont }, tickfont: axisFont,
             gridcolor: BORDER, zeroline: true, zerolinecolor: '#999', zerolinewidth: 1 },
    yaxis: { autorange: 'reversed', tickfont: { ...axisFont, size: 10 }, automargin: true },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [statsA, statsB]);

  const exportExcel = useCallback(() => {
    if (!current) return;
    const b = baseDate || '對照';
    const headers = [
      '持股/單位數分級',
      `人數 ${curDate}`, `人數 ${b}`, '人數增減',
      `每人平均持有 ${curDate}`, `每人平均持有 ${b}`, '平均持有增減',
      `受益權單位數 ${curDate}`, '單位數增減', '佔比(%)', '佔比增減',
    ];
    const r0 = (v: number | null) => (v === null ? '' : Math.round(v));
    const body: (string | number)[][] = levelRows.map(r => [
      r.label,
      r.people, r.basePeople ?? '', r.peopleDelta ?? '',
      Math.round(r.avgUnits), r0(r.baseAvgUnits), r0(r.avgUnitsDelta),
      r.units, r.unitsDelta ?? '',
      r.pct, r.pctDelta === null ? '' : Number(r.pctDelta.toFixed(2)),
    ]);
    body.push([
      '合計',
      current.people, base ? base.people : '', base ? current.people - base.people : '',
      Math.round(totalAvg), r0(baseTotalAvg), baseTotalAvg === null ? '' : Math.round(totalAvg - baseTotalAvg),
      current.units, base ? current.units - base.units : '',
      100, '',
    ]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...body]);
    ws['!cols'] = [{ wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 12 },
                   { wch: 20 }, { wch: 20 }, { wch: 14 },
                   { wch: 20 }, { wch: 16 }, { wch: 10 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '受益人數分級');
    XLSX.writeFile(wb, `${ticker}_受益人數_${curDate}${base ? `_vs_${baseDate}` : ''}.xlsx`);
  }, [current, base, levelRows, ticker, curDate, baseDate, totalAvg, baseTotalAvg]);

  const pill = (active: boolean): React.CSSProperties => ({
    padding: '6px 16px', borderRadius: 20, cursor: 'pointer', fontSize: '.82rem',
    fontFamily: SANS, border: `1px solid ${active ? RED : BORDER}`,
    background: active ? RED : '#fff', color: active ? '#fff' : SUB,
  });

  const selectStyle: React.CSSProperties = {
    padding: '6px 10px', border: `1px solid ${BORDER}`, borderRadius: 6,
    fontSize: '.85rem', fontFamily: SANS, color: TEXT, background: '#fff',
  };

  return (
    <div>
      {/* 控制列 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 16 }}>
        <select value={ticker} style={{ ...selectStyle, minWidth: 230 }}
                onChange={e => { setTicker(e.target.value); load(e.target.value); }}>
          <optgroup label="台股主動式 ETF">
            {BENEFICIARY_TICKERS.filter(t => t.group === 'tw').map(t => (
              <option key={t.ticker} value={t.ticker}>{t.ticker}　{t.name}</option>
            ))}
          </optgroup>
          <optgroup label="海外主動式 ETF">
            {BENEFICIARY_TICKERS.filter(t => t.group === 'overseas').map(t => (
              <option key={t.ticker} value={t.ticker}>{t.ticker}　{t.name}</option>
            ))}
          </optgroup>
        </select>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={pill(mode === 'trend')}     onClick={() => setMode('trend')}>人數趨勢</button>
          <button style={pill(mode === 'structure')} onClick={() => setMode('structure')}>級距結構</button>
          <button style={pill(mode === 'compare')}   onClick={enterCompare}>兩檔對照</button>
        </div>
      </div>

      {loading && <p style={{ color: SUB, textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>載入中…</p>}
      {error && (
        <div style={{ background: '#FFF5F5', border: '1px solid #FFCDD2', borderRadius: 6, padding: '10px 14px', color: RED, fontSize: '.88rem' }}>
          ⚠ {error}
        </div>
      )}
      {!loading && !error && weeks.length === 0 && (
        <p style={{ color: '#AAA', textAlign: 'center', padding: '40px 0', fontSize: '.9rem' }}>
          {ticker} 尚無受益人數資料（集保每週五結算；新掛牌的檔要等第一次結算後才有）
        </p>
      )}

      {!loading && !error && weeks.length > 0 && (
        <>
          {/* 摘要卡 */}
          {mode !== 'compare' && latest && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden', marginBottom: 18, background: '#FAFAF9' }}>
              <Stat label="最新受益人數" value={`${int(latest.people)} 人`} sub={latest.date} />
              <Stat label="較上週" value={`${signed(latest.peopleChange)} 人`} color={deltaColor(latest.peopleChange)}
                    sub={latest.peopleChange !== null && points.length > 1
                      ? `${((latest.peopleChange / (points[points.length - 2].people || 1)) * 100).toFixed(2)}%` : undefined} />
              <Stat label="受益權單位數" value={`${(latest.units / 1e8).toFixed(2)} 億`} sub={`${int(latest.units / 1000)} 張`} />
              <Stat label="平均每人持有" value={`${latest.avgLots.toFixed(1)} 張`} />
              <Stat label="已累積週數" value={`${weeks.length} 週`} sub={`${weeks[0].date} 起`} />
            </div>
          )}

          {mode === 'trend' && (
            <>
              <PlotlyWrapper traces={trendTraces} layout={trendLayout} hoverSync={['xy', 'xy2', 'xy3']}
                             id={CHART_ID} style={{ marginBottom: 20 }} />
              <div style={{ maxHeight: 420, overflow: 'auto', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ ...TH, textAlign: 'left' }}>資料日期</th>
                      <th style={{ ...TH, textAlign: 'right' }}>受益人數</th>
                      <th style={{ ...TH, textAlign: 'right' }}>週變化</th>
                      <th style={{ ...TH, textAlign: 'right' }}>受益權單位數</th>
                      <th style={{ ...TH, textAlign: 'right' }}>平均張數/人</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...points].reverse().map(p => (
                      <tr key={p.date}>
                        <td style={{ ...TD, textAlign: 'left' }}>{p.date}</td>
                        <td style={TD}>{int(p.people)}</td>
                        <td style={{ ...TD, color: deltaColor(p.peopleChange) }}>{signed(p.peopleChange)}</td>
                        <td style={TD}>{int(p.units)}</td>
                        <td style={TD}>{p.avgLots.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {mode === 'structure' && (
            <>
              <PlotlyWrapper traces={structureTraces} layout={structureLayout} style={{ marginBottom: 20 }} />

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontSize: '.82rem', color: SUB }}>本期</span>
                <select value={curDate} style={selectStyle} onChange={e => setCurDate(e.target.value)}>
                  {[...weeks].reverse().map(w => <option key={w.date} value={w.date}>{w.date}</option>)}
                </select>
                <span style={{ fontSize: '.82rem', color: SUB }}>對照</span>
                <select value={baseDate} style={selectStyle} onChange={e => setBaseDate(e.target.value)}>
                  <option value="">（不比較）</option>
                  {[...weeks].reverse().map(w => <option key={w.date} value={w.date}>{w.date}</option>)}
                </select>
                <button onClick={exportExcel} style={{
                  padding: '5px 14px', background: '#fff', color: SUB, border: `1px solid ${BORDER}`,
                  borderRadius: 6, cursor: 'pointer', fontSize: '.78rem', fontFamily: SANS,
                }}>儲存 Excel</button>
              </div>

              <div style={{ overflow: 'auto', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th rowSpan={2} style={{ ...TH, textAlign: 'left' }}>持股/單位數分級</th>
                      <th colSpan={3} style={{ ...TH, textAlign: 'center', borderLeft: '1px solid #555' }}>受益人數（人）</th>
                      <th colSpan={3} style={{ ...TH, textAlign: 'center', borderLeft: '1px solid #555' }}>每人平均持有（單位）</th>
                      <th colSpan={2} style={{ ...TH, textAlign: 'center', borderLeft: '1px solid #555' }}>受益權單位數</th>
                      <th colSpan={2} style={{ ...TH, textAlign: 'center', borderLeft: '1px solid #555' }}>佔比 (%)</th>
                    </tr>
                    <tr>
                      <th style={{ ...TH, ...SUBTH, borderLeft: '1px solid #555' }}>{curDate}</th>
                      <th style={{ ...TH, ...SUBTH }}>{baseDate || '對照'}</th>
                      <th style={{ ...TH, ...SUBTH }}>增減</th>
                      <th style={{ ...TH, ...SUBTH, borderLeft: '1px solid #555' }}>{curDate}</th>
                      <th style={{ ...TH, ...SUBTH }}>{baseDate || '對照'}</th>
                      <th style={{ ...TH, ...SUBTH }}>增減</th>
                      <th style={{ ...TH, ...SUBTH, borderLeft: '1px solid #555' }}>{curDate}</th>
                      <th style={{ ...TH, ...SUBTH }}>增減</th>
                      <th style={{ ...TH, ...SUBTH, borderLeft: '1px solid #555' }}>{curDate}</th>
                      <th style={{ ...TH, ...SUBTH }}>增減</th>
                    </tr>
                  </thead>
                  <tbody>
                    {levelRows.map(r => (
                      <tr key={r.level}>
                        <td style={{ ...TD, textAlign: 'left', fontFamily: SANS }}>{r.label}</td>
                        <td style={{ ...TD, borderLeft: `1px solid ${BORDER}` }}>{int(r.people)}</td>
                        <td style={{ ...TD, color: SUB }}>{r.basePeople === null ? '—' : int(r.basePeople)}</td>
                        <td style={{ ...TD, color: deltaColor(r.peopleDelta) }}>{signed(r.peopleDelta)}</td>
                        <td style={{ ...TD, borderLeft: `1px solid ${BORDER}` }}>{int(r.avgUnits)}</td>
                        <td style={{ ...TD, color: SUB }}>{r.baseAvgUnits === null ? '—' : int(r.baseAvgUnits)}</td>
                        <td style={{ ...TD, color: deltaColor(r.avgUnitsDelta), fontWeight: 600 }}>{signed(r.avgUnitsDelta)}</td>
                        <td style={{ ...TD, borderLeft: `1px solid ${BORDER}` }}>{int(r.units)}</td>
                        <td style={{ ...TD, color: deltaColor(r.unitsDelta) }}>{signed(r.unitsDelta)}</td>
                        <td style={{ ...TD, borderLeft: `1px solid ${BORDER}` }}>{r.pct.toFixed(2)}</td>
                        <td style={{ ...TD, color: deltaColor(r.pctDelta) }}>{signed(r.pctDelta, 2)}</td>
                      </tr>
                    ))}
                    {current && (
                      <tr style={{ background: '#FAFAF9', fontWeight: 700 }}>
                        <td style={{ ...TD, textAlign: 'left', fontFamily: SANS }}>合計</td>
                        <td style={{ ...TD, borderLeft: `1px solid ${BORDER}` }}>{int(current.people)}</td>
                        <td style={{ ...TD, color: SUB }}>{base ? int(base.people) : '—'}</td>
                        <td style={{ ...TD, color: deltaColor(base ? current.people - base.people : null) }}>
                          {signed(base ? current.people - base.people : null)}
                        </td>
                        <td style={{ ...TD, borderLeft: `1px solid ${BORDER}` }}>{int(totalAvg)}</td>
                        <td style={{ ...TD, color: SUB }}>{baseTotalAvg === null ? '—' : int(baseTotalAvg)}</td>
                        <td style={{ ...TD, color: deltaColor(baseTotalAvg === null ? null : totalAvg - baseTotalAvg), fontWeight: 700 }}>
                          {signed(baseTotalAvg === null ? null : totalAvg - baseTotalAvg)}
                        </td>
                        <td style={{ ...TD, borderLeft: `1px solid ${BORDER}` }}>{int(current.units)}</td>
                        <td style={{ ...TD, color: deltaColor(base ? current.units - base.units : null) }}>
                          {signed(base ? current.units - base.units : null)}
                        </td>
                        <td style={{ ...TD, borderLeft: `1px solid ${BORDER}` }}>100.00</td>
                        <td style={TD}>—</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* 五組聚合速覽 */}
              {current && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 0,
                  border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden', marginTop: 16, background: '#FAFAF9' }}>
                  {groupShares(current).map((g, i) => {
                    const b = base ? groupShares(base)[i] : null;
                    const d = b ? g.unitShare - b.unitShare : null;
                    return (
                      <Stat key={g.key} label={`${g.label}（${LEVEL_GROUPS[i].note}）`}
                            value={`${(g.unitShare * 100).toFixed(2)}%`}
                            sub={`${int(g.people)} 人 · 佔比${d === null ? '' : ` ${signed(d * 100, 2)}pp`}`}
                            color={d === null ? undefined : deltaColor(d)} />
                    );
                  })}
                </div>
              )}
            </>
          )}

          {mode === 'compare' && (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 14 }}>
                <span style={{ fontSize: '.82rem', color: SUB }}>對照基金</span>
                <select value={tickerB} style={{ ...selectStyle, minWidth: 230 }}
                        onChange={e => { setTickerB(e.target.value); loadB(e.target.value); }}>
                  {BENEFICIARY_TICKERS.filter(t => t.ticker !== ticker).map(t => (
                    <option key={t.ticker} value={t.ticker}>{t.ticker}　{t.name}</option>
                  ))}
                </select>
                <span style={{ fontSize: '.82rem', color: SUB }}>本期</span>
                <select value={cmpCurEff} style={selectStyle} onChange={e => setCmpCur(e.target.value)}>
                  {common.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
                <span style={{ fontSize: '.82rem', color: SUB }}>對照</span>
                <select value={cmpBaseEff} style={selectStyle} onChange={e => setCmpBase(e.target.value)}>
                  {common.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>

              {loadingB && <p style={{ color: SUB, textAlign: 'center', padding: '30px 0', fontSize: '.9rem' }}>載入對照基金…</p>}
              {errorB && (
                <div style={{ background: '#FFF5F5', border: '1px solid #FFCDD2', borderRadius: 6, padding: '10px 14px', color: RED, fontSize: '.88rem' }}>
                  ⚠ {errorB}
                </div>
              )}
              {!loadingB && !errorB && common.length === 0 && dataB && (
                <p style={{ color: '#AAA', textAlign: 'center', padding: '30px 0', fontSize: '.9rem' }}>
                  兩檔沒有共同的資料週次（掛牌時間不重疊）
                </p>
              )}

              {statsA && statsB && (
                <>
                  {/* 總體對照 */}
                  <div style={{ overflow: 'auto', border: `1px solid ${BORDER}`, borderRadius: 8, marginBottom: 18 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={{ ...TH, textAlign: 'left' }}>指標（{cmpBaseEff} → {cmpCurEff}）</th>
                          <th style={{ ...TH, textAlign: 'right', borderLeft: '1px solid #555' }}>{statsA.ticker} {statsA.name}</th>
                          <th style={{ ...TH, textAlign: 'right', borderLeft: '1px solid #555' }}>{statsB.ticker} {statsB.name}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {([
                          ['受益人數', (st: typeof statsA) => `${int(st.basePeople)} → ${int(st.people)}`,
                            (st: typeof statsA) => st.peopleDelta],
                          ['受益權單位數（億）', (st: typeof statsA) => `${(st.baseUnits / 1e8).toFixed(2)} → ${(st.units / 1e8).toFixed(2)}`,
                            (st: typeof statsA) => st.unitsDelta],
                          ['每人平均持有（單位）', (st: typeof statsA) => `${int(st.baseAvgUnits)} → ${int(st.avgUnits)}`,
                            (st: typeof statsA) => st.avgUnitsDelta],
                        ] as const).map(([label, fmt, delta]) => (
                          <tr key={label}>
                            <td style={{ ...TD, textAlign: 'left', fontFamily: SANS }}>{label}</td>
                            {[statsA, statsB].map(st => (
                              <td key={st.ticker} style={{ ...TD, borderLeft: `1px solid ${BORDER}` }}>
                                {fmt(st)}　<span style={{ color: deltaColor(delta(st)) }}>({signed(delta(st))})</span>
                              </td>
                            ))}
                          </tr>
                        ))}
                        <tr>
                          <td style={{ ...TD, textAlign: 'left', fontFamily: SANS }}>人數變動率</td>
                          {[statsA, statsB].map(st => (
                            <td key={st.ticker} style={{ ...TD, borderLeft: `1px solid ${BORDER}`, color: deltaColor(st.peopleDelta), fontWeight: 700 }}>
                              {signed(st.peoplePctChange, 2)}%
                            </td>
                          ))}
                        </tr>
                        <tr>
                          <td style={{ ...TD, textAlign: 'left', fontFamily: SANS }}>散戶（5 張以下）佔人數比</td>
                          {[statsA, statsB].map(st => (
                            <td key={st.ticker} style={{ ...TD, borderLeft: `1px solid ${BORDER}` }}>
                              {(st.retailPeopleShare * 100).toFixed(1)}%
                            </td>
                          ))}
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  {/* 五組聚合對照 */}
                  <div style={{ overflow: 'auto', border: `1px solid ${BORDER}`, borderRadius: 8, marginBottom: 18 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th rowSpan={2} style={{ ...TH, textAlign: 'left' }}>組別</th>
                          <th colSpan={3} style={{ ...TH, textAlign: 'center', borderLeft: '1px solid #555' }}>{statsA.ticker}</th>
                          <th colSpan={3} style={{ ...TH, textAlign: 'center', borderLeft: '1px solid #555' }}>{statsB.ticker}</th>
                        </tr>
                        <tr>
                          <th style={{ ...TH, ...SUBTH, borderLeft: '1px solid #555' }}>人數增減</th>
                          <th style={{ ...TH, ...SUBTH }}>變動率</th>
                          <th style={{ ...TH, ...SUBTH }}>單位增減(億)</th>
                          <th style={{ ...TH, ...SUBTH, borderLeft: '1px solid #555' }}>人數增減</th>
                          <th style={{ ...TH, ...SUBTH }}>變動率</th>
                          <th style={{ ...TH, ...SUBTH }}>單位增減(億)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {LEVEL_GROUPS.map((g, gi) => {
                          const a = statsA.groups[gi], b = statsB.groups[gi];
                          return (
                            <tr key={g.key}>
                              <td style={{ ...TD, textAlign: 'left', fontFamily: SANS }}>
                                {g.label}<span style={{ color: SUB, fontSize: '.72rem' }}>　{g.note}</span>
                              </td>
                              {[a, b].map((st, si) => (
                                <React.Fragment key={si}>
                                  <td style={{ ...TD, borderLeft: `1px solid ${BORDER}`, color: deltaColor(st.peopleDelta) }}>{signed(st.peopleDelta)}</td>
                                  <td style={{ ...TD, color: deltaColor(st.peopleDelta) }}>{signed(st.peoplePctChange, 2)}%</td>
                                  <td style={{ ...TD, color: deltaColor(st.unitsDelta) }}>{signed(st.unitsDelta / 1e8, 2)}</td>
                                </React.Fragment>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* 15 級距人數變動率並排 */}
                  <p style={{ fontSize: '.82rem', color: TEXT, margin: '0 0 6px' }}>各級距受益人數變動率</p>
                  <p style={{ fontSize: '.75rem', color: SUB, margin: '0 0 8px' }}>
                    看「形狀」最快：長條全落在左側＝該檔全面流失；兩端翹右、中間偏左＝啞鈴化（小額與超大戶進場、中實戶撤退）。
                  </p>
                  <PlotlyWrapper traces={compareTraces} layout={compareLayout} style={{ marginBottom: 18 }} />

                  {/* 超大戶對照 */}
                  <div style={{ overflow: 'auto', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={{ ...TH, textAlign: 'left' }}>超大戶（1000 張以上）</th>
                          <th style={{ ...TH, textAlign: 'right', borderLeft: '1px solid #555' }}>{statsA.ticker}</th>
                          <th style={{ ...TH, textAlign: 'right', borderLeft: '1px solid #555' }}>{statsB.ticker}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {([
                          ['人數', (st: typeof statsA) => {
                            const w = st.groups[4];
                            return `${int(w.basePeople)} → ${int(w.people)}　(${signed(w.peopleDelta)})`;
                          }],
                          ['持有單位（億）', (st: typeof statsA) => {
                            const w = st.groups[4];
                            return `${(w.baseUnits / 1e8).toFixed(2)} → ${(w.units / 1e8).toFixed(2)}　(${signed(w.unitsDelta / 1e8, 2)})`;
                          }],
                          ['每人平均（萬單位）', (st: typeof statsA) => {
                            const w = st.groups[4];
                            const a0 = avgUnitsOf(w.baseUnits, w.basePeople) / 1e4;
                            const a1 = avgUnitsOf(w.units, w.people) / 1e4;
                            return `${a0.toFixed(0)} → ${a1.toFixed(0)}　(${signed(a1 - a0)})`;
                          }],
                          ['佔全基金單位比', (st: typeof statsA) => {
                            const l = st.levels[14];
                            return `${l.basePct.toFixed(2)}% → ${l.pct.toFixed(2)}%　(${signed(l.pctDelta, 2)}pp)`;
                          }],
                          ['佔全基金單位變動', (st: typeof statsA) => {
                            const w = st.groups[4];
                            return st.unitsDelta === 0 ? '—' : `${(w.unitsDelta / st.unitsDelta * 100).toFixed(0)}%`;
                          }],
                        ] as const).map(([label, fmt]) => (
                          <tr key={label}>
                            <td style={{ ...TD, textAlign: 'left', fontFamily: SANS }}>{label}</td>
                            {[statsA, statsB].map(st => (
                              <td key={st.ticker} style={{ ...TD, borderLeft: `1px solid ${BORDER}` }}>{fmt(st)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p style={{ color: SUB, fontSize: '.75rem', marginTop: 8, lineHeight: 1.6 }}>
                    「佔全基金單位變動」＝超大戶的單位增減 ÷ 全基金的單位增減。超過 100%（或為負）代表這一檔的規模變動
                    幾乎由超大戶單獨決定，其餘級距是反方向的。
                  </p>
                </>
              )}
            </>
          )}

          <p style={{ color: SUB, fontSize: '.78rem', marginTop: 16, lineHeight: 1.7 }}>
            資料源：集保結算所（TDCC）股權分散表，<strong style={{ color: TEXT }}>每週最後一個營業日</strong>結算、隔日更新。
            「受益人數」＝集保戶 ID 歸戶後的人數；單位為受益權單位，1 張 = 1,000 單位。
            集保只保存最近一年，<strong style={{ color: TEXT }}>再往前沒有任何來源</strong>，故本站每週自動存檔累積。
            <br />
            <strong style={{ color: RED }}>⚠ 要跟申購買回對照時，請把資料日往前推 2 個交易日</strong>——
            集保庫存是 T+2 交割後才入帳，實測 TDCC 資料日 T 的庫存＝官方在外流通單位數的 T−2 交易日（逐週一單位不差）。
            端點若剛好碰上巨額申贖，兩邊方向可能完全相反。
            <br />
            「每人平均持有」＝該級距單位數 ÷ 人數，用來看這一級的人是加碼還是減碼；
            但級距是固定區間、人會跨級移動，所以它是<strong style={{ color: TEXT }}>「當期落在此級的人」的平均</strong>，
            不是同一批人的追蹤——某級平均下降也可能是上一級有人減碼掉下來。
          </p>
        </>
      )}
    </div>
  );
}
