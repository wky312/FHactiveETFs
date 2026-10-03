import { NextRequest } from 'next/server';

/* 管理用動作的共用驗證（沿用 app/api/cron/trigger 既有的 Bearer 模式）。

   為什麼需要：收盤影響的 ?refresh=1 會跳過兩層快取、重算 22 檔基金的持股＋聯集個股報價，
   單次可燒掉 maxDuration=300 秒，並對 13 家投信官網與 Yahoo 各打一輪完整請求。站台是公開的，
   不設閘門等於把「每次請求都能強制全量重算」送給任何人——除了 function 時間成本，更實際的
   風險是**把 Vercel 的出口 IP 送去被投信站封鎖**（兆豐 megafunds.com.tw 已經在封資料中心 IP，
   見 scripts/daily_summary.py::fetch_mega_day）。

   fail-closed：環境變數沒設就一律視為未授權，不要因為「忘了設」而變成無閘門。 */
export function isAdminRequest(request: NextRequest): boolean {
  const secret = process.env.CRON_TRIGGER_SECRET ?? '';
  if (!secret) return false;
  return (request.headers.get('authorization') ?? '') === `Bearer ${secret}`;
}
