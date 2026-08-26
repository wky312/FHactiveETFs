import { createClient } from '@supabase/supabase-js';

/* 通用頁面快取（本專案自己的 Supabase，SUPABASE_URL/SUPABASE_SERVICE_KEY，非 twActiveETFs 共用那個）。
   原本只有 lib/top300Ytd.ts 在用，這裡抽成共用模組給 sectorHeatmap/sectorRRG 一起用，避免三份重複的
   ownSupabase()/read/write。表結構見 scripts/sql/2026-08-13_create_page_cache.sql（cache_key/payload/updated_at）。
   本機沒設這兩個 env（只有 Vercel production 有），本機呼叫會靜默跳過、不影響主流程。 */

function ownSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// 台北時區的今天日期字串 YYYY-MM-DD，當作「一天算一次」類快取的 key 組成部分
export function taipeiDateStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }); // en-CA -> YYYY-MM-DD
}

export async function readPageCache<T>(cacheKey: string): Promise<T | null> {
  const db = ownSupabase();
  if (!db) return null;
  try {
    const { data, error } = await db.from('page_cache').select('payload').eq('cache_key', cacheKey).maybeSingle();
    if (error) { console.error(`[pageCache] read failed (${cacheKey}):`, error.message); return null; }
    return (data?.payload as T) ?? null;
  } catch (err) {
    console.error(`[pageCache] read threw (${cacheKey}):`, err); // 表還沒建、或連線失敗都當快取沒命中，照樣重算
    return null;
  }
}

export async function writePageCache<T>(cacheKey: string, payload: T): Promise<void> {
  const db = ownSupabase();
  if (!db) { console.warn(`[pageCache] SUPABASE_URL/SUPABASE_SERVICE_KEY 未設定，跳過持久化快取寫入 (${cacheKey})`); return; }
  try {
    const { error } = await db.from('page_cache').upsert({ cache_key: cacheKey, payload, updated_at: new Date().toISOString() });
    if (error) console.error(`[pageCache] write failed (${cacheKey}):`, error.message);
  } catch (err) {
    console.error(`[pageCache] write threw (${cacheKey}):`, err); // 寫入失敗不影響本次回應，下次請求會再試一次
  }
}
