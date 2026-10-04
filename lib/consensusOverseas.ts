import { OVERSEAS_FUNDS } from './overseasFunds';
import { fetchHoldings } from './fhtrust';
import { fetchCmoneyHoldings } from './cmoneyHoldings';
import { fetchLatestEzmoney, fetchLatestYuanta, fetchLatestCapital, fetchLatestJpm } from './issuerHoldingsOverseas';
import { stockidToYfTicker } from './exchangeMap';
import { Holding } from './types';
import { ConsensusResult, ConsensusHolder, ConsensusStock, ConsensusFund } from './sectorExposure';

/* 海外族群曝險 —— 組出跟 lib/consensus.ts 的 computeConsensus() 同形狀的 ConsensusResult，
   讓 lib/sectorExposure.ts 的 buildSectorMatrix() 可以原封不動重用（該函式本來就是
   market-agnostic 的純函式，只要餵對形狀就行）。
   ──────────────────────────────────────────────────────────────────
   跟國內版最大的差異：國內版資料源是共用 Supabase（單一查詢即可拿到全部 20 檔），海外版
   目前程式裡「已知能抓到持股」的有 9 檔（見 lib/overseasFunds.ts），且分兩種抓法：
   - 復華自家（00998A/00409A）：lib/fhtrust.ts，需要明確日期、沒有「給我最新」的既有 helper，
     這裡自己往回找（今天起最多回溯 7 天，抓到就停；剛掛牌、尚未公布持股的基金如 00409A
     會 7 天都拿不到，視同這次沒資料——holdingDate: null，不是錯誤）。
   - 其他投信（00983A/00986A/00988A/00990A/00402A）：lib/cmoneyHoldings.ts，一次回傳整段
     逐日歷史（Map<日期, Holding[]>），取最大日期當最新即可。

   持股的 stockid 兩種來源都是彭博式格式（"NVDA US"、"2454 TT"，已用真實 API 呼叫驗證過），
   用既有的 stockidToYfTicker() 轉成 Yahoo 格式（"NVDA"、"2454.TW"）當 join key——這正好等於
   lib/sectorGroupsOverseas.ts 裡 CSV 代號欄的格式，兩邊不用再另外對照。

   navProxy（基金規模，供市值加權用）：v1 一律給 null。國內版能反推規模是因為 Supabase 有
   全市場 price 表可查收盤價；海外持股橫跨十幾個交易所，逐檔查價 + 6 家不同投信各自的規模
   爬蟲（lib/cmoneyScale.ts / lib/fhtrustScale.ts 等）要另外整合，工程量不成比例，故先不做
   （已與使用者確認）。SectorExposureTab 在 market==='overseas' 時會主動隱藏市值加權相關 UI，
   不會把 navProxy:null 誤顯示成「0%」。 */

const TTL_MS = 30 * 60 * 1000;   // 底層 fetch 本身已有 30~60 分鐘快取，這裡不用比它更短
let _cache: { ts: number; data: ConsensusResult } | null = null;

