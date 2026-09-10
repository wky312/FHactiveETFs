import { supabase, supabaseReady } from './supabase';

/* 台股企業行動（除權/除息/分割/減資）因子 —— 讀共用 Supabase 的 `corp_action` 表
   （由 twActiveETFs scripts/corp_actions.py 每晚自 TWSE 補，見該 repo migration 0014）。

   個股軌跡 / 選股對帳單走的是即時 API（fhtrust/CMoney 持股 + TWSE 成交均價 + Yahoo K 線），
   不經 price_adj / holding_adj matview，所以這裡自己抓因子、自己套：
   - TWSE 成交均價 avg 是「原始未還原」 → 乘 split_factor 累積乘積還原（對齊 Yahoo close 口徑）。
   - fhtrust/CMoney 回報的持股張數在除權日會跳增（配股後新股數）→ 除權前的張數乘 share_factor
     累積乘積，還原到「最新股數基準」，跨除權日的張數差分才不會被當成假加碼。
   Yahoo 的 close/mid 本來就已被 Yahoo 還原分割，不要再乘。 */

export interface CorpAction {
  stockid: string;
  ex_date: string;       // YYYY-MM-DD
  share_factor: number;  // 歷史股數 ×它 → 最新基準（純現金息 = 1）
  split_factor: number;  // 歷史股價 ×它 → 還原配股稀釋（= 1/share_factor；純現金息 = 1）
}

const TTL_MS = 60 * 60 * 1000;
const _cache = new Map<string, { ts: number; rows: CorpAction[] }>();

/** 某台股代碼的所有企業行動（依 ex_date 升冪）。海外股 / 查無 → []。 */
export async function fetchCorpActions(stockid: string): Promise<CorpAction[]> {
  const hit = _cache.get(stockid);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.rows;
  if (!supabaseReady || !supabase) return [];
  const { data } = await supabase
    .from('corp_action')
    .select('stockid,ex_date,share_factor,split_factor')
    .eq('stockid', stockid)
    .order('ex_date', { ascending: true });
  const rows: CorpAction[] = (data ?? []).map((r: Record<string, unknown>) => ({
    stockid: String(r.stockid),
    ex_date: String(r.ex_date).slice(0, 10),
    share_factor: Number(r.share_factor),
    split_factor: Number(r.split_factor),
  }));
  _cache.set(stockid, { ts: Date.now(), rows });
  return rows;
}

/** dateStr（YYYY/MM/DD 或 YYYY-MM-DD）「之後」所有除權日因子的累積乘積。
    date 當天(含)不含在內：ex_date 當天的報價/股數已是還原後基準。 */
export function cumFactor(
  actions: CorpAction[],
  dateStr: string,
  key: 'share_factor' | 'split_factor',
): number {
  if (!actions.length) return 1;
  const d = dateStr.replace(/\//g, '-').slice(0, 10);
  let f = 1;
  for (const a of actions) if (a.ex_date > d) f *= a[key];
  return f;
}

/** 把 {date, lots, ...} 序列的 lots（及 qshare 若有）依 share_factor 還原到最新股數基準。 */
export function adjustLotsSeries<T extends { date: string; lots: number; qshare?: number }>(
  series: T[],
  actions: CorpAction[],
): T[] {
  if (!actions.length) return series;
  return series.map((p) => {
    const f = cumFactor(actions, p.date, 'share_factor');
    return f === 1 ? p : { ...p, lots: p.lots * f, ...(p.qshare != null ? { qshare: Math.round(p.qshare * f) } : {}) };
  });
}
