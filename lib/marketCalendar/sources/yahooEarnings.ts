import type { EarningsSpec } from '../config';
import { ymdInTz } from '../time';
import { yf } from './yahoo';

export interface EarningsInfo {
  spec: EarningsSpec;
  next: { date: string; estimate: boolean; eps: number | null; revenue: number | null } | null;
  lastCallDate: string | null; // 上一次法說日（讓歷史樣本自動累積，不必每季手動補）
}

export async function fetchEarnings(spec: EarningsSpec): Promise<EarningsInfo> {
  const q = await yf.quoteSummary(spec.symbol, { modules: ['calendarEvents'] });
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
    lastCallDate: ld ? ymdInTz(new Date(ld).getTime(), spec.tz) : null,
  };
}
