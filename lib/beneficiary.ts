/* 受益人數（TDCC 集保股權分散表）：型別、標的清單與純計算。
 *
 * level 對照與 scripts/beneficiary_fetch.py 一致：
 *   1..15 = 持股/單位數分級、16 = 差異數調整、17 = 合計。
 * ⚠️ 合計一律看 level === 17，不可用「最後一列」——有無差異數調整列會讓它在表中第 16/17 列跳動。
 */

export const LEVEL_TOTAL = 17;
export const LEVEL_ADJUSTMENT = 16;

export const LEVEL_LABELS: string[] = [
  '1-999', '1,000-5,000', '5,001-10,000', '10,001-15,000', '15,001-20,000',
  '20,001-30,000', '30,001-40,000', '40,001-50,000', '50,001-100,000',
  '100,001-200,000', '200,001-400,000', '400,001-600,000', '600,001-800,000',
  '800,001-1,000,000', '1,000,001以上',
];

export interface LevelGroup { key: string; label: string; note: string; levels: number[]; color: string }

/* 15 個級距畫堆疊圖太細，聚合成 5 組。1 張 = 1,000 受益權單位。 */
export const LEVEL_GROUPS: LevelGroup[] = [
  { key: 'retail', label: '散戶',         note: '5 張以下',    levels: [1, 2],                 color: '#E8B4B8' },
  { key: 'small',  label: '小額',         note: '5–20 張',     levels: [3, 4, 5],              color: '#D98880' },
  { key: 'medium', label: '中實戶',       note: '20–100 張',   levels: [6, 7, 8, 9],           color: '#B85C5C' },
  { key: 'large',  label: '大戶',         note: '100–1000 張', levels: [10, 11, 12, 13, 14],   color: '#8B3A3A' },
  { key: 'whale',  label: '超大戶／法人', note: '1000 張以上', levels: [15],                   color: '#5C1F1F' },
];

export interface BeneficiaryTicker { ticker: string; name: string; group: 'tw' | 'overseas' }

/* 台股 21 檔來源＝共用 Supabase `etf` 表扣掉 0050；海外 10 檔＝lib/peerGroups.ts overseas 非 benchmark。 */
export const BENEFICIARY_TICKERS: BeneficiaryTicker[] = [
  { ticker: '00991A', name: '主動復華未來50',   group: 'tw' },
  { ticker: '00980A', name: '主動野村臺灣優選', group: 'tw' },
  { ticker: '00981A', name: '主動統一台股增長', group: 'tw' },
  { ticker: '00982A', name: '主動群益台灣強棒', group: 'tw' },
  { ticker: '00984A', name: '主動安聯台灣高息', group: 'tw' },
  { ticker: '00985A', name: '主動野村台灣50',   group: 'tw' },
  { ticker: '00987A', name: '主動台新優勢成長', group: 'tw' },
  { ticker: '00992A', name: '主動群益科技創新', group: 'tw' },
  { ticker: '00993A', name: '主動安聯台灣',     group: 'tw' },
  { ticker: '00994A', name: '主動第一金台股',   group: 'tw' },
  { ticker: '00995A', name: '主動中信台灣卓越', group: 'tw' },
  { ticker: '00996A', name: '主動兆豐台灣豐收', group: 'tw' },
  { ticker: '00999A', name: '主動野村臺灣高息', group: 'tw' },
  { ticker: '00400A', name: '主動國泰動能高息', group: 'tw' },
  { ticker: '00401A', name: '主動摩根台灣鑫收', group: 'tw' },
  { ticker: '00403A', name: '主動統一升級50',   group: 'tw' },
  { ticker: '00404A', name: '主動聯博動能50',   group: 'tw' },
  { ticker: '00405A', name: '主動富邦台灣龍耀', group: 'tw' },
  { ticker: '00406A', name: '主動中信台灣收益', group: 'tw' },
  { ticker: '00407A', name: '主動凱基台灣',     group: 'tw' },
  { ticker: '00408A', name: '主動第一金優股息', group: 'tw' },
  { ticker: '00983A', name: '主動中信ARK創新',   group: 'overseas' },
  { ticker: '00986A', name: '主動台新全球龍頭', group: 'overseas' },
  { ticker: '00988A', name: '主動統一全球創新', group: 'overseas' },
  { ticker: '00989A', name: '主動摩根美國科技', group: 'overseas' },
  { ticker: '00990A', name: '主動元大AI新經濟', group: 'overseas' },
  { ticker: '00997A', name: '主動群益美國增長', group: 'overseas' },
  { ticker: '00998A', name: '主動復華全球金融', group: 'overseas' },
  { ticker: '00402A', name: '主動安聯美國科技', group: 'overseas' },
  { ticker: '00409A', name: '主動復華全球50',   group: 'overseas' },
  { ticker: '00411A', name: '主動統一前沿科技', group: 'overseas' },
];

