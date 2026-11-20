// Workers AI adapters (with a fake binding and a fake fetch: no network),
// retrieval ranking/fallback/cache, and the hash-chained audit log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textOf, bindingClient, restClient } from '../src/adapters/workers-ai';
import { retrieve } from '../src/retrieve';
import { appendRecord, verifyChain, sha256, GENESIS, type AuditRecord } from '../src/audit';
import type { KbSnippet, ModelClient } from '../src/types';

// ---- textOf ---------------------------------------------------------------

test('textOf: every Workers AI response shape yields its text', () => {
  assert.equal(textOf(null), '');
  assert.equal(textOf(undefined), '');
  assert.equal(textOf('plain'), 'plain');
  assert.equal(textOf({ response: 'classic' }), 'classic');
  assert.equal(textOf({ response: { safe: true, categories: [] } }), '{"safe":true,"categories":[]}');
  assert.equal(textOf({ choices: [{ message: { content: 'openai' } }] }), 'openai');
  assert.equal(textOf({ output: [
    { type: 'reasoning', content: [{ text: 'hidden chain of thought' }] },
    { type: 'message', content: [{ text: 'Hello ' }, { text: 'world' }, { image: 'x' }] },
  ] }), 'Hello world');
  assert.equal(textOf({ result: { response: 'wrapped' } }), 'wrapped');
  assert.equal(textOf({ result: { choices: [{ message: { content: 'rest' } }] } }), 'rest');
  assert.equal(textOf({}), '');
  assert.equal(textOf({ output: [{ type: 'reasoning', content: [{ text: 'only reasoning' }] }] }), '');
});

// ---- bindingClient ----------------------------------------------------------

test('bindingClient: passes messages, max_tokens and reasoning_effort only when set', async () => {
  const runs: [string, any][] = [];
  const ai = { async run(model: string, input: any) {
    runs.push([model, input]);
    if (input.text) return { data: input.text.map((_: string, i: number) => [i, 1]) };
    return { response: `ok:${model}` };
  } };
  const c = bindingClient(ai);
  const msgs = [{ role: 'user' as const, content: 'hi' }];
  assert.equal(await c.chat('m1', msgs), 'ok:m1');
  assert.deepEqual(runs[0], ['m1', { messages: msgs, max_tokens: 700 }]);
  await c.chat('m2', msgs, { maxTokens: 50, reasoningEffort: 'low', json: true });
  assert.deepEqual(runs[1], ['m2', { messages: msgs, max_tokens: 50, reasoning_effort: 'low' }]);
  assert.deepEqual(await c.embed('e', ['a', 'b']), [[0, 1], [1, 1]]);
  assert.deepEqual(runs[2], ['e', { text: ['a', 'b'] }]);
  assert.equal(await c.guard('g', msgs), 'ok:g');
  assert.deepEqual(runs[3], ['g', { messages: msgs }]);
});

// ---- restClient (fake fetch) ------------------------------------------------

function fakeFetch(responses: (() => Response)[]) {
  const calls: { url: string; init: any }[] = [];
  const f = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch');
    return next();
  }) as typeof fetch;
  return { f, calls };
}
const jsonRes = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('restClient: chat goes to /v1/chat/completions with bearer auth and the OpenAI-style body', async () => {
  const { f, calls } = fakeFetch([jsonRes({ choices: [{ message: { content: 'drafted' } }] })]);
  const c = restClient('acc123', 'tok-xyz', f);
  assert.equal(await c.chat('@cf/m', [{ role: 'user', content: 'q' }], { maxTokens: 99, reasoningEffort: 'high' }), 'drafted');
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-xyz');
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: '@cf/m', messages: [{ role: 'user', content: 'q' }], max_tokens: 99, reasoning_effort: 'high' });
  assert.ok(calls[0].init.signal, 'request carries an abort signal (timeout)');
});

test('restClient: embed and guard use /run/<model> and unwrap result', async () => {
  const { f, calls } = fakeFetch([
    jsonRes({ success: true, result: { data: [[0.1, 0.2]] } }),
    jsonRes({ success: true, result: { response: 'unsafe\nS6' } }),
  ]);
  const c = restClient('a', 't', f);
  assert.deepEqual(await c.embed('@cf/baai/bge-m3', ['x']), [[0.1, 0.2]]);
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/a/ai/run/@cf/baai/bge-m3');
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: ['x'] });
  assert.equal(await c.guard('@cf/meta/llama-guard-3-8b', [{ role: 'user', content: 'u' }]), 'unsafe\nS6');
});

