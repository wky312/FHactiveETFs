-- 同業申贖觀測：peer_redemption 加 group 欄位，支援多群組（台股主動式 / 海外主動式）
-- 在 Supabase SQL Editor 執行一次即可。"group" 是保留字，務必加雙引號。

-- 1. 新增 group 欄位，現有列全部視為台股主動式
alter table public.peer_redemption
  add column if not exists "group" text not null default 'tw_active';

-- 2. 讀取常用 (group, date) 複合查詢加索引
create index if not exists peer_redemption_group_date_idx
  on public.peer_redemption ("group", date);

-- 說明：
--   ticker 與 group 為一對一（一檔 ETF 只屬於一個群組），故 (date, ticker) 仍可當唯一鍵，
--   upsert 的 on_conflict='date,ticker' 不需更動。group 只是附帶屬性。
--   海外群組（group='overseas'）目前尚無任何列：6 檔的投信申贖來源待 step 3 逐家接通後才會寫入。
--   （含復華 00998A——其 fhtrust PCF/ETF24 目前未提供 actBuyValDate，需另查申贖來源。）
