-- 受益人數（集保股權分散表）：每週一列 × 每檔 × 每個持股分級。
-- 在本專案自己的 Supabase（SUPABASE_URL / SUPABASE_SERVICE_KEY，非 twActiveETFs 共用那個）
-- SQL Editor 執行一次即可。
--
-- level 對照：1..15 = 持股/單位數分級（1-999 ... 1,000,001以上）
--             16    = 差異數調整（只有單位數、沒有人數；某些週不出現）
--             17    = 合計 ← 受益人數就是這列的 people
-- ⚠️ level 不可用「表中第幾列」推算：有無差異數調整列會讓合計在 16/17 之間跳動。

create table if not exists public.beneficiary_counts (
  date   date     not null,
  ticker text     not null,
  level  smallint not null,
  people integer  not null,
  units  numeric  not null,
  pct    numeric,
  primary key (date, ticker, level)
);

create index if not exists beneficiary_counts_ticker_date_idx
  on public.beneficiary_counts (ticker, date);

-- 只取合計列的查詢（趨勢圖）會很頻繁，給它一條窄索引。
create index if not exists beneficiary_counts_total_idx
  on public.beneficiary_counts (ticker, date) where level = 17;
