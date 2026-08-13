-- 通用頁面快取表：跨 serverless instance / cold start 持久化重運算成本較高的頁面資料
-- （例如「前300大YTD還原權息追蹤」300檔逐一查Yahoo，單次約20-30秒）。
-- key 通常帶日期字串（如 top300-ytd:2026-08-13），當天第一次算完寫入，
-- 同一天後續請求（不管落在哪個 serverless instance）直接讀這裡，不用重算。
-- 在本專案自己的 Supabase（SUPABASE_URL / SUPABASE_SERVICE_KEY，非 twActiveETFs 共用那個）SQL Editor 執行一次即可。

create table if not exists public.page_cache (
  cache_key  text primary key,
  payload    jsonb not null,
  updated_at timestamptz not null default now()
);
