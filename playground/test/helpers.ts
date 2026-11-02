// In-memory stand-ins for the Pages runtime: KV namespace and Workers AI binding.
import type { Env } from '../functions/_lib/util';

export function fakeKv() {
  const data = new Map<string, string>();
  const puts: { key: string; value: string; opts?: any }[] = [];
  return {
    data, puts,
    async get(k: string) { return data.has(k) ? data.get(k)! : null; },
    async put(k: string, v: string, opts?: any) { puts.push({ key: k, value: v, opts }); data.set(k, v); },
  };
}

export function fakeAi(reply = 'Our office hours are Monday to Friday. A team member will reply within 30 minutes.') {
  const runs: string[] = [];
  return {
    runs,
    async run(model: string, input: any) {
      runs.push(model);
      if (input.text) return { data: input.text.map(() => [1, 1, 1]) };
      if (model.includes('llama-guard')) return { response: 'safe' };
      if (model.includes('gpt-oss')) return { response: { unsupported_claims: [], gives_specific_advice: false, promises_outcome: false, repeats_sensitive: false, note: '' } };
      return { response: JSON.stringify({ lang: 'en', matter_type: 'hours', urgency: 'low', summary: 's', reply, citations: ['hours'], sensitive_data: [] }) };
    },
  };
}

export function env(over: Partial<Env> = {}, kv = fakeKv(), ai = fakeAi()): Env {
  return { AI: ai, RATE: kv as unknown as KVNamespace, ...over };
}

export const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://guardrails.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body) });

// Pages hands handlers an EventContext; the handlers here only read request and env.
export const ctx = (request: Request, e: Env) => ({ request, env: e }) as any;
