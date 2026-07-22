/**
 * 外資目標價共識——查詢共用 Supabase（active-etf-tracker，與 lib/attribution.ts 同一專案）
 * 中屬於 fini-stock-dashboard 兄弟專案的 `fini_reports` 表（外資報告，含目標價），
 * 算出某檔個股的外資均價目標價，供軌跡圖疊圖用。
 *
 * 大部分股票不會有 fini 覆蓋（該專案目前僅少數 ticker 有真實資料），此為錦上添花的疊圖，
 * 任何缺環境變數／查無資料／查詢錯誤都必須靜默回傳 null，絕不可讓上層的軌跡查詢失敗。
 */
import { createClient } from '@supabase/supabase-js';

export interface FiniConsensus {
  reportCount: number;
  avgTargetPrice: number;
  avgUpsidePct: number | null;
  brokers: string[];
}

type FiniReportRow = { broker: string; target_price: number | string | null };

export async function getFiniConsensus(
  stockid: string,
  currentPrice: number | null,
): Promise<FiniConsensus | null> {
  try {
    const url = process.env.ATTR_SUPABASE_URL;
    const key = process.env.ATTR_SUPABASE_ANON_KEY;
    if (!url || !key || !stockid) return null;

    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await db
      .from('fini_reports')
      .select('broker,target_price')
      .eq('ticker', stockid);

    if (error || !data || data.length === 0) return null;

    const rows = (data as FiniReportRow[]).filter(r => r.target_price != null && Number.isFinite(Number(r.target_price)));
    if (rows.length === 0) return null;

    const sum = rows.reduce((s, r) => s + Number(r.target_price), 0);
    const avgTargetPrice = sum / rows.length;
    const avgUpsidePct = currentPrice ? (avgTargetPrice / currentPrice - 1) * 100 : null;

    return {
      reportCount: rows.length,
      avgTargetPrice,
      avgUpsidePct,
      brokers: rows.map(r => r.broker),
    };
  } catch {
    return null; // 失敗軟著陸——絕不讓外資共識查詢拖垮軌跡主功能
  }
}