test('restClient: a 4xx is not retried and the error carries status and a truncated body', async () => {
  const { f, calls } = fakeFetch([() => new Response('x'.repeat(500), { status: 400 })]);
  const c = restClient('a', 't', f);
  await assert.rejects(c.chat('m', []), (e: Error) => {
    assert.match(e.message, /^workers-ai \/v1\/chat\/completions 400: x+$/);
    assert.equal(e.message.length, 'workers-ai /v1/chat/completions 400: '.length + 200);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('restClient: 429 and 5xx are retried, then the call succeeds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { f, calls } = fakeFetch([() => new Response('busy', { status: 429 }), () => new Response('oops', { status: 503 }),
    jsonRes({ result: { response: 'safe' } })]);
  const p = restClient('a', 't', f).guard('g', []);
  for (let i = 0; i < 20 && calls.length < 3; i++) { await new Promise((r) => setImmediate(r)); t.mock.timers.tick(3000); }
  assert.equal(await p, 'safe');
  assert.equal(calls.length, 3);
});

test('restClient: gives up after three attempts on persistent 5xx', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { f, calls } = fakeFetch([0, 1, 2].map(() => () => new Response('down', { status: 500 })));
  const p = restClient('a', 't', f).chat('m', []);
  const settled = p.then(() => 'resolved', (e) => e.message);
  for (let i = 0; i < 20 && calls.length < 3; i++) { await new Promise((r) => setImmediate(r)); t.mock.timers.tick(3000); }
  assert.equal(await settled, 'workers-ai /v1/chat/completions 500: down');
  assert.equal(calls.length, 3);
});

// ---- retrieve ---------------------------------------------------------------

const KB: KbSnippet[] = [
  { id: 'fees', title: 'Fees', text: 'The consultation costs EUR 150.' },
  { id: 'hours', title: 'Office hours', text: 'Open Monday to Friday.' },
  { id: 'lang', title: 'Languages', text: 'We speak Dutch and English.' },
];
// Embeds by keyword so ranking is predictable.
function keywordEmbed(calls: string[][] = []): ModelClient {
  const dims = ['cost', 'open', 'speak'];
  return { async chat() { return ''; }, async guard() { return ''; },
    async embed(_m, texts) { calls.push(texts); return texts.map((t) => dims.map((d) => (t.toLowerCase().includes(d) ? 1 : 0.01))); } };
}

test('retrieve: dense mode ranks by cosine similarity and honours k', async () => {
  const r = await retrieve(keywordEmbed(), 'rt-dense-1', 'When are you open?', KB, 2);
  assert.equal(r.mode, 'dense');
  assert.equal(r.hits.length, 2);
  assert.equal(r.hits[0].snippet.id, 'hours');
  assert.ok(r.hits[0].score > r.hits[1].score);
  assert.ok(r.hits[0].score <= 1 + 1e-9);
});

test('retrieve: KB embeddings are cached per model; a changed snippet is re-embedded', async () => {
  const calls: string[][] = [];
  const llm = keywordEmbed(calls);
  await retrieve(llm, 'rt-cache-1', 'cost?', KB);
  assert.equal(calls[0].length, 4); // query + 3 snippets
  await retrieve(llm, 'rt-cache-1', 'open?', KB);
  assert.deepEqual(calls[1], ['open?']); // only the query
  const edited = [{ ...KB[0], text: 'The consultation now costs EUR 175.' }, KB[1], KB[2]];
  await retrieve(llm, 'rt-cache-1', 'cost?', edited);
  assert.deepEqual(calls[2], ['cost?', 'Fees. The consultation now costs EUR 175.']);
  await retrieve(llm, 'rt-cache-other-model', 'cost?', KB);
  assert.equal(calls[3].length, 4); // another model has its own vectors
});

test('retrieve: embedding failure falls back to token overlap; empty KB returns nothing', async () => {
  const down: ModelClient = { async chat() { return ''; }, async guard() { return ''; }, async embed() { throw new Error('down'); } };
  const r = await retrieve(down, 'rt-lex-1', 'What are your office hours on Monday?', KB, 3);
  assert.equal(r.mode, 'lexical');
  assert.equal(r.hits[0].snippet.id, 'hours');
  assert.equal(r.hits[0].score, 3 / 6); // office, hours, monday of {what, are, your, office, hours, monday}
  assert.equal(r.hits[2].score, 0);
  assert.deepEqual(await retrieve(down, 'rt-lex-1', 'anything', []), { hits: [], mode: 'dense' });
  const tiny = await retrieve(down, 'rt-lex-1', 'a b ?', KB); // only ≤2-letter tokens
  assert.ok(tiny.hits.every((h) => h.score === 0));
});

