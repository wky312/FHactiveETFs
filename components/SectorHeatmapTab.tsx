'use client';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { HeatmapResult, HeatmapGroup } from '@/lib/sectorHeatmap';
import { RRGResult, Quadrant } from '@/lib/sectorRRG';
import { HeatmapMarket } from '@/lib/sectorGroupsShared';

/* 產業熱力圖 + Relative Rotation Graphs（RRG）—— 共用同一套國內/海外族群切換與個股鑽取明細。
   見對話中跟使用者確認過的設計：熱力圖預設抓「最近一日」、可切自訂區間；RRG 沿用使用者
   先前在 macro-dashboard 專案做過的 JdK RS-Ratio/Momentum，象限配色維持業界標準四色
   （不是本站慣用的紅漲綠跌——那是漲跌方向，這裡是輪動階段，語意不同，使用者已確認可以）。 */

const RED    = '#C00000';
const GREEN  = '#16a34a';
const GOLD   = '#B08F6E';
const CARD   = '#FFFFFF';
const TEXT   = '#1C1C1E';
const SUB    = '#6B6460';
const BORDER = '#EEE9E4';
const MONO   = "'IBM Plex Mono', 'Courier New', monospace";
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

const QUAD_COLOR: Record<Quadrant, string> = {
  leading: '#16a34a', weakening: '#ca8a04', lagging: '#dc2626', improving: '#2563eb',
};
const QUAD_LABEL: Record<Quadrant, string> = {
  leading: 'Leading 領先', weakening: 'Weakening 轉弱', lagging: 'Lagging 落後', improving: 'Improving 轉強',
};

const toolBtn: React.CSSProperties = {
  padding: '7px 16px', background: CARD, color: SUB, border: `1px solid ${BORDER}`,
  borderRadius: 6, cursor: 'pointer', fontSize: '.8rem', fontWeight: 500, fontFamily: SANS,
};
const TH: React.CSSProperties = {
  padding: '8px 10px', fontWeight: 600, fontSize: '.74rem', background: '#1C1C1E', color: '#fff', whiteSpace: 'nowrap',
};

