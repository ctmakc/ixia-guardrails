// Workers AI adapters and the playground Pages Functions, with in-memory fakes
// for fetch, the AI binding and KV (no network).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { textOf, bindingClient, restClient } from '../src/adapters/workers-ai';
import { verifyChain } from '../src/audit';
import { takeBudget, json } from '../../../playground/functions/_lib/util';
import { onRequestPost as auditPost } from '../../../playground/functions/api/audit';
import { onRequestPost as triagePost } from '../../../playground/functions/api/triage';

describe('textOf', () => {
  test('handles every Workers AI response shape', () => {
    assert.equal(textOf(null), '');
    assert.equal(textOf('plain'), 'plain');
    assert.equal(textOf({ response: 'classic' }), 'classic');
    assert.equal(textOf({ response: { a: 1 } }), '{"a":1}');
    assert.equal(textOf({ choices: [{ message: { content: 'openai' } }] }), 'openai');
    assert.equal(textOf({ output: [
      { type: 'reasoning', content: [{ text: 'thinking' }] },
      { type: 'message', content: [{ text: 'part1 ' }, { text: 'part2' }] },
    ] }), 'part1 part2');
    assert.equal(textOf({ result: { response: 'wrapped' } }), 'wrapped');
    assert.equal(textOf({ unknown: true }), '');
  });
});

describe('bindingClient', () => {
  test('passes messages, max_tokens and reasoning_effort; returns embeddings data', async () => {
    const calls: any[] = [];
    const ai = { run: async (model: string, input: any) => { calls.push([model, input]); return input.text ? { data: [[1, 2]] } : { response: 'ok' }; } };
    const c = bindingClient(ai);
    assert.equal(await c.chat('m', [{ role: 'user', content: 'hi' }], { maxTokens: 10, reasoningEffort: 'low' }), 'ok');
    assert.deepEqual(calls[0], ['m', { messages: [{ role: 'user', content: 'hi' }], max_tokens: 10, reasoning_effort: 'low' }]);
    await c.chat('m', []);
    assert.deepEqual(calls[1][1], { messages: [], max_tokens: 700 });
    assert.deepEqual(await c.embed('e', ['x']), [[1, 2]]);
    assert.equal(await c.guard('g', [{ role: 'user', content: 'x' }]), 'ok');
  });
});

describe('restClient', () => {
  function fakeFetch(responses: { status: number; body: any }[], seen: any[]) {
    return (async (url: string, init: any) => {
      seen.push({ url, init });
      const r = responses.shift()!;
      return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
  }
  test('chat goes to /v1/chat/completions with bearer auth; embed unwraps result.data', async () => {
    const seen: any[] = [];
    const c = restClient('acc', 'tok', fakeFetch([
      { status: 200, body: { choices: [{ message: { content: 'hello' } }] } },
      { status: 200, body: { result: { data: [[0.1]] } } },
    ], seen));
    assert.equal(await c.chat('@cf/x', [{ role: 'user', content: 'q' }]), 'hello');
    assert.equal(seen[0].url, 'https://api.cloudflare.com/client/v4/accounts/acc/ai/v1/chat/completions');
    assert.equal(seen[0].init.headers.Authorization, 'Bearer tok');
    assert.deepEqual(JSON.parse(seen[0].init.body), { model: '@cf/x', messages: [{ role: 'user', content: 'q' }], max_tokens: 700 });
    assert.deepEqual(await c.embed('@cf/e', ['t']), [[0.1]]);
    assert.equal(seen[1].url, 'https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/e');
  });
  test('4xx fails at once with status and body excerpt', async () => {
    const seen: any[] = [];
    const c = restClient('acc', 'tok', fakeFetch([{ status: 400, body: 'bad input' }], seen));
    await assert.rejects(c.guard('g', []), /workers-ai \/run\/g 400: bad input/);
    assert.equal(seen.length, 1);
  });
  test('429 is retried, then succeeds', async () => {
    const seen: any[] = [];
    const c = restClient('acc', 'tok', fakeFetch([{ status: 429, body: 'slow down' }, { status: 200, body: { result: { response: 'safe' } } }], seen));
    assert.equal(await c.guard('g', []), 'safe');
    assert.equal(seen.length, 2);
  });
});

function fakeKV(init: Record<string, string> = {}) {
  const store = new Map(Object.entries(init));
  return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v); } };
}
const day = () => new Date().toISOString().slice(0, 10);

