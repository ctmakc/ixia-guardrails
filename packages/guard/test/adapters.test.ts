// Workers AI adapters with a mocked binding and a mocked fetch: no network, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindingClient, restClient, textOf } from '../src/adapters/workers-ai';

test('textOf reads every response shape Workers AI returns', () => {
  assert.equal(textOf(null), '');
  assert.equal(textOf('plain'), 'plain');
  assert.equal(textOf({ response: 'classic' }), 'classic');
  assert.equal(textOf({ response: { a: 1 } }), '{"a":1}');
  assert.equal(textOf({ choices: [{ message: { content: 'openai' } }] }), 'openai');
  assert.equal(textOf({ output: [{ type: 'reasoning', content: [{ text: 'hidden' }] }, { type: 'message', content: [{ text: 'a' }, { text: 'b' }] }] }), 'ab');
  assert.equal(textOf({ result: { response: 'nested' } }), 'nested');
  assert.equal(textOf({}), '');
});

test('bindingClient passes messages, limits and reasoning effort to the binding', async () => {
  const runs: { model: string; input: any }[] = [];
  const c = bindingClient({ async run(model, input) { runs.push({ model, input }); return input.text ? { data: [[1]] } : { response: 'ok' }; } });
  assert.equal(await c.chat('m', [{ role: 'user', content: 'hi' }], { maxTokens: 10, reasoningEffort: 'low' }), 'ok');
  assert.deepEqual(runs[0].input, { messages: [{ role: 'user', content: 'hi' }], max_tokens: 10, reasoning_effort: 'low' });
  await c.chat('m', [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(runs[1].input, { messages: [{ role: 'user', content: 'hi' }], max_tokens: 700 });
  assert.deepEqual(await c.embed('e', ['x']), [[1]]);
  assert.equal(await c.guard('g', [{ role: 'user', content: 'x' }]), 'ok');
});

type Call = { url: string; init: RequestInit };
function mockFetch(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const f = (async (url: any, init: any) => { calls.push({ url: String(url), init }); return responses[Math.min(calls.length - 1, responses.length - 1)](); }) as typeof fetch;
  return { f, calls };
}
const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

test('restClient posts to the account endpoint with a bearer token', async () => {
  const { f, calls } = mockFetch([ok({ choices: [{ message: { content: 'hello' } }] })]);
  const c = restClient('acct123', 'tok-test', f);
  assert.equal(await c.chat('@cf/x', [{ role: 'user', content: 'q' }], { maxTokens: 5 }), 'hello');
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1/chat/completions');
  assert.equal((calls[0].init.headers as any).Authorization, 'Bearer tok-test');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { model: '@cf/x', messages: [{ role: 'user', content: 'q' }], max_tokens: 5 });
});

test('restClient embed and guard use /run/<model>', async () => {
  const { f, calls } = mockFetch([ok({ result: { data: [[0.1, 0.2]] } }), ok({ result: { response: 'safe' } })]);
  const c = restClient('a', 't', f);
  assert.deepEqual(await c.embed('@cf/baai/bge-m3', ['x']), [[0.1, 0.2]]);
  assert.equal(await c.guard('@cf/meta/llama-guard-3-8b', [{ role: 'user', content: 'x' }]), 'safe');
  assert.match(calls[0].url, /\/ai\/run\/@cf\/baai\/bge-m3$/);
  assert.match(calls[1].url, /\/ai\/run\/@cf\/meta\/llama-guard-3-8b$/);
});

test('restClient does not retry a 4xx and never puts the token in the error', async () => {
  const { f, calls } = mockFetch([() => new Response('bad request', { status: 400 })]);
  await assert.rejects(restClient('a', 'tok-secret', f).chat('m', []), (e: Error) => /400/.test(e.message) && !e.message.includes('tok-secret'));
  assert.equal(calls.length, 1);
});

test('restClient retries 429/5xx twice, then gives up', async () => {
  const { f, calls } = mockFetch([() => new Response('busy', { status: 503 })]);
  const t0 = Date.now();
  await assert.rejects(restClient('a', 't', f).guard('m', []), /503/);
  assert.equal(calls.length, 3);
  assert.ok(Date.now() - t0 >= 4000);
});

test('restClient recovers when a retry succeeds', async () => {
  const { f, calls } = mockFetch([() => new Response('slow', { status: 429 }), ok({ result: { response: 'safe' } })]);
  assert.equal(await restClient('a', 't', f).guard('m', []), 'safe');
  assert.equal(calls.length, 2);
});