export interface RawRow { date: string; level: number; people: number; units: number; pct: number }
export interface LevelCell { level: number; label: string; people: number; units: number; pct: number }
export interface Week { date: string; people: number; units: number; levels: LevelCell[] }

/** 扁平的 DB 列 → 依週次分組，並把合計拉成 week 層級欄位。缺合計列的週次直接丟掉。 */
export function buildWeeks(rows: RawRow[]): Week[] {
  const byDate = new Map<string, RawRow[]>();
  for (const r of rows) {
    const d = r.date.slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(r);
  }
  const weeks: Week[] = [];
  for (const [date, list] of byDate) {
    const total = list.find(r => r.level === LEVEL_TOTAL);
    if (!total) continue;
    const levels = list
      .filter(r => r.level >= 1 && r.level <= 15)
      .sort((a, b) => a.level - b.level)
      .map(r => ({ level: r.level, label: LEVEL_LABELS[r.level - 1], people: r.people, units: r.units, pct: r.pct }));
    weeks.push({ date, people: total.people, units: total.units, levels });
  }
  return weeks.sort((a, b) => a.date.localeCompare(b.date));
}

export interface TrendPoint { date: string; people: number; units: number; avgLots: number; peopleChange: number | null }

/** 趨勢圖用：受益人數、受益權單位數、平均每人持有張數（1 張 = 1,000 單位）。 */
export function trendPoints(weeks: Week[]): TrendPoint[] {
  return weeks.map((w, i) => ({
    date: w.date,
    people: w.people,
    units: w.units,
    avgLots: w.people > 0 ? w.units / w.people / 1000 : 0,
    peopleChange: i === 0 ? null : w.people - weeks[i - 1].people,
  }));
}

export interface GroupShare { key: string; label: string; people: number; units: number; unitShare: number; peopleShare: number }

/** 把 15 級距聚合成 LEVEL_GROUPS 五組，附單位數/人數佔比。 */
export function groupShares(week: Week): GroupShare[] {
  const totalUnits = week.levels.reduce((s, l) => s + l.units, 0);
  const totalPeople = week.levels.reduce((s, l) => s + l.people, 0);
  return LEVEL_GROUPS.map(g => {
    const cells = week.levels.filter(l => g.levels.includes(l.level));
    const units = cells.reduce((s, l) => s + l.units, 0);
    const people = cells.reduce((s, l) => s + l.people, 0);
    return {
      key: g.key, label: g.label, people, units,
      unitShare: totalUnits > 0 ? units / totalUnits : 0,
      peopleShare: totalPeople > 0 ? people / totalPeople : 0,
    };
  });
}

export interface LevelDiff extends LevelCell {
  basePeople: number | null; baseUnits: number | null; basePct: number | null;
  peopleDelta: number | null; unitsDelta: number | null; pctDelta: number | null;
  /* 該級距每人平均持有幾個受益權單位。看「這一級的人是在加碼還是減碼」——
   * 人數與單位數同向增減時單看總量分不出來，除下去才看得到個體行為。
   * ⚠️ 級距是固定區間，人會跨級移動，所以這是「當期落在此級的人」的平均，不是同一批人的追蹤。 */
  avgUnits: number;
  baseAvgUnits: number | null;
  avgUnitsDelta: number | null;
}

/** people 為 0 的級距（極少見，但差異數調整後可能出現）除法要擋掉。 */
export function avgUnitsOf(units: number, people: number): number {
  return people > 0 ? units / people : 0;
}

/** 級距明細表：本期 vs 對照期。沒有對照期時 delta 全為 null（顯示「—」而不是 0）。 */
export function diffLevels(current: Week, base: Week | null): LevelDiff[] {
  return current.levels.map(l => {
    const b = base?.levels.find(x => x.level === l.level) ?? null;
    const avg = avgUnitsOf(l.units, l.people);
    const baseAvg = b ? avgUnitsOf(b.units, b.people) : null;
    return {
      ...l,
      basePeople: b?.people ?? null,
      baseUnits: b?.units ?? null,
      basePct: b?.pct ?? null,
      peopleDelta: b ? l.people - b.people : null,
      unitsDelta: b ? l.units - b.units : null,
      pctDelta: b ? l.pct - b.pct : null,
      avgUnits: avg,
      baseAvgUnits: baseAvg,
      avgUnitsDelta: baseAvg === null ? null : avg - baseAvg,
    };
  });
}

