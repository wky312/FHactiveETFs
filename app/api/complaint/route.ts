import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual, createHash } from 'crypto';
import { buildFactPack, validateEntryDate, COMPLAINT_TICKERS, FactError } from '@/lib/complaint/facts';
import { templateReply, SCENARIOS, type Scenario } from '@/lib/complaint/template';
import { SYSTEM_PROMPT, buildUserPrompt } from '@/lib/complaint/prompt';
import { complianceCheck } from '@/lib/complaint/compliance';
import { generateWithGemini } from '@/lib/gemini';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/* 客訴回覆助手。站台公開、內容屬內部話術 → 密碼閘門，fail-closed（沒設 COMPLAINT_PASSWORD 一律 401）。
   用 sha256 後比對，長度固定才能 timingSafeEqual。 */
function authorized(req: NextRequest): boolean {
  const secret = (process.env.COMPLAINT_PASSWORD ?? '').replace(/^"|"$/g, '');
  if (!secret) return false;
  const given = req.headers.get('x-complaint-key') ?? '';
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

const VALID = new Set(SCENARIOS.map(s => s.id));

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: '密碼錯誤或未授權' }, { status: 401 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: '請求格式錯誤' }, { status: 400 }); }

  const ticker = String(body?.ticker ?? '');
  if (!COMPLAINT_TICKERS.includes(ticker)) return NextResponse.json({ error: '不支援的基金' }, { status: 400 });
  const scenarios: Scenario[] = Array.isArray(body?.scenarios)
    ? [...new Set((body.scenarios as unknown[]).map(String))].filter((s): s is Scenario => VALID.has(s as Scenario))
    : [];
  if (!scenarios.length) return NextResponse.json({ error: '請至少選一種抱怨情境' }, { status: 400 });
  const entryDate = body?.entryDate ? String(body.entryDate) : '';
  if (entryDate) {
    const err = validateEntryDate(ticker, entryDate);
    if (err) return NextResponse.json({ error: err }, { status: 400 });
  }
  const customerMessage = body?.customerMessage ? String(body.customerMessage) : '';
  if (customerMessage.length > 1000) return NextResponse.json({ error: '客戶原文請在 1,000 字以內' }, { status: 400 });
  const useAi = body?.useAi !== false;

  let facts;
  try {
    facts = await buildFactPack(ticker, scenarios.includes('entry_loss') && entryDate ? entryDate : undefined);
  } catch (e) {
    const msg = e instanceof FactError ? e.message : '資料抓取失敗，請稍後再試';
    console.error('[complaint] facts failed', e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  const draft = templateReply(facts, scenarios);
  let reply = draft;
  let source: 'gemini' | 'template' = 'template';
  let model: string | null = null;
  let aiErrors: string[] = [];
  if (useAi) {
    const { result, errors } = await generateWithGemini(SYSTEM_PROMPT, buildUserPrompt(facts, scenarios, draft, customerMessage));
    aiErrors = errors;
    if (result) { reply = result.text; source = 'gemini'; model = result.model; }
  }

  const checked = complianceCheck(reply, facts);
  return NextResponse.json({
    facts, reply: checked.reply, draft: complianceCheck(draft, facts).reply,
    source, model, warnings: checked.warnings,
    aiNote: useAi && source === 'template' ? `AI 潤飾暫時無法使用，已改用規則模板（${aiErrors.join('；')}）` : null,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
