const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).host}`);
  return res;
}

export const fetchText = async (url: string) => (await get(url)).text();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const fetchJson = async <T = any>(url: string): Promise<T> => (await get(url)).json() as Promise<T>;
