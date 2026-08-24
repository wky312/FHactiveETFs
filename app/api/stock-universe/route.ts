import { NextResponse } from 'next/server';
import { fetchStockUniverse } from '@/lib/stockUniverse';

// 全台股代碼+名稱清單（個股軌跡搜尋框自動完成用）。lib 端已有 6 小時記憶體快取。
export const maxDuration = 30;

export async function GET() {
  try {
    const data = await fetchStockUniverse();
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
