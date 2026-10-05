import type { EarningsSpec } from '../config';
import { ymdInTz } from '../time';
import { yf } from './yahoo';

export interface EarningsInfo {
  spec: EarningsSpec;
  next: { date: string; estimate: boolean; eps: number | null; revenue: number | null } | null;
  lastCallDate: string | null; // 上一次法說日（讓歷史樣本自動累積，不必每季手動補）
  history: { quarterEnd: string; actual: number; estimate: number | null }[]; // 近 4 季 EPS 實際/預期
}

export async function fetchEarnings(spec: EarningsSpec): Promise<EarningsInfo> {
  const q = await yf.quoteSummary(spec.symbol, { modules: ['calendarEvents', 'earningsHistory'] },
    // 新上市股（SpaceX/SPCX）的 earningsHistory 欄位不齊，嚴格 schema 驗證會整個丟錯；本檔只讀少數欄位，關掉驗證
    { validateResult: false });
  const e = q?.calendarEvents?.earnings;
  const nd: Date | undefined = e?.earningsDate?.[0];
  const ld: Date | undefined = e?.earningsCallDate?.[0];
  return {
    spec,
    next: nd ? {
      date: ymdInTz(new Date(nd).getTime(), spec.tz),
      estimate: !!e.isEarningsDateEstimate,
      eps: typeof e.earningsAverage === 'number' ? e.earningsAverage : null,
      revenue: typeof e.revenueAverage === 'number' ? e.revenueAverage : null,
    } : null,
    history: (q?.earningsHistory?.history ?? [])
      .filter((h: { quarter?: Date; epsActual?: number }) => h.quarter && typeof h.epsActual === 'number')
      .map((h: { quarter: Date; epsActual: number; epsEstimate?: number }) => ({
        quarterEnd: new Date(h.quarter).toISOString().slice(0, 10),
        actual: h.epsActual,
        estimate: typeof h.epsEstimate === 'number' ? h.epsEstimate : null,
      })),
    // Yahoo 的 call 時間戳以美東為準（TSM 的 20:00Z 換成台北會跨日多一天），不可用 spec.tz 換算
    lastCallDate: ld ? ymdInTz(new Date(ld).getTime(), 'America/New_York') : null,
  };
}