/* ── 兩檔對照 ─────────────────────────────────────────────────────────────── */

export interface GroupStat {
  key: string; label: string; note: string;
  people: number; basePeople: number; peopleDelta: number; peoplePctChange: number;
  units: number; baseUnits: number; unitsDelta: number;
  /* 該組每人平均持有單位。人數與單位數同向變動時，總量分不出是「人變多」還是
   * 「每人買更多」——除下去才看得到組內個體是加碼還是減碼。 */
  avgUnits: number; baseAvgUnits: number; avgUnitsDelta: number;
}

export interface LevelStat {
  level: number; label: string;
  people: number; basePeople: number; peopleDelta: number; peoplePctChange: number;
  pct: number; basePct: number; pctDelta: number;
}

export interface FundStats {
  ticker: string; name: string;
  people: number; basePeople: number; peopleDelta: number; peoplePctChange: number;
  units: number; baseUnits: number; unitsDelta: number; unitsPctChange: number;
  avgUnits: number; baseAvgUnits: number; avgUnitsDelta: number;
  /** 散戶（5 張以下）佔總人數比重——分辨「全民型」與「單筆較大」的客群結構。 */
  retailPeopleShare: number;
  groups: GroupStat[];
  levels: LevelStat[];
}

const pctChange = (cur: number, base: number) => (base > 0 ? (cur / base - 1) * 100 : 0);

/** 單檔在「本期 vs 對照期」的完整統計。兩檔各算一份並排，就是對照檢視。 */
export function fundStats(ticker: string, name: string, current: Week, base: Week): FundStats {
  const sum = (w: Week, levels: number[], field: 'people' | 'units') =>
    w.levels.filter(l => levels.includes(l.level)).reduce((s, l) => s + l[field], 0);

  const groups: GroupStat[] = LEVEL_GROUPS.map(g => {
    const people = sum(current, g.levels, 'people');
    const basePeople = sum(base, g.levels, 'people');
    const units = sum(current, g.levels, 'units');
    const baseUnits = sum(base, g.levels, 'units');
    const avgUnits = avgUnitsOf(units, people);
    const baseAvgUnits = avgUnitsOf(baseUnits, basePeople);
    return {
      key: g.key, label: g.label, note: g.note,
      people, basePeople, peopleDelta: people - basePeople, peoplePctChange: pctChange(people, basePeople),
      units, baseUnits, unitsDelta: units - baseUnits,
      avgUnits, baseAvgUnits, avgUnitsDelta: avgUnits - baseAvgUnits,
    };
  });

  const levels: LevelStat[] = current.levels.map(l => {
    const b = base.levels.find(x => x.level === l.level);
    const basePeople = b?.people ?? 0;
    return {
      level: l.level, label: l.label,
      people: l.people, basePeople, peopleDelta: l.people - basePeople,
      peoplePctChange: pctChange(l.people, basePeople),
      pct: l.pct, basePct: b?.pct ?? 0, pctDelta: l.pct - (b?.pct ?? 0),
    };
  });

  const retail = groups.find(g => g.key === 'retail');
  return {
    ticker, name,
    people: current.people, basePeople: base.people,
    peopleDelta: current.people - base.people, peoplePctChange: pctChange(current.people, base.people),
    units: current.units, baseUnits: base.units,
    unitsDelta: current.units - base.units, unitsPctChange: pctChange(current.units, base.units),
    avgUnits: avgUnitsOf(current.units, current.people),
    baseAvgUnits: avgUnitsOf(base.units, base.people),
    avgUnitsDelta: avgUnitsOf(current.units, current.people) - avgUnitsOf(base.units, base.people),
    retailPeopleShare: current.people > 0 ? (retail?.people ?? 0) / current.people : 0,
    groups, levels,
  };
}

/** 兩檔可共同比較的週次（各自掛牌時間不同，交集才畫得出對照）。新到舊。 */
export function commonWeeks(a: Week[], b: Week[]): string[] {
  const setB = new Set(b.map(w => w.date));
  return a.filter(w => setB.has(w.date)).map(w => w.date).sort().reverse();
}
