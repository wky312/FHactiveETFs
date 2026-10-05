/**
 * 台股主動式ETF 逐日持股 —— 從共用 Supabase `holding` 表讀（與績效歸因同一個庫）。
 *
 * 取代「收盤影響」原本的 CMoney 即時抓取：CMoney 2026-10 起對所有基金回 Auth Failed，
 * 且沒有存檔的基金（00992A、00403A）會整檔查無持股。Supabase 由排程每日寫入、20 檔齊全。
 * 只取最近 3 個持股日（weightBasis='prev-session' 只需最新兩筆，多留一筆當保險）。
 */
import { createClient } from '@supabase/supabase-js';
import { Holding } from './types';

const KEEP_DATES = 3;

export async function fetchTwHoldingsFromDb(ticker: string): Promise<Map<string, Holding[]>> {
  const url = process.env.ATTR_SUPABASE_URL;
  const key = process.env.ATTR_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('未設定 ATTR_SUPABASE_URL / ATTR_SUPABASE_ANON_KEY 環境變數');
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // 先找最近 N 個持股日，再一次撈這些日期的持股（一檔最多約 50 列 × 3 日，不會超過 1000 列上限）
  const { data: dateRows, error: dErr } = await db
    .from('holding').select('date').eq('ticker', ticker)
    .order('date', { ascending: false }).limit(KEEP_DATES * 60);
  if (dErr) throw new Error(`讀取 ${ticker} 持股日失敗：${dErr.message}`);
  const dates = [...new Set((dateRows ?? []).map((r: { date: string }) => r.date))].slice(0, KEEP_DATES);
  if (!dates.length) return new Map();

  const { data, error } = await db
    .from('holding').select('date,stockid,stockname,qshare,prate')
    .eq('ticker', ticker).in('date', dates).limit(1000);
  if (error) throw new Error(`讀取 ${ticker} 持股失敗：${error.message}`);

  const byDate = new Map<string, Holding[]>();
  for (const r of (data ?? []) as { date: string; stockid: string; stockname: string; qshare: number | null; prate: number | string | null }[]) {
    const key = r.date.replace(/-/g, '/');           // 對齊 dayMap 的 YYYY/MM/DD
    const list = byDate.get(key) ?? [];
    list.push({
      stockid: String(r.stockid).trim(),
      stockname: r.stockname ?? '',
      qshare: Number(r.qshare) || 0,
      mvalue: 0,
      prate_addaccint: Number(r.prate) || 0,
      country: '',
      ftype: '',
    });
    byDate.set(key, list);
  }
  return byDate;
}
