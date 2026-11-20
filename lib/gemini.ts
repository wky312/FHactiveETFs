/* Gemini REST 呼叫（不加 SDK 依賴）。模型鏈依 gemini-free-tier skill 實測：
   2.5-flash → flash-latest → 2.5-flash-lite；2.0-flash 已無免費額度別用。
   serverless 不做 20–60 秒退避：429/5xx 直接換下一個模型，全掛就回 null 讓呼叫端退回模板。 */

const MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite'];
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiResult { text: string; model: string }

export async function generateWithGemini(
  system: string, user: string, opts?: { timeoutMs?: number; temperature?: number },
): Promise<{ result: GeminiResult | null; errors: string[] }> {
  const key = (process.env.GEMINI_API_KEY ?? '').replace(/^"|"$/g, '');
  const errors: string[] = [];
  if (!key) return { result: null, errors: ['GEMINI_API_KEY 未設定'] };

  for (const model of MODELS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 25000);
    try {
      const res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            temperature: opts?.temperature ?? 0.4,
            maxOutputTokens: 2048,
            thinkingConfig: model.includes('lite') ? undefined : { thinkingBudget: 512 },
          },
        }),
        signal: ctrl.signal,
        cache: 'no-store',
      });
      if (!res.ok) {
        errors.push(`${model}: HTTP ${res.status}`);
        if (res.status === 429 || res.status >= 500 || res.status === 404) continue;
        break;                                   // 400/401/403：key 或請求本身有問題，換模型也沒用
      }
      const data = await res.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
      const text = parts.filter(p => !p.thought).map(p => p.text ?? '').join('').trim();
      if (!text) { errors.push(`${model}: 空回應（${data?.candidates?.[0]?.finishReason ?? 'unknown'}）`); continue; }
      return { result: { text, model }, errors };
    } catch (e) {
      errors.push(`${model}: ${(e as Error).name === 'AbortError' ? '逾時' : (e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { result: null, errors };
}