test('retrieve: a malformed embedding (empty vector) falls back instead of poisoning results', async () => {
  const bad: ModelClient = { async chat() { return ''; }, async guard() { return ''; }, async embed(_m, t) { return t.map((_, i) => (i === 2 ? [] : [1])); } };
  assert.equal((await retrieve(bad, 'rt-bad-1', 'open', KB)).mode, 'lexical');
});

// ---- audit ------------------------------------------------------------------

const entry = (action: string, extra: Partial<AuditRecord> = {}) => ({ at: '2026-11-20T10:00:00Z', leadRef: 'lead1', decision: 'hold_for_review',
  checks: [{ id: 'a', status: 'pass' }], models: { draft: 'd', verifier: 'v' }, promptVersion: 'p1', actor: 'ixia-guard', action, ...extra });

async function chainOf(n: number) {
  const out: AuditRecord[] = [];
  let prev: AuditRecord | null = null;
  for (let i = 0; i < n; i++) { prev = await appendRecord(prev, entry(i ? 'approved' : 'triaged')); out.push(prev); }
  return out;
}

test('sha256 matches the standard test vectors', async () => {
  assert.equal(await sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('appendRecord: seq starts at 1 on GENESIS and links each record to the previous hash', async () => {
  const [a, b, c] = await chainOf(3);
  assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3]);
  assert.equal(a.prevHash, GENESIS);
  assert.equal(b.prevHash, a.hash);
  assert.equal(c.prevHash, b.hash);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.equal(new Set([a.hash, b.hash, c.hash]).size, 3);
});

test('appendRecord: hash is deterministic and ignores the key order of models', async () => {
  const x = await appendRecord(null, entry('triaged', { models: { draft: 'd', verifier: 'v' } }));
  const y = await appendRecord(null, entry('triaged', { models: { verifier: 'v', draft: 'd' } }));
  assert.equal(x.hash, y.hash);
  const z = await appendRecord(null, entry('triaged', { models: { draft: 'd', verifier: 'v2' } }));
  assert.notEqual(x.hash, z.hash);
});

test('verifyChain: an empty chain is valid', async () => {
  assert.deepEqual(await verifyChain([]), { ok: true });
});

test('verifyChain: deleting, reordering or editing any field breaks the chain at the right record', async () => {
  const chain = await chainOf(4);
  assert.deepEqual(await verifyChain(chain), { ok: true });
  assert.deepEqual(await verifyChain([chain[0], chain[2], chain[3]]), { ok: false, brokenAt: 3 }); // deleted #2
  assert.deepEqual(await verifyChain([chain[1], chain[0], chain[2], chain[3]]), { ok: false, brokenAt: 2 });
  for (const field of ['at', 'leadRef', 'decision', 'promptVersion', 'actor', 'action'] as const) {
    const t = chain.map((r) => ({ ...r }));
    (t[2] as any)[field] = 'tampered';
    assert.deepEqual(await verifyChain(t), { ok: false, brokenAt: 3 }, field);
  }
  const checks = chain.map((r) => ({ ...r }));
  checks[1] = { ...checks[1], checks: [{ id: 'a', status: 'review' }] };
  assert.deepEqual(await verifyChain(checks), { ok: false, brokenAt: 2 });
  const models = chain.map((r) => ({ ...r }));
  models[3] = { ...models[3], models: { draft: 'other' } };
  assert.deepEqual(await verifyChain(models), { ok: false, brokenAt: 4 });
});

test('verifyChain: re-hashing a tampered record still breaks at the next one', async () => {
  const chain = await chainOf(3);
  const forged = await appendRecord(chain[0], entry('approved', { decision: 'auto_send' }));
  assert.deepEqual(await verifyChain([chain[0], forged, chain[2]]), { ok: false, brokenAt: 3 });
});

test('verifyChain: a chain that does not start at GENESIS is broken at its first record', async () => {
  const chain = await chainOf(3);
  assert.deepEqual(await verifyChain(chain.slice(1)), { ok: false, brokenAt: 2 });
});
