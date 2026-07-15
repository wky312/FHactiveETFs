-- 單位數注意商品：每日單位數存檔，供「成立以來平均單位數 / 發行時單位數」門檻監測用。
-- 在本專案自己的 Supabase（SUPABASE_URL / SUPABASE_SERVICE_KEY，非 twActiveETFs 共用那個）SQL Editor 執行一次即可。

create table if not exists public.unit_watch (
  date   date not null,
  ticker text not null,
  units  numeric not null,
  primary key (date, ticker)
);

create index if not exists unit_watch_ticker_date_idx
  on public.unit_watch (ticker, date);