function pct(v: number | null, d = 2): string { return v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`; }

// 台灣慣例：漲紅跌綠，依絕對值深淺（±5% 到頂）；語意＝漲跌方向，跟 RRG 象限色（輪動階段）不同用途。
function heatColor(pct: number | null): React.CSSProperties {
  if (pct == null) return { background: '#F5F3F0', color: '#C9C4BF' };
  const a = Math.min(Math.abs(pct) / 5, 1);
  const color = pct >= 0 ? RED : GREEN;
  const rgb = pct >= 0 ? '192,0,0' : '22,163,74';
  return { background: `rgba(${rgb},${(0.08 + a * 0.28).toFixed(3)})`, color, fontWeight: Math.abs(pct) >= 2 ? 700 : 500 };
}

function localStr(d: Date): string {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function prevTradingDay(from: Date): Date {
  const d = new Date(from);
  do { d.setDate(d.getDate() - 1); } while (d.getDay() === 0 || d.getDay() === 6);
  return d;
}
function defaultEnd(): string {
  const now = new Date();
  const twHour = new Date(now.getTime() + 8 * 3600 * 1000).getUTCHours();
  const base = twHour < 17 ? prevTradingDay(now) : now;
  const day = base.getDay();
  return day === 0 || day === 6 ? localStr(prevTradingDay(base)) : localStr(base);
}
function defaultStart(): string { return localStr(prevTradingDay(new Date(defaultEnd()))); }

type ViewMode = 'heatmap' | 'rrg';
type RangeMode = 'latest' | 'custom';

interface ParsedParams { market: HeatmapMarket; view: ViewMode; rangeMode: RangeMode; start: string; end: string; group: string | null }

// 從網址querystring解析出這個分頁的完整狀態——掛載還原、瀏覽器上一頁/下一頁(popstate)都靠這個。
function parseParams(sp: URLSearchParams): ParsedParams {
  return {
    market: sp.get('market') === 'overseas' ? 'overseas' : 'tw',
    view: sp.get('view') === 'rrg' ? 'rrg' : 'heatmap',
    rangeMode: sp.get('mode') === 'custom' ? 'custom' : 'latest',
    start: sp.get('start') ?? defaultStart(),
    end: sp.get('end') ?? defaultEnd(),
    group: sp.get('group'),
  };
}

export default function SectorHeatmapTab() {
  const [market, setMarket] = useState<HeatmapMarket>('tw');
  const [view, setView] = useState<ViewMode>('heatmap');
  const [rangeMode, setRangeMode] = useState<RangeMode>('latest');
  const [start, setStart] = useState(defaultStart());
  const [end, setEnd] = useState(defaultEnd());

  // 每個 market 各自快取一份，切換市場/切換 view 不用重打（除非使用者主動換自訂區間）
  const heatmapCache = useRef<Partial<Record<HeatmapMarket, HeatmapResult>>>({});
  const rrgCache = useRef<Partial<Record<HeatmapMarket, RRGResult>>>({});
  const [heatmap, setHeatmap] = useState<HeatmapResult | null>(null);
  const [rrg, setRrg] = useState<RRGResult | null>(null);
  const [hmLoading, setHmLoading] = useState(false);
  const [rrgLoading, setRrgLoading] = useState(false);
  const [hmError, setHmError] = useState('');
  const [rrgError, setRrgError] = useState('');

  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [hoverGroup, setHoverGroup] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const urlApplied = useRef(false);

  // 目前畫面上「使用者實際選的」market——非同步抓取（20-40秒）期間使用者可能已經切走，
  // 用 ref 而非 state 閉包判斷結果回來時該不該真的套用到畫面，避免手滑切換時被慢回來的舊查詢蓋掉。
  const marketRef = useRef(market);
  useEffect(() => { marketRef.current = market; }, [market]);

  // mkt 參數預設吃目前 state，但呼叫端在「剛用 setMarket() 還沒重繪」的情況下（例如網址還原）
  // 必須明確傳入，否則這裡的 `market` closure 仍是舊值，會抓錯市場的資料。
  // force=true：盤中想看最新報價時繞過快取直接重查（見「強制查詢最新資料」按鈕）。
  const loadHeatmap = useCallback(async (mode: RangeMode, s: string, e: string, mkt: HeatmapMarket = market, force = false) => {
    setHmLoading(true); setHmError('');
    try {
      const qs = (mode === 'custom' ? `market=${mkt}&start=${s}&end=${e}` : `market=${mkt}`) + (force ? '&force=1' : '');
      const r = await fetch(`/api/sector-heatmap?${qs}`, force ? { cache: 'no-store' } : undefined);
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
      heatmapCache.current[mkt] = json;
      if (mkt === marketRef.current) setHeatmap(json);
    } catch (e) {
      if (mkt === marketRef.current) setHmError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      if (mkt === marketRef.current) setHmLoading(false);
    }
  }, [market]);

  const loadRrg = useCallback(async (mkt: HeatmapMarket = market) => {
    setRrgLoading(true); setRrgError('');
    try {
      const r = await fetch(`/api/sector-rrg?market=${mkt}`);
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
      rrgCache.current[mkt] = json;
      if (mkt === marketRef.current) setRrg(json);
    } catch (e) {
      if (mkt === marketRef.current) setRrgError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      if (mkt === marketRef.current) setRrgLoading(false);
    }
  }, [market]);

  // 掛載後還原網址（market/view/mode/start/end/group）。這裡是唯一負責「第一次載入」的地方——
  // 明確把剛讀出的 m 傳給 loadHeatmap/loadRrg，不依賴 market state（此時 setMarket 還沒重繪生效，
  // state closure 仍是預設值 'tw'）。下面兩個 effect 只處理「掛載之後」使用者自己觸發的切換，
  // 用 *FirstRun ref 跳過它們在同一次掛載也會執行到的那一輪，避免重複打兩次 API。
  useEffect(() => {
    if (urlApplied.current) return;
    urlApplied.current = true;
    const { market: m, view: v, rangeMode: mode, start: s, end: e, group: g } = parseParams(new URLSearchParams(window.location.search));
    setMarket(m); setView(v); setRangeMode(mode); setStart(s); setEnd(e);
    if (g) setSelectedGroup(g);
    if (v === 'rrg') loadRrg(m);
    // 深連結若直接指到某族群的鑽取明細（不論在哪個 view），明細表都是吃熱力圖口徑，要一併載入
    if (v === 'heatmap' || g) loadHeatmap(mode, s, e, m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 瀏覽器上一頁/下一頁（見下面 URL 同步 effect：「點進族群明細」會 pushState 新增一筆瀏覽紀錄，
  // 讓上一頁可以退出明細，而不是直接跳出整個網站）。popstate 不會自動觸發 React 重繪，
  // 網址變了但畫面狀態要自己讀網址回來同步——只需要更新 state，市場/view 若因此改變，
  // 既有的 marketFirstRun/viewFirstRun effect 會自動處理資料載入，這裡不用重複打 API。
  useEffect(() => {
    const onPopState = () => {
      const { market: m, view: v, rangeMode: mode, start: s, end: e, group: g } = parseParams(new URLSearchParams(window.location.search));
      setMarket(m); setView(v); setRangeMode(mode); setStart(s); setEnd(e); setSelectedGroup(g);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // 換市場（使用者點擊切換鈕）：優先用快取，沒有才重打；跳過掛載當下那一輪（已由上面處理）
  const marketFirstRun = useRef(true);
  useEffect(() => {
    if (marketFirstRun.current) { marketFirstRun.current = false; return; }
    const cachedHm = heatmapCache.current[market];
    if (cachedHm) setHeatmap(cachedHm); else if (view === 'heatmap') loadHeatmap(rangeMode, start, end, market);
    const cachedRrg = rrgCache.current[market];
    if (cachedRrg) setRrg(cachedRrg); else if (view === 'rrg') loadRrg(market);
    setSelectedGroup(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market]);

  // 切換熱力圖／RRG 檢視：還沒抓過該市場的資料才補抓；跳過掛載當下那一輪
  const viewFirstRun = useRef(true);
  useEffect(() => {
    if (viewFirstRun.current) { viewFirstRun.current = false; return; }
    if (view === 'rrg' && !rrgCache.current[market]) loadRrg(market);
    if (view === 'heatmap' && !heatmapCache.current[market]) loadHeatmap(rangeMode, start, end, market);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // 在 RRG 檢視點進鑽取明細、但熱力圖資料還沒載過時，補抓（明細用熱力圖的個股口徑）；
  // 深連結直接進明細的情況已由掛載 effect 處理，這裡跳過掛載當下那一輪避免重複打
  const groupFirstRun = useRef(true);
  useEffect(() => {
    if (groupFirstRun.current) { groupFirstRun.current = false; return; }
    if (selectedGroup && !heatmapCache.current[market] && !hmLoading) loadHeatmap(rangeMode, start, end, market);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroup]);

  // 狀態同步進網址（僅本分頁作用中才動）。除了「點進族群明細」這個動作，其餘一律用
  // replaceState（切市場/切view/換日期都不用每次塞一筆瀏覽紀錄）。「從沒選族群→選了族群」
  // 這個瞬間改用 pushState，新增一筆瀏覽紀錄，這樣使用者按瀏覽器上一頁才會退出明細、回到
  // 熱力圖列表，而不是直接跳出整個網站（原本全部用 replaceState，這筆「無族群」的網址從沒
  // 真的進過瀏覽紀錄，上一頁只能繼續往前跳到進站之前的頁面）。
  const prevSelectedGroup = useRef<string | null>(null);
  useEffect(() => {
    if (!urlApplied.current) return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('tab') !== 'sectorheatmap') return;
    if (market === 'overseas') sp.set('market', 'overseas'); else sp.delete('market');
    if (view === 'rrg') sp.set('view', 'rrg'); else sp.delete('view');
    if (rangeMode === 'custom') { sp.set('mode', 'custom'); sp.set('start', start); sp.set('end', end); }
    else { sp.delete('mode'); sp.delete('start'); sp.delete('end'); }
    if (selectedGroup) sp.set('group', selectedGroup); else sp.delete('group');

    const url = `${window.location.pathname}?${sp.toString()}`;
    const enteringGroup = selectedGroup != null && prevSelectedGroup.current == null;
    if (enteringGroup) window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
    prevSelectedGroup.current = selectedGroup;
  }, [market, view, rangeMode, start, end, selectedGroup]);

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch { /* 剪貼簿不可用時略過 */ }
  };

  const sortedGroups = useMemo(
    () => heatmap ? [...heatmap.groups].sort((a, b) => (b.avgPct ?? -Infinity) - (a.avgPct ?? -Infinity)) : [],
    [heatmap],
  );
  const selectedHeatGroup: HeatmapGroup | null = useMemo(
    () => heatmap?.groups.find(g => g.name === selectedGroup) ?? null,
    [heatmap, selectedGroup],
  );

  const switchMarket = (m: HeatmapMarket) => { if (m !== market) setMarket(m); };
  const applyCustomRange = () => { setRangeMode('custom'); loadHeatmap('custom', start, end); };
  const applyLatest = () => { setRangeMode('latest'); loadHeatmap('latest', start, end); };

  return (
    <div style={{ fontFamily: SANS, color: TEXT }}>
      {/* ── 國內/海外切換 ── */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', border: `1px solid ${BORDER}`, borderRadius: 8, width: 'fit-content', overflow: 'hidden' }}>
          {([['tw', '國內'], ['overseas', '海外']] as const).map(([m, label]) => (
            <button key={m} onClick={() => switchMarket(m)} style={{
              padding: '7px 20px', border: 'none', cursor: 'pointer', fontSize: '.84rem', fontFamily: SANS,
              fontWeight: market === m ? 700 : 500, background: market === m ? RED : CARD, color: market === m ? '#fff' : SUB,
            }}>{label}族群</button>
          ))}
        </div>
        <div style={{ display: 'flex', border: `1px solid ${BORDER}`, borderRadius: 8, width: 'fit-content', overflow: 'hidden' }}>
          {([['heatmap', '熱力圖'], ['rrg', 'Relative Rotation Graphs (RRG)']] as const).map(([v, label]) => (
            <button key={v} onClick={() => setView(v)} style={{
              padding: '7px 20px', border: 'none', cursor: 'pointer', fontSize: '.84rem', fontFamily: SANS,
              fontWeight: view === v ? 700 : 500, background: view === v ? GOLD : CARD, color: view === v ? '#fff' : SUB,
            }}>{label}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={copyLink} style={toolBtn}>{copied ? '✓ 連結已複製' : '複製分享連結'}</button>
      </div>

      {view === 'heatmap' && !selectedHeatGroup && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
            <label style={{ fontSize: '.78rem', color: SUB, display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
              <input type="radio" checked={rangeMode === 'latest'} onChange={applyLatest} />最近一日
            </label>
            <label style={{ fontSize: '.78rem', color: SUB, display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
              <input type="radio" checked={rangeMode === 'custom'} onChange={() => setRangeMode('custom')} />自訂區間
            </label>
            {rangeMode === 'custom' && (
              <>
                <div>
                  <label style={{ display: 'block', fontSize: '.74rem', color: SUB, marginBottom: 3 }}>起</label>
                  <input type="date" value={start} onChange={e => setStart(e.target.value)}
                    style={{ padding: '6px 10px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.84rem', fontFamily: MONO }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '.74rem', color: SUB, marginBottom: 3 }}>迄</label>
                  <input type="date" value={end} onChange={e => setEnd(e.target.value)}
                    style={{ padding: '6px 10px', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: '.84rem', fontFamily: MONO }} />
                </div>
                <button onClick={applyCustomRange} disabled={hmLoading} style={{ ...toolBtn, background: RED, color: '#fff', border: 'none' }}>
                  {hmLoading ? '載入中…' : '載入區間'}
                </button>
              </>
            )}
            <button onClick={() => loadHeatmap(rangeMode, start, end, market, true)} disabled={hmLoading}
              style={{ ...toolBtn, marginLeft: 'auto' }} title="繞過快取，直接重查目前所有個股的最新報價">
              {hmLoading ? '查詢中…' : '強制查詢最新資料'}
            </button>
          </div>

          {hmLoading && <p style={{ color: SUB, fontSize: '.85rem' }}>查詢 {market === 'tw' ? '約 269' : '約 122'} 檔個股報酬中，約需 20-40 秒…</p>}
          {hmError && <p style={{ color: RED, fontSize: '.85rem' }}>{hmError}</p>}

          {heatmap && !hmLoading && (
            <>
              <p style={{ fontSize: '.74rem', color: SUB, marginBottom: 10 }}>
                {heatmap.ranged ? `區間 ${heatmap.start} ～ ${heatmap.end}` : '最近一日漲跌'}　資料時間 {new Date(heatmap.asOf).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}　平常顯示的是快取（盤中不會即時更新），要看當下報價請按「強制查詢最新資料」；點擊族群看成分股明細
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
                {sortedGroups.map(g => (
                  <div key={g.name} onClick={() => setSelectedGroup(g.name)}
                    style={{
                      ...heatColor(g.avgPct), border: `1px solid ${BORDER}`, borderRadius: 8, padding: '10px 12px',
                      cursor: 'pointer', transition: 'transform .1s',
                    }}>
                    <div style={{ fontSize: '.78rem', fontWeight: 600, marginBottom: 4, color: TEXT }}>{g.name}</div>
                    <div style={{ fontFamily: MONO, fontSize: '1.1rem', fontWeight: 700 }}>{pct(g.avgPct)}</div>
                    <div style={{ fontSize: '.66rem', color: SUB, marginTop: 2 }}>{g.nOk}/{g.nTotal} 檔有資料</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {view === 'heatmap' && selectedHeatGroup && (
        <GroupDrilldown group={selectedHeatGroup} onBack={() => setSelectedGroup(null)} ranged={heatmap!.ranged} />
      )}

      {view === 'rrg' && !selectedHeatGroup && (
        <>
          {rrgLoading && <p style={{ color: SUB, fontSize: '.85rem' }}>查詢 6 個月日線並計算相對強度中，約需 20-40 秒…</p>}
          {rrgError && <p style={{ color: RED, fontSize: '.85rem' }}>{rrgError}</p>}
          {rrg && !rrgLoading && (
            <RRGView data={rrg} hoverGroup={hoverGroup} onHover={setHoverGroup} onSelect={setSelectedGroup} />
          )}
        </>
      )}

      {view === 'rrg' && selectedHeatGroup && (
        <GroupDrilldown group={selectedHeatGroup} onBack={() => setSelectedGroup(null)} ranged={heatmap?.ranged ?? false} />
      )}
    </div>
  );
}

/* ── 族群成分股明細（熱力圖與 RRG 共用） ── */
function GroupDrilldown({ group, onBack, ranged }: { group: HeatmapGroup; onBack: () => void; ranged: boolean }) {
  return (
    <div>
      <button onClick={onBack} style={{ ...toolBtn, marginBottom: 12 }}>← 返回</button>
      <h3 style={{ fontSize: '.95rem', fontWeight: 700, marginBottom: 4 }}>{group.name}</h3>
      <p style={{ fontSize: '.76rem', color: SUB, marginBottom: 10 }}>
        族群平均 {pct(group.avgPct)}（{group.nOk}/{group.nTotal} 檔有資料）
      </p>
      <div style={{ overflowX: 'auto', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 460 }}>
          <thead>
            <tr>
              <th style={{ ...TH, textAlign: 'left' }}>代碼</th>
              <th style={{ ...TH, textAlign: 'left' }}>名稱</th>
              {ranged && <th style={{ ...TH, textAlign: 'right' }}>起始價</th>}
              {ranged && <th style={{ ...TH, textAlign: 'right' }}>結束價</th>}
              {!ranged && <th style={{ ...TH, textAlign: 'right' }}>現價</th>}
              <th style={{ ...TH, textAlign: 'right' }}>漲跌%</th>
            </tr>
          </thead>
          <tbody>
            {group.stocks.map(s => (
              <tr key={s.code} style={{ borderTop: `1px solid ${BORDER}` }}>
                <td style={{ padding: '7px 10px', fontFamily: MONO, fontSize: '.8rem' }}>{s.code}</td>
                <td style={{ padding: '7px 10px', fontSize: '.82rem' }}>{s.name}</td>
                {ranged && <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.78rem', color: SUB }}>{s.startPrice?.toFixed(2) ?? '—'}</td>}
                {ranged && <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.78rem', color: SUB }}>{s.endPrice?.toFixed(2) ?? '—'}</td>}
                {!ranged && <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.78rem', color: SUB }}>{s.currentPrice?.toFixed(2) ?? '—'}</td>}
                <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.84rem', ...heatColor(s.pct) }}>{pct(s.pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── RRG 四象限散佈圖 + 列表 ── */
const RW = 720, RH = 460;
const RM = { top: 26, right: 20, bottom: 40, left: 46 };
const RPW = RW - RM.left - RM.right;
const RPH = RH - RM.top - RM.bottom;

function groupColor(i: number, n: number): string {
  return `hsl(${Math.round((i * 360) / Math.max(n, 1))}deg 62% 45%)`;
}

const ALL_QUADRANTS: Quadrant[] = ['leading', 'weakening', 'lagging', 'improving'];

function RRGView({ data, hoverGroup, onHover, onSelect }: {
  data: RRGResult; hoverGroup: string | null; onHover: (n: string | null) => void; onSelect: (n: string) => void;
}) {
  const groups = data.groups;
  // 象限篩選：關掉的象限在圖上淡出、列表裡直接不顯示——方便「先只看 Leading」這類需求
  const [activeQuad, setActiveQuad] = useState<Set<Quadrant>>(new Set(ALL_QUADRANTS));
  const toggleQuad = (q: Quadrant) => setActiveQuad(prev => {
    const next = new Set(prev);
    if (next.has(q)) next.delete(q); else next.add(q);
    return next.size ? next : new Set(ALL_QUADRANTS); // 不允許全部關掉變成空畫面，全關等於重置回全選
  });

  let minR = 100, maxR = 100, minM = 100, maxM = 100;
  for (const g of groups) for (const p of g.trail) {
    minR = Math.min(minR, p.rsRatio); maxR = Math.max(maxR, p.rsRatio);
    minM = Math.min(minM, p.rsMomentum); maxM = Math.max(maxM, p.rsMomentum);
  }
  const margin = 0.5;
  minR = Math.min(minR - margin, 100 - margin); maxR = Math.max(maxR + margin, 100 + margin);
  minM = Math.min(minM - margin, 100 - margin); maxM = Math.max(maxM + margin, 100 + margin);
  const rangeR = Math.max(100 - minR, maxR - 100), rangeM = Math.max(100 - minM, maxM - 100);
  minR = 100 - rangeR; maxR = 100 + rangeR; minM = 100 - rangeM; maxM = 100 + rangeM;

  const xOf = (r: number) => RM.left + ((r - minR) / (maxR - minR)) * RPW;
  const yOf = (m: number) => RM.top + (1 - (m - minM) / (maxM - minM)) * RPH;
  const cx = xOf(100), cy = yOf(100);

  const sortedTable = [...groups].filter(g => activeQuad.has(g.quadrant)).sort((a, b) => b.latest.rsRatio - a.latest.rsRatio);

  return (
    <div>
      <p style={{ fontSize: '.74rem', color: SUB, marginBottom: 8 }}>
        對比基準 {data.benchmark}　日線／樣本 {data.periodsUsed} 個交易日　資料時間 {new Date(data.asOf).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}
      </p>

      {/* 象限篩選：預設全開；關掉某象限＝圖上淡出＋列表隱藏，方便「先只看 Leading」這類需求 */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {ALL_QUADRANTS.map(q => {
          const on = activeQuad.has(q);
          return (
            <button key={q} onClick={() => toggleQuad(q)} style={{
              padding: '4px 12px', borderRadius: 999, cursor: 'pointer', fontSize: '.76rem', fontFamily: SANS, fontWeight: 700,
              border: `1.5px solid ${QUAD_COLOR[q]}`, background: on ? QUAD_COLOR[q] : '#fff', color: on ? '#fff' : QUAD_COLOR[q],
              opacity: on ? 1 : 0.6,
            }}>{QUAD_LABEL[q]}</button>
          );
        })}
      </div>

      {/* 圖固定在左側並隨頁面捲動黏住（sticky），右側族群列表自己捲動——
          解決「表格很長、選族群時看不到上面的圖」：兩邊同時看得到，不用來回滾。窄螢幕自動疊成上下。 */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 440px', minWidth: 320, position: 'sticky', top: 12, alignSelf: 'flex-start' }}>
          <svg viewBox={`0 0 ${RW} ${RH}`} style={{ width: '100%', height: 'auto', display: 'block', background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8 }}
            onMouseLeave={() => onHover(null)}>
            <rect x={cx} y={RM.top} width={RM.left + RPW - cx} height={cy - RM.top} fill={QUAD_COLOR.leading} opacity={0.06} />
            <rect x={cx} y={cy} width={RM.left + RPW - cx} height={RM.top + RPH - cy} fill={QUAD_COLOR.weakening} opacity={0.06} />
            <rect x={RM.left} y={cy} width={cx - RM.left} height={RM.top + RPH - cy} fill={QUAD_COLOR.lagging} opacity={0.06} />
            <rect x={RM.left} y={RM.top} width={cx - RM.left} height={cy - RM.top} fill={QUAD_COLOR.improving} opacity={0.06} />
            <rect x={RM.left} y={RM.top} width={RPW} height={RPH} fill="none" stroke={BORDER} />
            <line x1={cx} y1={RM.top} x2={cx} y2={RM.top + RPH} stroke="#D9C9BC" strokeDasharray="4 3" />
            <line x1={RM.left} y1={cy} x2={RM.left + RPW} y2={cy} stroke="#D9C9BC" strokeDasharray="4 3" />
            <text x={RW - RM.right - 6} y={RM.top + 16} textAnchor="end" fontSize={14} fontWeight={600} fill={QUAD_COLOR.leading} opacity={0.8}>Leading 領先</text>
            <text x={RW - RM.right - 6} y={RH - RM.bottom - 6} textAnchor="end" fontSize={14} fontWeight={600} fill={QUAD_COLOR.weakening} opacity={0.8}>Weakening 轉弱</text>
            <text x={RM.left + 6} y={RH - RM.bottom - 6} fontSize={14} fontWeight={600} fill={QUAD_COLOR.lagging} opacity={0.8}>Lagging 落後</text>
            <text x={RM.left + 6} y={RM.top + 16} fontSize={14} fontWeight={600} fill={QUAD_COLOR.improving} opacity={0.8}>Improving 轉強</text>
            <text x={RM.left + RPW / 2} y={RH - 6} textAnchor="middle" fontSize={13} fill={TEXT}>RS-Ratio →</text>
            <text x={14} y={RM.top + RPH / 2} textAnchor="middle" fontSize={13} fill={TEXT} transform={`rotate(-90 14 ${RM.top + RPH / 2})`}>RS-Momentum ↑</text>

            {groups.map((g, i) => {
              if (!g.trail.length) return null;
              const dimmed = !activeQuad.has(g.quadrant);
              const color = groupColor(i, groups.length);
              const active = hoverGroup === g.name;
              const pts = g.trail.map(p => ({ x: xOf(p.rsRatio), y: yOf(p.rsMomentum) }));
              const latest = pts[pts.length - 1];
              return (
                <g key={g.name} onMouseEnter={() => !dimmed && onHover(g.name)} onClick={() => !dimmed && onSelect(g.name)}
                  style={{ cursor: dimmed ? 'default' : 'pointer' }} opacity={dimmed ? 0.08 : 1}>
                  {pts.length > 1 && pts.slice(1).map((p, idx) => (
                    <line key={idx} x1={pts[idx].x} y1={pts[idx].y} x2={p.x} y2={p.y} stroke={color}
                      strokeWidth={active ? 2 : 1.2} opacity={active ? 0.85 : 0.15 + (idx / pts.length) * 0.4} />
                  ))}
                  {pts.map((p, idx) => {
                    const isLatest = idx === pts.length - 1;
                    const progress = idx / (pts.length - 1 || 1);
                    return (
                      <circle key={idx} cx={p.x} cy={p.y} r={isLatest ? (active ? 6.5 : 5) : 2 + progress * 1.5}
                        fill={color} opacity={active ? 0.95 : 0.3 + progress * 0.6} />
                    );
                  })}
                  {active && <text x={latest.x + 10} y={latest.y - 10} fontSize={18} fontWeight={700} fill={color}>{g.name}</text>}
                </g>
              );
            })}
          </svg>
          <p style={{ fontSize: '.68rem', color: SUB, marginTop: 10, lineHeight: 1.7 }}>
            每個族群把成分股日收盤等權合成一條「族群指數」，對 {data.benchmark} 算 JdK RS-Ratio(X軸)/RS-Momentum(Y軸)，
            兩軸皆以 100 為中心。軌跡＝最近 {groups.find(g => g.trail.length)?.trail.length ?? 10} 個交易日的移動路徑（點越大越新）。
            象限色為業界標準配色（輪動階段），與熱力圖的紅漲綠跌是不同語意。
          </p>
        </div>

        <div style={{ flex: '1 1 380px', minWidth: 300, maxHeight: '78vh', overflowY: 'auto', border: `1px solid ${BORDER}`, borderRadius: 8 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ ...TH, textAlign: 'left', position: 'sticky', top: 0 }}>族群</th>
                <th style={{ ...TH, textAlign: 'right', position: 'sticky', top: 0 }}>RS-Ratio</th>
                <th style={{ ...TH, textAlign: 'right', position: 'sticky', top: 0 }}>RS-Momentum</th>
                <th style={{ ...TH, textAlign: 'left', position: 'sticky', top: 0 }}>象限</th>
                <th style={{ ...TH, textAlign: 'right', position: 'sticky', top: 0 }}>樣本</th>
              </tr>
            </thead>
            <tbody>
              {sortedTable.map((g) => {
                const idx = groups.indexOf(g);
                return (
                  <tr key={g.name} onClick={() => onSelect(g.name)} onMouseEnter={() => onHover(g.name)}
                    style={{ borderTop: `1px solid ${BORDER}`, cursor: 'pointer', background: hoverGroup === g.name ? '#F7F4F0' : undefined }}>
                    <td style={{ padding: '7px 10px', fontSize: '.82rem', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 5, background: groupColor(idx, groups.length), display: 'inline-block', flexShrink: 0 }} />
                      {g.name}
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem' }}>{g.latest.rsRatio.toFixed(2)}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.8rem' }}>{g.latest.rsMomentum.toFixed(2)}</td>
                    <td style={{ padding: '7px 10px' }}>
                      <span style={{ fontSize: '.7rem', fontWeight: 700, color: QUAD_COLOR[g.quadrant] }}>{QUAD_LABEL[g.quadrant]}</span>
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: MONO, fontSize: '.76rem', color: SUB }}>{g.nOk}/{g.nTotal}</td>
                  </tr>
                );
              })}
              {!sortedTable.length && (
                <tr><td colSpan={5} style={{ padding: '14px 10px', textAlign: 'center', color: SUB, fontSize: '.8rem' }}>所選象限目前沒有族群</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
