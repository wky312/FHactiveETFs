import { BUILTIN_GROUPS, SectorGroup } from './sectorGroups';

/* 自訂族群的儲存層 —— 目前實作為 localStorage。
   ──────────────────────────────────────────────────────────────────
   站上沒有登入機制，Supabase 用的是瀏覽器可見的 anon key；沒有使用者身分就沒有 per-user 隔離，
   把自訂族群寫進 DB 只會得到一張所有訪客共用、任何人可改的表。真正的需求是「使用者身分」而非「資料庫」。
   故本階段：內建族群走 git 版控、自訂族群走 localStorage、分享靠網址參數。

   ★ 這一層就是日後接 Supabase Auth 的接縫：把下面幾個函式換成打 API 即可，UI 不必動。
     屆時介面要改成非同步，呼叫端已全部集中在 components/SectorExposureTab.tsx。 */

const KEY = 'fh.sectorGroups.v1';

function canStore(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

/** 代碼正規化：剝除 .TW/.TWO/.TE 之類的後綴，只留代碼本身。 */
export function normalizeCode(raw: string): string {
  return raw.trim().replace(/\.[A-Za-z]+$/, '').toUpperCase();
}

function normalizeCodes(codes: string[]): string[] {
  return [...new Set(codes.map(normalizeCode).filter(c => /^\d{4}[A-Z]?$/.test(c)))];
}

function read(): SectorGroup[] {
  if (!canStore()) return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return sanitize(parsed);
  } catch {
    return [];   // 損毀的內容視同沒有，不讓它擋住整個分頁
  }
}

function write(groups: SectorGroup[]): void {
  if (!canStore()) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(groups.map(g => ({ name: g.name, codes: g.codes }))));
  } catch {
    // 隱私模式或配額用盡：靜默失敗，UI 仍可正常瀏覽
  }
}

function sanitize(parsed: unknown): SectorGroup[] {
  if (!Array.isArray(parsed)) return [];
  const out: SectorGroup[] = [];
  for (const g of parsed) {
    if (!g || typeof g !== 'object') continue;
    const name = String((g as SectorGroup).name ?? '').trim();
    const rawCodes = (g as SectorGroup).codes;
    if (!name || !Array.isArray(rawCodes)) continue;
    const codes = normalizeCodes(rawCodes.map(String));
    if (codes.length) out.push({ name, codes });
  }
  return out;
}

export function listBuiltin(): SectorGroup[] {
  return BUILTIN_GROUPS;
}

export function listCustom(): SectorGroup[] {
  return read();
}

/** 內建 + 自訂；同名時自訂覆蓋內建（使用者可複製內建族群改成自己的定義）。 */
export function listAll(): SectorGroup[] {
  const custom = read();
  const customNames = new Set(custom.map(g => g.name));
  return [...custom, ...BUILTIN_GROUPS.filter(g => !customNames.has(g.name))];
}

export function saveGroup(group: SectorGroup): void {
  const name = group.name.trim();
  const codes = normalizeCodes(group.codes);
  if (!name || !codes.length) return;
  const groups = read().filter(g => g.name !== name);
  groups.push({ name, codes });
  write(groups);
}

export function deleteGroup(name: string): void {
  write(read().filter(g => g.name !== name));
}

export function exportJson(): string {
  return JSON.stringify(read(), null, 2);
}

export function importJson(raw: string): { ok: boolean; added: number; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, added: 0, error: 'JSON 格式錯誤' };
  }
  const incoming = sanitize(parsed);
  if (!incoming.length) return { ok: false, added: 0, error: '找不到有效的族群（需為 [{ name, codes }] 陣列）' };
  const existing = read();
  const merged = [...existing.filter(g => !incoming.some(i => i.name === g.name)), ...incoming];
  write(merged);
  return { ok: true, added: incoming.length };
}