function fmt(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr.replace(/\//g, '-'));
  d.setDate(d.getDate() + n);
  return fmt(d);
}
// 今天（台灣時間 UTC+8）的 YYYY/MM/DD ——與 lib/stockTrajectory.ts 的 todayTW() 邏輯相同，
// 獨立複製一份而非 export 共用，避免兩個不相關分頁的內部 helper 互相耦合。
function todayTW(): string {
  const tw = new Date(Date.now() + 8 * 3600 * 1000);
  return `${tw.getUTCFullYear()}/${String(tw.getUTCMonth() + 1).padStart(2, '0')}/${String(tw.getUTCDate()).padStart(2, '0')}`;
}

const FHTRUST_LOOKBACK_DAYS = 7;

async function fetchLatestFhtrust(fundId: string): Promise<{ date: string; holdings: Holding[] } | null> {
  let d = todayTW();
  for (let i = 0; i < FHTRUST_LOOKBACK_DAYS; i++) {
    try {
      const res = await fetchHoldings(d, fundId);
      return { date: res.date, holdings: res.holdings };
    } catch {
      d = addDays(d, -1);
    }
  }
  return null;   // 回溯 7 天都沒公布（例：剛掛牌尚未開始交易的新基金），視同本次無資料
}

async function fetchLatestCmoney(fundId: string): Promise<{ date: string; holdings: Holding[] } | null> {
  const byDate = await fetchCmoneyHoldings(fundId, 10);  // 只需要最新一天，10 天緩衝避免連假拿不到
  const dates = [...byDate.keys()].sort();
  const latest = dates.at(-1);
  if (!latest) return null;
  return { date: latest, holdings: byDate.get(latest)! };
}

// 非個股列（現金/期貨/其他資產）過濾——fhtrust 有 ftype 欄位可以直接判斷，比 regex 準；
// 兩種來源都再疊一層 regex 當保險（比照 lib/consensus.ts 的 isCashLike，該函式未 export，
// 這裡複製一份邏輯，不改動 lib/consensus.ts）。
function isCashLike(stockid: string, stockname: string, ftype?: string): boolean {
  if (ftype === '期貨' || ftype === '其他資產' || ftype === '現金') return true;
  if (!stockid.trim()) return true;
  return /^(CASH|現金|TWD|NTD)$|現金|存款|期貨|AFTER DEDUCTING/i.test(stockname.trim());
}

export async function computeOverseasConsensus(): Promise<ConsensusResult> {
  if (_cache && Date.now() - _cache.ts < TTL_MS) return _cache.data;

  const perFund = await Promise.all(OVERSEAS_FUNDS.map(async (f) => {
    const res =
      f.source === 'fhtrust'  ? await fetchLatestFhtrust(f.fundId) :
      f.issuer === 'ezmoney'  ? await fetchLatestEzmoney(f.ticker) :
      f.issuer === 'yuanta'   ? await fetchLatestYuanta(f.ticker) :
      f.issuer === 'capital'  ? await fetchLatestCapital(f.ticker) :
      f.issuer === 'jpmorgan' ? await fetchLatestJpm(f.ticker) :
                                await fetchLatestCmoney(f.fundId);
    return { f, holdingDate: res?.date ?? null, holdings: res?.holdings ?? [] };
  }));

  const agg = new Map<string, { stockname: string; holders: ConsensusHolder[] }>();
  const fundHoldStocks = new Map<string, Set<string>>();

  for (const { f, holdings } of perFund) {
    const seen = new Set<string>();
    for (const h of holdings) {
      if (isCashLike(h.stockid, h.stockname, h.ftype)) continue;
      const { ticker: yfTicker } = stockidToYfTicker(h.stockid);
      if (seen.has(yfTicker)) continue;   // 同檔同日去重（例如兩筆分批進場的部位）
      seen.add(yfTicker);
      const weight = isNaN(h.prate_addaccint) ? 0 : h.prate_addaccint;
      const a = agg.get(yfTicker) ?? { stockname: h.stockname, holders: [] };
      if (!a.stockname && h.stockname) a.stockname = h.stockname;
      a.holders.push({ ticker: f.ticker, w: weight });
      agg.set(yfTicker, a);
    }
    fundHoldStocks.set(f.ticker, seen);
  }

  const soloStocks = new Set<string>();
  for (const [stockid, a] of agg) if (a.holders.length === 1) soloStocks.add(stockid);

  const stocks: ConsensusStock[] = [...agg.entries()].map(([stockid, a]) => {
    const ws = a.holders.map(h => h.w);
    const sumWeight = ws.reduce((s, x) => s + x, 0);
    const maxIdx = ws.reduce((mi, x, i, arr) => x > arr[mi] ? i : mi, 0);
    return {
      stockid, stockname: a.stockname,
      heldBy: a.holders.length,
      holders: a.holders,
      sumWeight,
      avgWeight: a.holders.length ? sumWeight / a.holders.length : 0,
      maxWeight: ws.length ? ws[maxIdx] : 0,
      maxHolder: a.holders.length ? a.holders[maxIdx].ticker : '',
    };
  }).sort((x, y) => y.heldBy - x.heldBy || y.sumWeight - x.sumWeight);

  const funds: ConsensusFund[] = perFund.map(({ f, holdingDate }) => {
    const held = fundHoldStocks.get(f.ticker) ?? new Set();
    let nSolo = 0;
    for (const s of held) if (soloStocks.has(s)) nSolo++;
    return {
      ticker: f.ticker, name: f.name, holdingDate, nHoldings: held.size, nSolo,
      navProxy: null, priceCoverage: 0,
    };
  });

  const asOf = perFund.reduce((mx, { holdingDate }) => (holdingDate && holdingDate > mx ? holdingDate : mx), '');

  const data: ConsensusResult = { asOf, nFunds: OVERSEAS_FUNDS.length, funds, stocks };
  _cache = { ts: Date.now(), data };
  return data;
}
