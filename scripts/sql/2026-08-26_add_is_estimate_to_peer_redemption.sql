-- 同業申贖觀測（海外）：申購買回清單裡的「預估發行受益權單位數」可以在正式公告前先估出
-- 淨申贖，peer_redemption 加 is_estimate 欄位標記這種列。之後排程抓到正式值時，
-- upsert(on_conflict=date,ticker) 會直接覆蓋掉估計列、把 is_estimate 改回 false。
-- 在 Supabase SQL Editor 執行一次即可。

alter table public.peer_redemption
  add column if not exists is_estimate boolean not null default false;
