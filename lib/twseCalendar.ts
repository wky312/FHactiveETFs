/* TWSE 交易日驗證 —— 用來擋掉 MIS 的「假日模擬盤」。

   為什麼需要：`mis.twse.com.tw` 在**週末會送出帶當天日期的模擬／備援演練資料**，
   欄位長得跟真的一模一樣（self-reported 交易日 d、成交價 z、昨收 y、時間戳 tlong 就是當下時刻），
   價格還會跳動。2026-10-04（週日）實測：
     t00（加權）z=50,931.77、y=48,475.74 → 若採信就是單日 +5.07%
     00999A     z=12.54、y=11.40        → 漲停
   同一時間 Yahoo 全部回 marketState=CLOSED、最後成交停在 10/02 13:30，
   TWSE 盤後 FMTQIK 的 10 月也只有 10/01、10/02。

   後果（都實際發生過）：
   - 指數列直接拿模擬值當收盤 → 同業績效分頁的 ^TWII 顯示 +5.09%、^TWOII 顯示 435.16。
   - 個股列因為「MIS 日期比 Yahoo 新」被誤標 anomaly（「Yahoo 缺最新報價，TWSE 已有 2026-10-04」），
     實際上根本沒有 10/04 這個交易日。

   判斷規則（寬嚴拿捏）：
   - 該日期出現在 FMTQIK（盤後統計，只列真正開市過的日子）→ 接受。
   - 否則若「就是今天」且今天是平日 → 接受。盤中的當日不會在 FMTQIK 裡，不能因此擋掉即時報價。
   - 其餘（週末、國定假日、未來日）→ 拒絕。
   ⚠️ 代價：真的補行交易（例如補班補交易的週六）在**盤中**會被擋，收盤後 FMTQIK 列出就恢復。
      寧可少一天即時資料，也不要把模擬盤當成真行情publish 出去。
   - FMTQIK 連不到時回 null，此時只用「今天且平日」這條，不因為查不到就全擋。 */

const _cal = new Map<string, { ts: number; days: Set<string> | null }>();
const TTL_MS = 6 * 60 * 60 * 1000;

function taipeiToday(): { iso: string; weekday: number } {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return { iso: t.toISOString().slice(0, 10), weekday: t.getUTCDay() };
}

async function monthTradingDays(iso: string): Promise<Set<string> | null> {
  const key = iso.slice(0, 7).replace('-', '');          // 'YYYYMM'
  const hit = _cal.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.days;
  try {
    const res = await fetch(
      `https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${key}01&response=json`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, next: { revalidate: 3600 } },
    );
    const j = await res.json();
    if (j?.stat !== 'OK') { _cal.set(key, { ts: Date.now(), days: null }); return null; }
    const days = new Set<string>();
    for (const row of (j.data ?? []) as string[][]) {
      const m = String(row?.[0] ?? '').split('/');        // 民國 'YYY/MM/DD'
      if (m.length === 3) days.add(`${Number(m[0]) + 1911}-${m[1]}-${m[2]}`);
    }
    _cal.set(key, { ts: Date.now(), days });
    return days;
  } catch {
    _cal.set(key, { ts: Date.now(), days: null });
    return null;
  }
}

/** MIS 自報的交易日是否可信（見檔頭）。擋掉週末模擬盤，但不擋盤中的當日。 */
export async function isAcceptableMisDate(iso: string): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const days = await monthTradingDays(iso);
  if (days?.has(iso)) return true;
  const { iso: today, weekday } = taipeiToday();
  return iso === today && weekday >= 1 && weekday <= 5;
}
