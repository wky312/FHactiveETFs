'use client';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import { SectorGroup } from '@/lib/sectorGroups';
import {
  listAll, listCustom, saveGroup, deleteGroup, exportJson, importJson, normalizeCode,
  listAllOverseas, listCustomOverseas, saveGroupOverseas, deleteGroupOverseas,
  exportJsonOverseas, importJsonOverseas, normalizeCodeOverseas,
} from '@/lib/groupStore';
import { buildSectorMatrix, resolveStockName, resolveStockNameOverseas, ConsensusResult, SectorExposureResult } from '@/lib/sectorExposure';
import { buildGicsMatrix, GicsExposureResult } from '@/lib/gicsExposure';
import GicsExposureView from './GicsExposureView';

/* 'gics' 與 'overseas' 共用同一份持股資料（/api/consensus-overseas）與同一套代碼空間，
   只是呈現改成 GICS 類別彙總表；自訂族群、個股選擇那一整組介面在 gics 模式下不使用。 */
type Market = 'tw' | 'overseas' | 'gics';

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
  const [market, setMarket] = useState<Market>('tw');
  const [data, setData] = useState<ConsensusResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  /* 國內/海外兩套族群定義、自訂族群儲存、股名解析完全獨立（代碼空間不通用），
     用一個依 market 切換的 bundle 集中管理，下面呼叫端不用到處寫三元判斷。 */
  const store = useMemo(() => (market === 'tw'
    ? { listAll, listCustom, saveGroup, deleteGroup, exportJson, importJson, normalizeCode, resolveName: resolveStockName }
    : { listAll: listAllOverseas, listCustom: listCustomOverseas, saveGroup: saveGroupOverseas,
        deleteGroup: deleteGroupOverseas, exportJson: exportJsonOverseas, importJson: importJsonOverseas,
        normalizeCode: normalizeCodeOverseas, resolveName: resolveStockNameOverseas }
  ), [market]);

  const [gicsSec, setGicsSec] = useState<string | null>(null);   // GICS 模式下展開中的類別 id
  const [codes, setCodes] = useState<string[]>([]);
  const [appliedGroups, setAppliedGroups] = useState<string[]>([]);  // 目前疊加套用中的族群名稱，可複數
  const [groupQuery, setGroupQuery] = useState('');       // 族群搜尋框輸入中的文字
  const [groupFocused, setGroupFocused] = useState(false);
  const [query, setQuery] = useState('');
  const [onlyHolders, setOnlyHolders] = useState(false);
  const [sortBy, setSortBy] = useState<string>('group');   // 'group' | stockid
  const [custom, setCustom] = useState<SectorGroup[]>([]);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const urlApplied = useRef(false);

  /* consensus 一包資料含全市場每檔個股的持有者與佔比，抓一次即可；改選股只重算矩陣。
     market 切換要重打不同 API（國內走 Supabase 共用 DB，海外走 fhtrust+CMoney 即時抓取）。
     掛載時 market 會先以預設值 'tw' 觸發一次抓取、緊接著網址還原 effect 可能把 market 改成
     'overseas' 觸發第二次抓取——兩個請求併發時無法保證後發的先回來，用 seq 只採信「最後一次
     呼叫」的結果，避免舊的（例如國內）回應蓋掉新的（海外）畫面。 */
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true); setError(''); setData(null);
    try {
      const r = await fetch(market === 'tw' ? '/api/consensus' : '/api/consensus-overseas');
      const json = await r.json();
      if (seq !== loadSeq.current) return;   // 已經有更新的呼叫在跑，這個回應過期了
      if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
      setData(json as ConsensusResult);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [market]);
  useEffect(() => { load(); }, [load]);

  /* custom 族群清單跟著 market 走：掛載時、以及使用者切換國內/海外時都要重新讀對應的 localStorage。 */
  useEffect(() => { setCustom(store.listCustom()); }, [store]);

  /* 掛載後才讀網址，避免 SSR 與 client 初值不同造成 hydration mismatch。
     market 要先還原（決定用哪一套 normalizeCode/listAll），codes/g 才能正確解析；
     g 可以是逗號分隔的多個族群名稱（疊加套用）；codes 有值時以它為準，g 只用來還原「套用中」的標籤。 */
  useEffect(() => {
    if (urlApplied.current) return;
    urlApplied.current = true;
    const sp = new URLSearchParams(window.location.search);
    const m = sp.get('market');
    const urlMarket: Market = m === 'gics' ? 'gics' : m === 'overseas' ? 'overseas' : 'tw';
    if (urlMarket !== market) setMarket(urlMarket);
    if (urlMarket === 'gics') { setGicsSec(sp.get('sec')); return; }   // GICS 模式沒有 codes/g
    const norm = urlMarket === 'tw' ? normalizeCode : normalizeCodeOverseas;
    const all = urlMarket === 'tw' ? listAll : listAllOverseas;

    const raw = sp.get('codes');
    const gNames = (sp.get('g') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (raw) {
      setCodes(raw.split(',').map(norm).filter(Boolean).slice(0, MAX_CODES));
      if (gNames.length) setAppliedGroups(gNames.filter(n => all().some(x => x.name === n)));
    } else if (gNames.length) {
      const found = gNames.map(n => all().find(x => x.name === n)).filter((x): x is SectorGroup => !!x);
      if (found.length) {
        const merged: string[] = [];
        for (const fg of found) for (const c of fg.codes) if (!merged.includes(c)) merged.push(c);
        setCodes(merged.slice(0, MAX_CODES));
        setAppliedGroups(found.map(f => f.name));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 選股同步進網址：分享連結即是「族群定義」的傳遞方式，g 用逗號分隔多個族群名稱。 */
  useEffect(() => {
    if (!urlApplied.current) return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('tab') !== 'sector') return;   // 只在本分頁作用中才動網址
    if (market === 'tw') sp.delete('market'); else sp.set('market', market);
    if (market !== 'gics' && codes.length) sp.set('codes', codes.join(',')); else sp.delete('codes');
    if (market !== 'gics' && appliedGroups.length) sp.set('g', appliedGroups.join(',')); else sp.delete('g');
    if (market === 'gics' && gicsSec) sp.set('sec', gicsSec); else sp.delete('sec');
    window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`);
  }, [market, codes, appliedGroups, gicsSec]);

  const groups = useMemo(() => {
    const customNames = new Set(custom.map(g => g.name));
    return { custom, builtin: store.listAll().filter(g => g.builtin && !customNames.has(g.name)) };
  }, [custom, store]);

  /* 族群搜尋：44 組內建＋自訂，肉眼找太慢，改用文字篩選。空字串時顯示全部。
     ⚠ 一定要 toLowerCase 再比：海外族群名稱與代碼是英文大寫（SPCX、CPO、AI…），
     使用者打小寫 spcx 時 'SPCX'.includes('spcx') 是 false，會回「查無」——
     這行原本的註解就寫著「不分大小寫」，但程式碼其實是大小寫敏感的。 */
  const groupMatches = useMemo(() => {
    const q = groupQuery.trim().toLowerCase();
    const filt = (arr: SectorGroup[]) => (q ? arr.filter(g => g.name.toLowerCase().includes(q)) : arr);
    return { custom: filt(groups.custom), builtin: filt(groups.builtin) };
  }, [groups, groupQuery]);

  /* 選股候選：全市場被持有的個股 ∪ 內建族群成分股（後者可能無人持有，仍要能選到並看見 0.00%）。 */
  const candidates = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of store.listAll()) for (const c of g.codes) m.set(c, store.resolveName(c));
    for (const s of data?.stocks ?? []) m.set(s.stockid, s.stockname);
    return [...m.entries()].map(([stockid, stockname]) => ({ stockid, stockname })).sort((a, b) => a.stockid.localeCompare(b.stockid));
  }, [data, store]);

  // 同上：海外代碼清一色大寫（SPCX / AXTI / FSLY…），小寫輸入必須也搜得到。
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return candidates
      .filter(c => c.stockid.toLowerCase().includes(q) || c.stockname.toLowerCase().includes(q))
      .slice(0, 12);
  }, [candidates, query]);

  const result: SectorExposureResult | null = useMemo(
    () => (data && codes.length ? buildSectorMatrix(data, codes, store.resolveName) : null),
    [data, codes, store],
  );

  const gicsResult: GicsExposureResult | null = useMemo(
    () => (market === 'gics' && data ? buildGicsMatrix(data) : null),
    [data, market],
  );

  const fundRows = useMemo(() => {
    if (!result) return [];
    const xs = onlyHolders ? result.funds.filter(f => f.groupWeight > 0) : result.funds;
    return [...xs].sort((a, b) =>
      sortBy === 'group' ? b.groupWeight - a.groupWeight : (b.weights[sortBy] ?? 0) - (a.weights[sortBy] ?? 0));
  }, [result, onlyHolders, sortBy]);

  const addCode = (c: string) => {
    const code = store.normalizeCode(c);
    if (!code || codes.includes(code) || codes.length >= MAX_CODES) return;
    setCodes([...codes, code]);
    setQuery('');
  };
  const removeCode = (c: string) => setCodes(codes.filter(x => x !== c));

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(''), 2400); };

  /* 選族群＝疊加合併進目前已選個股，不是取代——這樣可以同時套用「記憶體」+「IC載板」。 */
  const pickGroup = (g: SectorGroup) => {
    setCodes(prev => {
      const merged = [...prev];
      for (const c of g.codes) if (!merged.includes(c)) merged.push(c);
      if (merged.length > MAX_CODES) flash(`已達上限 ${MAX_CODES} 檔，部分股票未加入`);
      return merged.slice(0, MAX_CODES);
    });
    setAppliedGroups(prev => (prev.includes(g.name) ? prev : [...prev, g.name]));
  };
  /* 移除某個已套用的族群：只拿掉屬於它的個股（若與其他仍套用中的族群重疊會一併移除，簡化模型）。 */
  const removeAppliedGroup = (name: string) => {
    const g = store.listAll().find(x => x.name === name);
    if (g) setCodes(prev => prev.filter(c => !g.codes.includes(c)));
    setAppliedGroups(prev => prev.filter(n => n !== name));
  };

  const onSaveGroup = () => {
    const name = window.prompt('族群名稱', appliedGroups.join('+') || '我的族群');
    if (!name?.trim()) return;
    store.saveGroup({ name: name.trim(), codes });
    setCustom(store.listCustom());
    setAppliedGroups(prev => (prev.includes(name.trim()) ? prev : [...prev, name.trim()]));
    flash(`已存為「${name.trim()}」`);
  };
  const onDeleteGroup = (name: string) => {
    if (!window.confirm(`刪除自訂族群「${name}」？`)) return;
    store.deleteGroup(name);
    setCustom(store.listCustom());
    flash(`已刪除「${name}」`);
  };
  const onExport = () => {
    const blob = new Blob([store.exportJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '我的族群.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const onImport = async (file: File) => {
    const res = store.importJson(await file.text());
    if (!res.ok) { flash(`匯入失敗：${res.error}`); return; }
    setCustom(store.listCustom());
    flash(`已匯入 ${res.added} 個族群`);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true); setTimeout(() => setCopied(false), 1800);
    } catch { /* 剪貼簿不可用時略過 */ }
  };

  const exportGicsExcel = () => {
    if (!gicsResult) return;
    const g = gicsResult;
    const head = ['ETF', '名稱', '持股日', ...g.sectors.map(s => s.zh), '股票合計%'];
    const body = g.funds.map(f => [
      f.ticker, f.name, f.holdingDate ?? '', ...g.sectors.map(s => (f.bySector[s.id] ?? 0).toFixed(2)), f.total.toFixed(2),
    ]);
    const foot = [
      ['全市場等權平均', '', '', ...g.sectors.map(s => s.equalAvg.toFixed(3)), g.totalEqualAvg.toFixed(3)],
      ['持有檔數', '', '', ...g.sectors.map(s => String(s.heldBy)), ''],
    ];
    const ws = XLSX.utils.aoa_to_sheet([head, ...body, [], ...foot]);
    // 第二張表：全部個股依類別列出，Excel 裡可自行篩選
    const dHead = ['GICS類別', '代號', '名稱', '持有檔數', ...g.funds.map(f => f.ticker), '合計%'];
    const dBody = g.sectors.flatMap(s => s.stocks.map(st => [
      s.zh, st.stockid, st.stockname, st.heldBy, ...g.funds.map(f => (st.weights[f.ticker] ?? 0).toFixed(2)), st.sumWeight.toFixed(2),
    ]));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'GICS類別曝險');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([dHead, ...dBody]), '個股明細');
    XLSX.writeFile(wb, `海外GICS類別曝險_${g.asOf}.xlsx`);
  };

  const exportExcel = () => {
    if (!result) return;
    // 海外模式沒有可靠的規模來源（navProxy 恆為 null），拿掉「估計規模」欄與「市值加權」列，
    // 不然匯出的表格會有一整欄「—」和一列意義不明的 0.00%。
    const showMkt = market === 'tw';
    const head = ['ETF', '名稱', '持股日', ...(showMkt ? ['估計規模(億)'] : []), ...result.stocks.map(s => `${s.stockid} ${s.stockname}`), '族群合計%'];
    const body = fundRows.map(f => [
      f.ticker, f.name, f.holdingDate ?? '', ...(showMkt ? [oku(f.navProxy)] : []),
      ...result.stocks.map(s => f.weights[s.stockid].toFixed(2)), f.groupWeight.toFixed(2),
    ]);
    const blanks = showMkt ? ['', '', ''] : ['', ''];   // 對齊「名稱/持股日(/估計規模)」欄
    const foot = [
      ['全市場等權平均', ...blanks, ...result.stocks.map(s => s.equalAvg.toFixed(3)), result.totals.equalAvg.toFixed(3)],
      ...(showMkt ? [['全市場市值加權', '', '', '', ...result.stocks.map(s => s.mktWeight.toFixed(3)), result.totals.mktWeight.toFixed(3)]] : []),
      ['持有檔數', ...blanks, ...result.stocks.map(s => String(s.heldBy)), String(result.totals.heldByAny)],
    ];
    const ws = XLSX.utils.aoa_to_sheet([head, ...body, [], ...foot]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '族群曝險');
    XLSX.writeFile(wb, `族群曝險_${appliedGroups.join('+') || '自選'}_${result.asOf}.xlsx`);
  };

  /* 切換國內/海外：兩個代碼空間完全不相容（2454 vs 2454.TW 是不同的 lookup key），
     殘留選取只會顯示空的/沒意義的列，比直接清空更誤導，故整個重置。 */
  const switchMarket = (m: Market) => {
    if (m === market) return;
    setMarket(m);
    setCodes([]); setAppliedGroups([]); setData(null); setError(''); setQuery(''); setGroupQuery(''); setGicsSec(null);
  };

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>
      {/* ── 國內/海外切換 ── */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 12, border: `1px solid ${BORDER}`, borderRadius: 8, width: 'fit-content', overflow: 'hidden' }}>
        {([['tw', '國內族群'], ['overseas', '海外族群'], ['gics', '海外GICS分類']] as const).map(([m, label]) => (
          <button key={m} onClick={() => switchMarket(m)}
            style={{
              padding: '7px 20px', border: 'none', cursor: 'pointer', fontSize: '.84rem', fontFamily: SANS,
              fontWeight: market === m ? 700 : 500,
              background: market === m ? RED : CARD, color: market === m ? '#fff' : SUB,
            }}>
            {label}
          </button>
        ))}
      </div>

      {/* ── GICS 類別彙總（不使用下方的族群/個股選擇介面）── */}
      {market === 'gics' && (
        <>
          <p style={{ color: SUB, fontSize: '.85rem', marginTop: 0 }}>
            依 GICS 11 大類別，看海外 {data?.nFunds ?? 10} 檔主動式 ETF 的股票部位怎麼分配。
          </p>
          {loading && <p style={{ color: SUB, fontSize: '.85rem' }}>載入海外持股中…</p>}
          {error && <p style={{ color: RED, fontSize: '.85rem' }}>{error}</p>}
          {gicsResult && (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
                <div style={{ flex: 1 }} />
                <button onClick={copyLink} style={toolBtn}>{copied ? '✓ 連結已複製' : '複製分享連結'}</button>
                <button onClick={exportGicsExcel} style={toolBtn}>儲存成表格（Excel）</button>
              </div>
              <GicsExposureView data={gicsResult} sec={gicsSec} onSec={setGicsSec} />
            </>
          )}
        </>
      )}

      {/* ── 族群選擇 ── */}
      {market !== 'gics' && (<>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ position: 'relative' }}>
          <input
            value={groupQuery}
            onChange={e => setGroupQuery(e.target.value)}
            onFocus={() => setGroupFocused(true)}
            onBlur={() => setGroupFocused(false)}
            placeholder="搜尋並加入族群…"
            style={{ ...toolBtn, cursor: 'text', width: 240, color: TEXT }} />
          {groupFocused && (
            <div onMouseDown={e => e.preventDefault()}
              style={{ position: 'absolute', top: '100%', left: 0, zIndex: 10, background: CARD, border: `1px solid ${BORDER}`,
                borderRadius: 6, marginTop: 4, boxShadow: '0 6px 18px rgba(0,0,0,.08)', minWidth: 340, maxHeight: 300, overflowY: 'auto', overflowX: 'auto' }}>
              {groupMatches.custom.length === 0 && groupMatches.builtin.length === 0 && (
                <div style={{ padding: '8px 10px', fontSize: '.78rem', color: SUB }}>查無符合的族群</div>
              )}
              {groupMatches.custom.length > 0 && (
                <>
                  <div style={{ padding: '5px 10px 3px', fontSize: '.68rem', color: SUB, fontWeight: 600 }}>我的族群</div>
                  {groupMatches.custom.map(g => (
                    <div key={g.name} onClick={() => { pickGroup(g); setGroupQuery(''); }}
                      style={{ padding: '6px 10px', cursor: 'pointer', fontSize: '.8rem', whiteSpace: 'nowrap' }}>
                      {g.name}<span style={{ color: SUB, marginLeft: 6 }}>（{g.codes.length}）</span>
                      {appliedGroups.includes(g.name) && <span style={{ color: GOLD, marginLeft: 6 }}>✓ 已套用</span>}
                    </div>
                  ))}
                </>
              )}
              {groupMatches.builtin.length > 0 && (
                <>
                  <div style={{ padding: '5px 10px 3px', fontSize: '.68rem', color: SUB, fontWeight: 600 }}>內建產業族群</div>
                  {groupMatches.builtin.map(g => (
                    <div key={g.name} onClick={() => { pickGroup(g); setGroupQuery(''); }}
                      style={{ padding: '6px 10px', cursor: 'pointer', fontSize: '.8rem', whiteSpace: 'nowrap' }}>
                      {g.name}<span style={{ color: SUB, marginLeft: 6 }}>（{g.codes.length}）</span>
                      {appliedGroups.includes(g.name) && <span style={{ color: GOLD, marginLeft: 6 }}>✓ 已套用</span>}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

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
        {codes.length > 0 && <button onClick={() => { setCodes([]); setAppliedGroups([]); }} style={toolBtn}>清空</button>}
        {notice && <span style={{ fontSize: '.78rem', color: GOLD }}>{notice}</span>}
      </div>

      {/* ── 目前套用中的族群：可疊加多組，個別移除只拿掉該組的個股 ── */}
      {appliedGroups.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
          <span style={{ fontSize: '.75rem', color: SUB }}>已套用：</span>
          {appliedGroups.map(name => (
            <span key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px',
              background: '#FBEFE6', border: `1px solid ${GOLD}`, borderRadius: 12, fontSize: '.76rem', color: TEXT }}>
              {name}
              <span onClick={() => removeAppliedGroup(name)} style={{ cursor: 'pointer', color: SUB, fontWeight: 700 }}>×</span>
            </span>
          ))}
        </div>
      )}

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
              <span>{store.resolveName(c, data?.stocks.find(s => s.stockid === c)?.stockname)}</span>
              <span onClick={() => removeCode(c)} style={{ cursor: 'pointer', color: SUB, fontWeight: 700 }}>×</span>
            </span>
          ))}
        </div>
      )}

      {loading && <p style={{ color: SUB, fontSize: '.85rem' }}>載入全市場持股中…</p>}
      {error && <p style={{ color: RED, fontSize: '.85rem' }}>{error}</p>}
      {!loading && !error && !codes.length && (
        <p style={{ color: SUB, fontSize: '.85rem' }}>選一個內建產業族群，或自行複選個股，看{market === 'tw' ? '全市場' : '海外'} {data?.nFunds ?? (market === 'tw' ? 20 : 9)} 檔主動式 ETF 對它們的持有比例。</p>
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

          {/* ── 摘要 ──
              市值加權需要各基金規模(navProxy)，海外模式沒有可靠來源、恆為 null——與其顯示
              誤導性的 0%，不如整張卡不渲染（見 lib/consensusOverseas.ts 的說明）。 */}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 12 }}>
            {[
              ...(market === 'tw' ? [['全市場市值加權', pct(result.totals.mktWeight), '這些股票佔全市場主動 ETF 資金的比重']] : []),
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
                  <th style={{ ...TH, textAlign: 'left', position: 'sticky', left: 0, zIndex: 2 }}>ETF</th>
                  <th style={{ ...TH, textAlign: 'left' }}>持股日</th>
                  {market === 'tw' && <th style={{ ...TH, textAlign: 'right' }}>規模(億)</th>}
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
                    <td style={{ padding: '7px 10px', whiteSpace: 'nowrap', position: 'sticky', left: 0, zIndex: 1, background: CARD }}>
                      <span style={{ fontFamily: MONO, fontWeight: 600 }}>{f.ticker}</span>
                      <span style={{ color: SUB, fontSize: '.74rem', marginLeft: 6 }}>{f.name}</span>
                    </td>
                    <td style={{ padding: '7px 10px', fontFamily: MONO, fontSize: '.72rem', color: SUB }}>{f.holdingDate ?? '—'}</td>
                    {market === 'tw' && <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.76rem', color: SUB }}>{oku(f.navProxy)}</td>}
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
                  <td colSpan={market === 'tw' ? 3 : 2} style={{ padding: '7px 10px', fontSize: '.78rem', fontWeight: 600 }}>全市場等權平均</td>
                  {result.stocks.map(s => (
                    <td key={s.stockid} style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.78rem' }}>{pct(s.equalAvg, 3)}</td>
                  ))}
                  <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem', fontWeight: 700 }}>{pct(result.totals.equalAvg, 3)}</td>
                </tr>
                {market === 'tw' && (
                  <tr style={{ background: '#F7F4F0' }}>
                    <td colSpan={3} style={{ padding: '7px 10px', fontSize: '.78rem', fontWeight: 600 }}>全市場市值加權</td>
                    {result.stocks.map(s => (
                      <td key={s.stockid} style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.78rem', color: RED, fontWeight: 600 }}>{pct(s.mktWeight, 3)}</td>
                    ))}
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.84rem', fontWeight: 700, color: RED }}>{pct(result.totals.mktWeight, 3)}</td>
                  </tr>
                )}
                <tr style={{ background: '#F7F4F0' }}>
                  <td colSpan={market === 'tw' ? 3 : 2} style={{ padding: '7px 10px', fontSize: '.78rem', fontWeight: 600, color: SUB }}>持有檔數</td>
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
            權重為佔該基金淨值比例（holding.prate）。「等權平均」把每檔 ETF 等重看待，未持有記 0。<br />
            {market === 'tw' ? (
              <>
                「市值加權」以各檔估計淨資產加權，回答「全市場主動 ETF 的錢有多少比例押在這些股票」。<br />
                估計淨資產 = Σ(持股數 × 收盤價) ÷ (有報價持股的權重和 ÷ 100)，用意是還原現金部位；
                納入加權的基金淨資產合計 {(result.totalNav / 1e8).toFixed(0)} 億。
                {result.navExcluded.length > 0 && <> 報價覆蓋不足而排除於市值加權：{result.navExcluded.join('、')}。</>}
              </>
            ) : (
              '海外主動式ETF 尚無可靠的即時規模估算來源，本表僅提供持股權重矩陣與全市場等權平均，不提供市值加權統計。'
            )}
          </p>
        </>
      )}
      </>)}
    </div>
  );
}
