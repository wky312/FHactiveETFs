import { BUILTIN_GROUPS, SectorGroup } from './sectorGroups';
import { BUILTIN_GROUPS_OVERSEAS } from './sectorGroupsOverseas';

/* 自訂族群的儲存層 —— 目前實作為 localStorage。
   ──────────────────────────────────────────────────────────────────
   站上沒有登入機制，Supabase 用的是瀏覽器可見的 anon key；沒有使用者身分就沒有 per-user 隔離，
   把自訂族群寫進 DB 只會得到一張所有訪客共用、任何人可改的表。真正的需求是「使用者身分」而非「資料庫」。
   故本階段：內建族群走 git 版控、自訂族群走 localStorage、分享靠網址參數。

   ★ 這一層就是日後接 Supabase Auth 的接縫：把下面幾個函式換成打 API 即可，UI 不必動。
     屆時介面要改成非同步，呼叫端已全部集中在 components/SectorExposureTab.tsx。

   國內/海外兩個代碼空間完全不相容（台股用剝除後綴的 4 位數字代碼；海外用原樣 Yahoo 代號，
   .TW/.KS/.DE 等後綴是有意義的資訊不是雜訊），故用同一個 factory 各開一個獨立 store，
   分開存 localStorage key、各自套用對應的正規化+驗證規則。 */

function canStore(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

function makeGroupStore(
  key: string,
  builtin: SectorGroup[],
  normalizeCode: (raw: string) => string,
  isValidCode: (code: string) => boolean,
) {
  function normalizeCodes(codes: string[]): string[] {
    return [...new Set(codes.map(normalizeCode).filter(isValidCode))];
  }

  function read(): SectorGroup[] {
    if (!canStore()) return [];
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return [];
      return sanitize(JSON.parse(raw));
    } catch {
      return [];   // 損毀的內容視同沒有，不讓它擋住整個分頁
    }
  }

  function write(groups: SectorGroup[]): void {
    if (!canStore()) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(groups.map(g => ({ name: g.name, codes: g.codes }))));
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

  function listBuiltin(): SectorGroup[] {
    return builtin;
  }

  function listCustom(): SectorGroup[] {
    return read();
  }

  /** 內建 + 自訂；同名時自訂覆蓋內建（使用者可複製內建族群改成自己的定義）。 */
  function listAll(): SectorGroup[] {
    const custom = read();
    const customNames = new Set(custom.map(g => g.name));
    return [...custom, ...builtin.filter(g => !customNames.has(g.name))];
  }

  function saveGroup(group: SectorGroup): void {
    const name = group.name.trim();
    const codes = normalizeCodes(group.codes);
    if (!name || !codes.length) return;
    const groups = read().filter(g => g.name !== name);
    groups.push({ name, codes });
    write(groups);
  }

  function deleteGroup(name: string): void {
    write(read().filter(g => g.name !== name));
  }

  function exportJson(): string {
    return JSON.stringify(read(), null, 2);
  }

  function importJson(raw: string): { ok: boolean; added: number; error?: string } {
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

  return { normalizeCode, listBuiltin, listCustom, listAll, saveGroup, deleteGroup, exportJson, importJson };
}

/** 台股代碼正規化：剝除 .TW/.TWO/.TE 之類的後綴，只留代碼本身。 */
function normalizeCodeTw(raw: string): string {
  return raw.trim().replace(/\.[A-Za-z]+$/, '').toUpperCase();
}
const isValidTwCode = (c: string): boolean => /^\d{4}[A-Z]?$/.test(c);

/** 海外代碼正規化：原樣大寫，不剝後綴（.TW/.KS/.DE 等是有意義的交易所資訊）。 */
function normalizeCodeOverseas(raw: string): string {
  return raw.trim().toUpperCase();
}
const isValidOverseasCode = (c: string): boolean => /^[A-Z0-9]{1,8}(\.[A-Z]{1,3})?$/.test(c);

const twStore = makeGroupStore('fh.sectorGroups.v1', BUILTIN_GROUPS, normalizeCodeTw, isValidTwCode);
const overseasStore = makeGroupStore(
  'fh.sectorGroups.overseas.v1', BUILTIN_GROUPS_OVERSEAS, normalizeCodeOverseas, isValidOverseasCode,
);

// 既有具名 export：完全比照重構前行為（同 key、同正規化規則、同驗證正則），確保台股模式零回歸。
export const normalizeCode = twStore.normalizeCode;
export const listBuiltin   = twStore.listBuiltin;
export const listCustom    = twStore.listCustom;
export const listAll       = twStore.listAll;
export const saveGroup     = twStore.saveGroup;
export const deleteGroup   = twStore.deleteGroup;
export const exportJson    = twStore.exportJson;
export const importJson    = twStore.importJson;

// 海外版新 export，供 SectorExposureTab 在 market==='overseas' 時切換使用。
export { normalizeCodeOverseas };
export const listBuiltinOverseas = overseasStore.listBuiltin;
export const listCustomOverseas  = overseasStore.listCustom;
export const listAllOverseas     = overseasStore.listAll;
export const saveGroupOverseas   = overseasStore.saveGroup;
export const deleteGroupOverseas = overseasStore.deleteGroup;
export const exportJsonOverseas  = overseasStore.exportJson;
export const importJsonOverseas  = overseasStore.importJson;
