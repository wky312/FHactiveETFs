'use client';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import { SectorGroup } from '@/lib/sectorGroups';
import { listAll, listCustom, saveGroup, deleteGroup, exportJson, importJson, normalizeCode } from '@/lib/groupStore';
import { buildSectorMatrix, resolveStockName, ConsensusResult, SectorExposureResult } from '@/lib/sectorExposure';

const RED    = '#C00000';
const GOLD   = '#B08F6E';
const CARD   = '#FFFFFF';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

const MAX_CODES = 30;

const toolBtn: React.CSSProperties = {
  padding: '7px 16px', background: CARD, color: SUB, border: `1px solid ${BORDER}`,
  borderRadius: 6, cursor: 'pointer', fontSize: '.8rem', fontWeight: 500, fontFamily: SANS,
};
const TH: React.CSSProperties = {
  padding: '9px 10px', fontWeight: 600, fontSize: '.74rem', background: '#1C1C1E', color: '#fff',
  whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1,
};

function pct(v: number, d = 2): string { return v.toFixed(d) + '%'; }
function oku(v: number | null): string { return v == null ? '—' : (v / 1e8).toFixed(0); }

/** 權重越重底色越紅，讓矩陣一眼看得出誰在重壓。 */
function heat(w: number): React.CSSProperties {
  if (w <= 0) return { color: '#C9C4BF' };
  const a = Math.min(w / 10, 1);          // 10% 以上到頂
  return { background: `rgba(192,0,0,${(a * 0.16).toFixed(3)})`, color: TEXT, fontWeight: w >= 5 ? 700 : 500 };
}

