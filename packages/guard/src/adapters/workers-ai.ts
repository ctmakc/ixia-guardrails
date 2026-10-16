import type { ModelClient } from '../types';

type Msg = { role: string; content: string };

// Pulls text out of the response shapes Workers AI models return
// (classic `response`, OpenAI-style `choices`, Responses-style `output`).
export function textOf(r: any): string {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (typeof r.response === 'string') return r.response;
  if (r.response && typeof r.response === 'object') return JSON.stringify(r.response);
  const c = r.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(r.output)) {
    const parts: string[] = [];
    for (const o of r.output) for (const p of o?.content || []) if (typeof p?.text === 'string' && o.type === 'message') parts.push(p.text);
    if (parts.length) return parts.join('');
  }
  if (r.result) return textOf(r.result);
  return '';
}

/** Cloudflare Workers AI through the `AI` binding (Pages Functions / Workers). */
export function bindingClient(ai: { run: (model: string, input: any) => Promise<any> }): ModelClient {
  return {
    async chat(model, messages, opts) {
      return textOf(await ai.run(model, { messages, max_tokens: opts?.maxTokens ?? 700,
        ...(opts?.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}) }));
    },
    async embed(model, texts) {
      const r = await ai.run(model, { text: texts });
      return r.data;
    },
    async guard(model, messages) {
      return textOf(await ai.run(model, { messages }));
    },
  };
}

/** Cloudflare Workers AI through the REST API (Node: IXIA server, eval runner). */
export function restClient(accountId: string, token: string, fetchImpl: typeof fetch = fetch): ModelClient {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai`;
  const post = async (path: string, body: unknown, timeoutMs = 45_000) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res.json();
      if (attempt < 2 && (res.status === 429 || res.status >= 500)) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      throw new Error(`workers-ai ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  };
  return {
    async chat(model, messages: Msg[], opts) {
      return textOf(await post('/v1/chat/completions', { model, messages, max_tokens: opts?.maxTokens ?? 700,
        ...(opts?.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}) }));
    },
    async embed(model, texts) {
      const r: any = await post(`/run/${model}`, { text: texts });
      return r.result.data;
    },
    async guard(model, messages: Msg[]) {
      return textOf(await post(`/run/${model}`, { messages }));
    },
  };
}