describe('takeBudget', () => {
  test('counts global and per-IP runs and reports runs left', async () => {
    const kv = fakeKV();
    const env: any = { RATE: kv, DAILY_LIVE_RUNS: '3', PER_IP_PER_DAY: '2' };
    assert.deepEqual(await takeBudget(env, '1.1.1.1'), { ok: true, left: 2 });
    assert.deepEqual(await takeBudget(env, '1.1.1.1'), { ok: true, left: 1 });
    assert.deepEqual(await takeBudget(env, '1.1.1.1'), { ok: false, reason: 'per_visitor_budget' });
    assert.deepEqual(await takeBudget(env, '2.2.2.2'), { ok: true, left: 0 });
    assert.deepEqual(await takeBudget(env, '3.3.3.3'), { ok: false, reason: 'daily_budget' });
    assert.equal(kv.store.get(`g:${day()}`), '3');
  });
  test('defaults: 120 per day, 25 per IP', async () => {
    const env: any = { RATE: fakeKV({ [`ip:${day()}:x`]: '25' }) };
    assert.deepEqual(await takeBudget(env, 'x'), { ok: false, reason: 'per_visitor_budget' });
    const env2: any = { RATE: fakeKV({ [`g:${day()}`]: '120' }) };
    assert.deepEqual(await takeBudget(env2, 'y'), { ok: false, reason: 'daily_budget' });
  });
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://x/api', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers });

describe('POST /api/audit', () => {
  const call = (body: unknown) => auditPost({ request: post(body) } as any);
  test('json() helper sets status and no-store', async () => {
    const r = json({ a: 1 }, 418);
    assert.equal(r.status, 418);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });
  test('rejects bad JSON, unknown op and disallowed actions', async () => {
    assert.equal((await call('{')).status, 400);
    assert.deepEqual(await (await call({ op: 'nope' })).json(), { error: 'bad_op' });
    const r = await call({ op: 'append', entry: { action: 'triaged' } });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'bad_action' });
  });
  test('append builds a verifiable chain with truncated fields; verify detects tampering', async () => {
    const a = (await (await call({ op: 'append', prev: null, entry: { action: 'approved', leadRef: 'x'.repeat(40), decision: 'hold_for_review', promptVersion: 'v' } })).json() as any).record;
    assert.equal(a.seq, 1);
    assert.equal(a.leadRef.length, 16);
    assert.equal(a.actor, 'demo reviewer');
    const b = (await (await call({ op: 'append', prev: a, entry: { action: 'rejected' } })).json() as any).record;
    assert.equal(b.seq, 2);
    assert.deepEqual(await (await call({ op: 'verify', records: [a, b] })).json(), { ok: true });
    assert.deepEqual(await (await call({ op: 'verify', records: [a, { ...b, action: 'approved' }] })).json(), { ok: false, brokenAt: 2 });
    assert.deepEqual(await (await call({ op: 'verify', records: 'nope' })).json(), { ok: true });
  });
});

describe('POST /api/triage', () => {
  function env(kv = fakeKV()) {
    const ai = { run: async (model: string, input: any) => {
      if (input.text) return { data: input.text.map(() => [1, 1]) };
      if (model.includes('llama-guard')) return { response: 'safe' };
      if (model.includes('gpt-oss')) return { response: JSON.stringify({ unsupported_claims: [], gives_specific_advice: false, promises_outcome: false, repeats_sensitive: false }) };
      return { response: JSON.stringify({ lang: 'en', reply: 'Our office hours are Monday to Friday, 09:00 to 17:30.', citations: ['hours'], urgency: 'low', sensitive_data: [] }) };
    } };
    return { AI: ai, RATE: kv } as any;
  }
  const call = (body: unknown, e = env(), headers: Record<string, string> = { 'cf-connecting-ip': '9.9.9.9' }) =>
    triagePost({ request: post(body, headers), env: e } as any);

  test('validates input before spending budget', async () => {
    const kv = fakeKV();
    assert.equal((await call('{', env(kv))).status, 400);
    assert.deepEqual(await (await call({ message: '  hi ' }, env(kv))).json(), { error: 'message_required' });
    assert.equal(kv.store.size, 0);
  });
  test('429 when the daily budget is spent', async () => {
    const r = await call({ message: 'What are your hours?' }, env(fakeKV({ [`g:${day()}`]: '120' })));
    assert.equal(r.status, 429);
    assert.deepEqual(await r.json(), { error: 'daily_budget' });
  });
  test('runs the gate, strips the raw model output, appends a chained audit record', async () => {
    const kv = fakeKV();
    const r = await call({ name: 'Emma', message: 'What are your office hours?' }, env(kv));
    assert.equal(r.status, 200);
    const b: any = await r.json();
    assert.equal(b.result.decision, 'auto_send');
    assert.equal('raw' in b.result.draft, false);
    assert.equal(b.record.seq, 1);
    assert.equal(b.record.action, 'triaged');
    assert.match(b.record.leadRef, /^[0-9a-f]{16}$/);
    assert.equal(b.liveRunsLeftToday, 119);
    assert.ok(kv.store.has(`ip:${day()}:9.9.9.9`));
    const b2: any = await (await call({ message: 'Opening hours please?', prev: b.record }, env(kv))).json();
    assert.equal(b2.record.seq, 2);
    assert.deepEqual(await verifyChain([b.record, b2.record]), { ok: true });
  });
  test('missing cf-connecting-ip is budgeted as "unknown"', async () => {
    const kv = fakeKV();
    await call({ message: 'What are your office hours?' }, env(kv), {});
    assert.ok(kv.store.has(`ip:${day()}:unknown`));
  });
});