export default function SectorExposureTab() {
  const [data, setData] = useState<ConsensusResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [codes, setCodes] = useState<string[]>([]);
  const [groupName, setGroupName] = useState('');
  const [query, setQuery] = useState('');
  const [onlyHolders, setOnlyHolders] = useState(false);
  const [sortBy, setSortBy] = useState<string>('group');   // 'group' | stockid
  const [custom, setCustom] = useState<SectorGroup[]>([]);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const urlApplied = useRef(false);

  /* consensus 一包資料含全市場每檔個股的持有者與佔比，抓一次即可；改選股只重算矩陣。 */
  const load = useCallback(async () => {
    setLoading(true); setError(''); setData(null);
    try {
      const r = await fetch('/api/consensus');
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
      setData(json as ConsensusResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  /* 掛載後才讀網址，避免 SSR 與 client 初值不同造成 hydration mismatch。 */
  useEffect(() => {
    setCustom(listCustom());
    if (urlApplied.current) return;
    urlApplied.current = true;
    const sp = new URLSearchParams(window.location.search);
    const raw = sp.get('codes');
    const g = sp.get('g');
    if (raw) {
      setCodes(raw.split(',').map(normalizeCode).filter(Boolean).slice(0, MAX_CODES));
      if (g) setGroupName(g);
    } else if (g) {
      const found = listAll().find(x => x.name === g);
      if (found) { setCodes(found.codes); setGroupName(g); }
    }
  }, []);

  /* 選股同步進網址：分享連結即是「族群定義」的傳遞方式。 */
  useEffect(() => {
    if (!urlApplied.current) return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('tab') !== 'sector') return;   // 只在本分頁作用中才動網址
    if (codes.length) sp.set('codes', codes.join(',')); else sp.delete('codes');
    if (groupName) sp.set('g', groupName); else sp.delete('g');
    window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`);
  }, [codes, groupName]);

  const groups = useMemo(() => {
    const customNames = new Set(custom.map(g => g.name));
    return { custom, builtin: listAll().filter(g => g.builtin && !customNames.has(g.name)) };
  }, [custom]);

  /* 選股候選：全市場被持有的個股 ∪ 內建族群成分股（後者可能無人持有，仍要能選到並看見 0.00%）。 */
  const candidates = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of listAll()) for (const c of g.codes) m.set(c, resolveStockName(c));
    for (const s of data?.stocks ?? []) m.set(s.stockid, s.stockname);
    return [...m.entries()].map(([stockid, stockname]) => ({ stockid, stockname })).sort((a, b) => a.stockid.localeCompare(b.stockid));
  }, [data]);

  const matches = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    return candidates.filter(c => c.stockid.includes(q) || c.stockname.includes(q)).slice(0, 12);
  }, [candidates, query]);

  const result: SectorExposureResult | null = useMemo(
    () => (data && codes.length ? buildSectorMatrix(data, codes) : null),
    [data, codes],
  );

  const fundRows = useMemo(() => {
    if (!result) return [];
    const xs = onlyHolders ? result.funds.filter(f => f.groupWeight > 0) : result.funds;
    return [...xs].sort((a, b) =>
      sortBy === 'group' ? b.groupWeight - a.groupWeight : (b.weights[sortBy] ?? 0) - (a.weights[sortBy] ?? 0));
  }, [result, onlyHolders, sortBy]);

  const addCode = (c: string) => {
    const code = normalizeCode(c);
    if (!code || codes.includes(code) || codes.length >= MAX_CODES) return;
    setCodes([...codes, code]);
    setQuery('');
  };
  const removeCode = (c: string) => setCodes(codes.filter(x => x !== c));

  const pickGroup = (g: SectorGroup) => { setCodes(g.codes.slice(0, MAX_CODES)); setGroupName(g.name); };

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(''), 2400); };

  const onSaveGroup = () => {
    const name = window.prompt('族群名稱', groupName || '我的族群');
    if (!name?.trim()) return;
    saveGroup({ name: name.trim(), codes });
    setCustom(listCustom());
    setGroupName(name.trim());
    flash(`已存為「${name.trim()}」`);
  };
  const onDeleteGroup = (name: string) => {
    if (!window.confirm(`刪除自訂族群「${name}」？`)) return;
    deleteGroup(name);
    setCustom(listCustom());
    flash(`已刪除「${name}」`);
  };
  const onExport = () => {
    const blob = new Blob([exportJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '我的族群.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const onImport = async (file: File) => {
    const res = importJson(await file.text());
    if (!res.ok) { flash(`匯入失敗：${res.error}`); return; }
    setCustom(listCustom());
    flash(`已匯入 ${res.added} 個族群`);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true); setTimeout(() => setCopied(false), 1800);
    } catch { /* 剪貼簿不可用時略過 */ }
  };

  const exportExcel = () => {
    if (!result) return;
    const head = ['ETF', '名稱', '持股日', '估計規模(億)', ...result.stocks.map(s => `${s.stockid} ${s.stockname}`), '族群合計%'];
    const body = fundRows.map(f => [
      f.ticker, f.name, f.holdingDate ?? '', oku(f.navProxy),
      ...result.stocks.map(s => f.weights[s.stockid].toFixed(2)), f.groupWeight.toFixed(2),
    ]);
    const foot = [
      ['全市場等權平均', '', '', '', ...result.stocks.map(s => s.equalAvg.toFixed(3)), result.totals.equalAvg.toFixed(3)],
      ['全市場市值加權', '', '', '', ...result.stocks.map(s => s.mktWeight.toFixed(3)), result.totals.mktWeight.toFixed(3)],
      ['持有檔數', '', '', '', ...result.stocks.map(s => String(s.heldBy)), String(result.totals.heldByAny)],
    ];
    const ws = XLSX.utils.aoa_to_sheet([head, ...body, [], ...foot]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '族群曝險');
    XLSX.writeFile(wb, `族群曝險_${groupName || '自選'}_${result.asOf}.xlsx`);
  };

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>
      {/* ── 族群選擇 ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <select value={groupName} onChange={e => {
          const g = listAll().find(x => x.name === e.target.value);
          if (g) pickGroup(g); else { setGroupName(''); }
        }} style={{ ...toolBtn, cursor: 'pointer', minWidth: 190 }}>
          <option value="">選擇族群…</option>
          {groups.custom.length > 0 && (
            <optgroup label="我的族群">
              {groups.custom.map(g => <option key={g.name} value={g.name}>{g.name}（{g.codes.length}）</option>)}
            </optgroup>
          )}
          <optgroup label="內建產業族群">
            {groups.builtin.map(g => <option key={g.name} value={g.name}>{g.name}（{g.codes.length}）</option>)}
          </optgroup>
        </select>

        <div style={{ position: 'relative' }}>
          <input value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && matches[0]) addCode(matches[0].stockid); }}
            placeholder="加入個股（代碼或名稱）"
            style={{ ...toolBtn, cursor: 'text', width: 210, color: TEXT }} />
          {matches.length > 0 && (
            <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 10, background: CARD, border: `1px solid ${BORDER}`,
              borderRadius: 6, marginTop: 4, boxShadow: '0 6px 18px rgba(0,0,0,.08)', minWidth: 210, maxHeight: 280, overflowY: 'auto' }}>
              {matches.map(m => (
                <div key={m.stockid} onClick={() => addCode(m.stockid)}
                  style={{ padding: '6px 10px', cursor: 'pointer', fontSize: '.8rem', display: 'flex', gap: 8 }}>
                  <span style={{ fontFamily: MONO, color: SUB }}>{m.stockid}</span>
                  <span>{m.stockname}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <button onClick={onSaveGroup} style={toolBtn} disabled={!codes.length}>存為我的族群</button>
        <button onClick={onExport} style={toolBtn} disabled={!custom.length}>匯出</button>
        <button onClick={() => fileRef.current?.click()} style={toolBtn}>匯入</button>
        <input ref={fileRef} type="file" accept="application/json" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ''; }} />
        {codes.length > 0 && <button onClick={() => { setCodes([]); setGroupName(''); }} style={toolBtn}>清空</button>}
        {notice && <span style={{ fontSize: '.78rem', color: GOLD }}>{notice}</span>}
      </div>

      {/* ── 我的族群：可刪除 ── */}
      {custom.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
          <span style={{ fontSize: '.75rem', color: SUB }}>我的族群：</span>
          {custom.map(g => (
            <span key={g.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px',
              border: `1px solid ${BORDER}`, borderRadius: 12, fontSize: '.76rem' }}>
              <span onClick={() => pickGroup(g)} style={{ cursor: 'pointer' }}>{g.name}</span>
              <span onClick={() => onDeleteGroup(g.name)} style={{ cursor: 'pointer', color: SUB }}>×</span>
            </span>
          ))}
        </div>
      )}

      {/* ── 已選個股 ── */}
      {codes.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {codes.map(c => (
            <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px',
              background: '#F7F4F0', border: `1px solid ${BORDER}`, borderRadius: 14, fontSize: '.78rem' }}>
              <span style={{ fontFamily: MONO, color: SUB }}>{c}</span>
              <span>{resolveStockName(c, data?.stocks.find(s => s.stockid === c)?.stockname)}</span>
              <span onClick={() => removeCode(c)} style={{ cursor: 'pointer', color: SUB, fontWeight: 700 }}>×</span>
            </span>
          ))}
        </div>
      )}

      {loading && <p style={{ color: SUB, fontSize: '.85rem' }}>載入全市場持股中…</p>}
      {error && <p style={{ color: RED, fontSize: '.85rem' }}>{error}</p>}
      {!loading && !error && !codes.length && (
        <p style={{ color: SUB, fontSize: '.85rem' }}>選一個內建產業族群，或自行複選個股，看全市場 {data?.nFunds ?? 20} 檔主動式 ETF 對它們的持有比例。</p>
      )}

      {result && (
        <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <label style={{ fontSize: '.78rem', color: SUB, display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={onlyHolders} onChange={e => setOnlyHolders(e.target.checked)} />
              只顯示有持有的 ETF
            </label>
            <div style={{ flex: 1 }} />
            <button onClick={copyLink} style={toolBtn}>{copied ? '✓ 連結已複製' : '複製分享連結'}</button>
            <button onClick={exportExcel} style={toolBtn}>儲存成表格（Excel）</button>
          </div>

          {/* ── 摘要 ── */}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 12 }}>
            {[
              ['全市場市值加權', pct(result.totals.mktWeight), '這些股票佔全市場主動 ETF 資金的比重'],
              ['全市場等權平均', pct(result.totals.equalAvg), '平均每檔主動 ETF 押在這些股票的比重'],
              ['持有檔數', `${result.totals.heldByAny} / ${result.nFunds}`, '至少持有族群中一檔的 ETF 數'],
            ].map(([label, value, hint]) => (
              <div key={label} style={{ flex: '1 1 200px', border: `1px solid ${BORDER}`, borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ fontSize: '.72rem', color: SUB }}>{label}</div>
                <div style={{ fontFamily: MONO, fontSize: '1.5rem', fontWeight: 700, color: RED }}>{value}</div>
                <div style={{ fontSize: '.68rem', color: SUB }}>{hint}</div>
              </div>
            ))}
          </div>

          <div style={{ overflowX: 'auto', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 640 }}>
              <thead>
                <tr>
                  <th style={{ ...TH, textAlign: 'left' }}>ETF</th>
                  <th style={{ ...TH, textAlign: 'left' }}>持股日</th>
                  <th style={{ ...TH, textAlign: 'right' }}>規模(億)</th>
                  {result.stocks.map(s => (
                    <th key={s.stockid} onClick={() => setSortBy(s.stockid)}
                      style={{ ...TH, textAlign: 'right', cursor: 'pointer' }} title="點擊依此股權重排序">
                      {s.stockname}<br /><span style={{ fontWeight: 400, opacity: .7, fontFamily: MONO }}>{s.stockid}</span>
                    </th>
                  ))}
                  <th onClick={() => setSortBy('group')} style={{ ...TH, textAlign: 'right', cursor: 'pointer', background: RED }}>
                    族群合計
                  </th>
                </tr>
              </thead>
              <tbody>
                {fundRows.map(f => (
                  <tr key={f.ticker} style={{ borderTop: `1px solid ${BORDER}` }}>
                    <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                      <span style={{ fontFamily: MONO, fontWeight: 600 }}>{f.ticker}</span>
                      <span style={{ color: SUB, fontSize: '.74rem', marginLeft: 6 }}>{f.name}</span>
                    </td>
                    <td style={{ padding: '7px 10px', fontFamily: MONO, fontSize: '.72rem', color: SUB }}>{f.holdingDate ?? '—'}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.76rem', color: SUB }}>{oku(f.navProxy)}</td>
                    {result.stocks.map(s => (
                      <td key={s.stockid} style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', ...heat(f.weights[s.stockid]) }}>
                        {f.weights[s.stockid] > 0 ? pct(f.weights[s.stockid]) : '–'}
                      </td>
                    ))}
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.84rem', fontWeight: 700,
                      color: f.groupWeight > 0 ? RED : '#C9C4BF' }}>
                      {f.groupWeight > 0 ? pct(f.groupWeight) : '–'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `2px solid ${TEXT}`, background: '#F7F4F0' }}>
                  <td colSpan={3} style={{ padding: '7px 10px', fontSize: '.78rem', fontWeight: 600 }}>全市場等權平均</td>
                  {result.stocks.map(s => (
                    <td key={s.stockid} style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.78rem' }}>{pct(s.equalAvg, 3)}</td>
                  ))}
                  <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', fontWeight: 700 }}>{pct(result.totals.equalAvg, 3)}</td>
                </tr>
                <tr style={{ background: '#F7F4F0' }}>
                  <td colSpan={3} style={{ padding: '7px 10px', fontSize: '.78rem', fontWeight: 600 }}>全市場市值加權</td>
                  {result.stocks.map(s => (
                    <td key={s.stockid} style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.78rem', color: RED, fontWeight: 600 }}>{pct(s.mktWeight, 3)}</td>
                  ))}
                  <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.84rem', fontWeight: 700, color: RED }}>{pct(result.totals.mktWeight, 3)}</td>
                </tr>
                <tr style={{ background: '#F7F4F0' }}>
                  <td colSpan={3} style={{ padding: '7px 10px', fontSize: '.78rem', fontWeight: 600, color: SUB }}>持有檔數</td>
                  {result.stocks.map(s => (
                    <td key={s.stockid} style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.78rem', color: SUB }}>{s.heldBy}</td>
                  ))}
                  <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', color: SUB }}>{result.totals.heldByAny}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p style={{ fontSize: '.7rem', color: SUB, marginTop: 10, lineHeight: 1.7 }}>
            資料日 {result.asOf}。各檔 ETF 申報持股的日期不同，表中「持股日」為該檔自身最新申報日。<br />
            權重為佔該基金淨值比例（holding.prate）。「等權平均」把每檔 ETF 等重看待，未持有記 0；
            「市值加權」以各檔估計淨資產加權，回答「全市場主動 ETF 的錢有多少比例押在這些股票」。<br />
            估計淨資產 = Σ(持股數 × 收盤價) ÷ (有報價持股的權重和 ÷ 100)，用意是還原現金部位；
            納入加權的基金淨資產合計 {(result.totalNav / 1e8).toFixed(0)} 億。
            {result.navExcluded.length > 0 && <> 報價覆蓋不足而排除於市值加權：{result.navExcluded.join('、')}。</>}
          </p>
        </>
      )}
    </div>
  );
}
