import { createClient } from '@supabase/supabase-js';

// 讀取共用 Supabase（與 twActiveETFs 同一個資料庫，含全 19 檔主動式 ETF 每日持股 holding 與股價 price）。
// 伺服器端唯讀。明確用 NEXT_PUBLIC_SUPABASE_*（指向共用 DB）—— 不沿用本專案既有的 SUPABASE_SERVICE_KEY/
// SUPABASE_URL（可能指向別的 DB，URL/key 不匹配會 401）。anon 即可 select。供「全 19 檔總覽」用。
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabaseReady = !!(url && key);

export const supabase = supabaseReady
  ? createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;
