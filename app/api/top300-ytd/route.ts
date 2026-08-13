import { NextResponse } from 'next/server';
import { computeTop300Ytd } from '@/lib/top300Ytd';

// 2025/12/31市值前300大，追蹤至今的還原權息報酬 + 市值排名變化。
// 300檔逐一查Yahoo還原權息序列，成本較高，30分鐘快取。
export const maxDuration = 280;

export async function GET() {
  try {
    const data = await computeTop300Ytd();
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
