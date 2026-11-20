// Playground Pages Functions (/api/triage, /api/audit) and the KV run budget,
// driven with an in-memory KV and a fake Workers AI binding: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeBudget, json, type Env } from '../../../playground/functions/_lib/util';
import { onRequestPost as triagePost } from '../../../playground/functions/api/triage';
import { onRequestPost as auditPost } from '../../../playground/functions/api/audit';
import { verifyChain, appendRecord, GENESIS } from '../src/audit';
import { CLEAN_VERDICT, bug } from './_helpers';

function memKv() {
  const store = new Map<string, string>();
  const puts: { key: string; value: string; opts: any }[] = [];
  return {
    store, puts,
    async get(k: string) { return store.has(k) ? store.get(k)! : null; },
    async put(k: string, v: string, opts?: any) { store.set(k, v); puts.push({ key: k, value: v, opts }); },
  };
}

const HOURS_DRAFT = { lang: 'en', matter_type: 'hours', urgency: 'low', summary: 's',
  reply: 'Our office hours are Monday to Friday, 09:00 to 17:30.', citations: ['hours'], sensitive_data: [] };

function fakeAi() {
  const runs: string[] = [];
  return { runs, async run(model: string, input: any) {
    runs.push(model);
    if (model.includes('bge')) return { data: input.text.map(() => [1, 1, 1]) };
    if (model.includes('llama-guard')) return { response: 'safe' };
    if (model.includes('gpt-oss')) return { choices: [{ message: { content: JSON.stringify(CLEAN_VERDICT) } }] };
    return { response: JSON.stringify(HOURS_DRAFT) };
  } };
}

function env(extra: Partial<Env> = {}) {
  const ai = fakeAi();
  const kv = memKv();
  return { ai, kv, env: { AI: ai, RATE: kv as any, ...extra } as Env };
}
const post = (body: unknown, ip = '203.0.113.7') => new Request('https://demo.example/api/x', {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
  body: typeof body === 'string' ? body : JSON.stringify(body) });
const call = async (fn: any, request: Request, e: Env) => {
  const res: Response = await fn({ request, env: e } as any);
  return { status: res.status, headers: res.headers, body: await res.json() as any };
};
const today = () => new Date().toISOString().slice(0, 10);

// ---- util -------------------------------------------------------------------

test('json(): status, JSON content type and no-store caching', async () => {
  const r = json({ a: 1 }, 418);
  assert.equal(r.status, 418);
  assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await r.json(), { a: 1 });
});

test('takeBudget: counts global and per-IP runs for today with a 2-day TTL', async () => {
  const { env: e, kv } = env();
  assert.deepEqual(await takeBudget(e, '1.1.1.1'), { ok: true, left: 119 });
  assert.deepEqual(await takeBudget(e, '1.1.1.1'), { ok: true, left: 118 });
  assert.deepEqual(await takeBudget(e, '2.2.2.2'), { ok: true, left: 117 });
  assert.equal(kv.store.get(`g:${today()}`), '3');
  assert.equal(kv.store.get(`ip:${today()}:1.1.1.1`), '2');
  assert.ok(kv.puts.every((p) => p.opts?.expirationTtl === 172800));
});

test('takeBudget: per-visitor and daily caps from env, and nothing is written once refused', async () => {
  const { env: e, kv } = env({ DAILY_LIVE_RUNS: '3', PER_IP_PER_DAY: '2' });
  await takeBudget(e, 'a'); await takeBudget(e, 'a');
  assert.deepEqual(await takeBudget(e, 'a'), { ok: false, reason: 'per_visitor_budget' });
  assert.deepEqual(await takeBudget(e, 'b'), { ok: true, left: 0 });
  const before = kv.puts.length;
  assert.deepEqual(await takeBudget(e, 'c'), { ok: false, reason: 'daily_budget' });
  assert.equal(kv.puts.length, before);
});

// ---- /api/triage --------------------------------------------------------------

test('/api/triage: runs the gate, strips the raw model output and starts an audit chain', async () => {
  const { env: e, ai } = env();
  const r = await call(triagePost, post({ name: '  Emma  ', message: '  When are you open?  ' }), e);
  assert.equal(r.status, 200);
  assert.equal(r.body.result.decision, 'auto_send');
  assert.equal('raw' in r.body.result.draft, false);
  assert.equal(r.body.record.seq, 1);
  assert.equal(r.body.record.prevHash, GENESIS);
  assert.equal(r.body.record.action, 'triaged');
  assert.equal(r.body.record.actor, 'ixia-guard');
  assert.match(r.body.record.leadRef, /^[0-9a-f]{16}$/);
  assert.equal(r.body.liveRunsLeftToday, 119);
  assert.equal(typeof r.body.totalMs, 'number');
  assert.ok(ai.runs.length >= 4);
  assert.deepEqual(r.body.record.checks, r.body.result.checks.map((c: any) => ({ id: c.id, status: c.status })));
});

test('/api/triage: the enquiry text never reaches the audit record (only a hash)', async () => {
  const { env: e } = env();
  const r = await call(triagePost, post({ name: 'Lisa', message: 'Secret burn-out story' }), e);
  assert.doesNotMatch(JSON.stringify(r.body.record), /burn-out|Lisa/);
});

test('/api/triage: a returned record can be passed back as prev and the chain verifies', async () => {
  const { env: e } = env();
  const a = await call(triagePost, post({ message: 'When are you open?' }), e);
  const b = await call(triagePost, post({ message: 'When are you open again?', prev: a.body.record }), e);
  assert.equal(b.body.record.seq, 2);
  assert.equal(b.body.record.prevHash, a.body.record.hash);
  assert.deepEqual(await verifyChain([a.body.record, b.body.record]), { ok: true });
  const c = await call(triagePost, post({ message: 'Hello there', prev: { seq: 7 } }), e); // no hash → ignored
  assert.equal(c.body.record.seq, 1);
});

test('/api/triage: bad JSON, missing or too-short message are rejected before any model call', async () => {
  const { env: e, ai, kv } = env();
  assert.deepEqual(await call(triagePost, post('{not json'), e).then((r) => [r.status, r.body]), [400, { error: 'bad_json' }]);
  assert.deepEqual(await call(triagePost, post({ name: 'x' }), e).then((r) => [r.status, r.body]), [400, { error: 'message_required' }]);
  assert.deepEqual(await call(triagePost, post({ message: '  hi  ' }), e).then((r) => [r.status, r.body]), [400, { error: 'message_required' }]);
  assert.equal(ai.runs.length, 0);
  assert.equal(kv.puts.length, 0, 'rejected requests do not spend budget');
});

test('/api/triage: an exhausted budget answers 429 without calling the models', async () => {
  const { env: e, ai } = env({ PER_IP_PER_DAY: '1' });
  assert.equal((await call(triagePost, post({ message: 'When are you open?' }), e)).status, 200);
  const runsAfterFirst = ai.runs.length;
  const r = await call(triagePost, post({ message: 'When are you open?' }), e);
  assert.deepEqual([r.status, r.body], [429, { error: 'per_visitor_budget' }]);
  assert.equal(ai.runs.length, runsAfterFirst);
  assert.equal((await call(triagePost, post({ message: 'When are you open?' }, '198.51.100.1'), e)).status, 200);
});

// ---- /api/audit ---------------------------------------------------------------

test('/api/audit append: reviewer actions extend the chain; fields are clipped; actor is fixed', async () => {
  const { env: e } = env();
  const first = await call(triagePost, post({ message: 'When are you open?' }), e);
  const r = await call(auditPost, post({ op: 'append', prev: first.body.record,
    entry: { action: 'approved', leadRef: 'x'.repeat(40), decision: 'auto_send_and_more_text', promptVersion: 'p'.repeat(60), actor: 'admin' } }), e);
  assert.equal(r.status, 200);
  const rec = r.body.record;
  assert.equal(rec.seq, 2);
  assert.equal(rec.prevHash, first.body.record.hash);
  assert.equal(rec.leadRef.length, 16);
  assert.equal(rec.decision.length, 20);
  assert.equal(rec.promptVersion.length, 40);
  assert.equal(rec.actor, 'demo reviewer');
  assert.deepEqual(await verifyChain([first.body.record, rec]), { ok: true });
});

test('/api/audit append: only reviewer actions are allowed; missing prev starts at GENESIS', async () => {
  const { env: e } = env();
  for (const action of ['triaged', 'deleted', undefined])
    assert.deepEqual(await call(auditPost, post({ op: 'append', entry: { action } }), e).then((r) => [r.status, r.body]), [400, { error: 'bad_action' }], String(action));
  for (const action of ['approved', 'edited_and_sent', 'rejected']) {
    const r = await call(auditPost, post({ op: 'append', entry: { action } }), e);
    assert.equal(r.body.record.seq, 1, action);
    assert.equal(r.body.record.prevHash, GENESIS, action);
  }
});

test('/api/audit verify: detects tampering, tolerates junk, caps at 500 records', async () => {
  const { env: e } = env();
  const a = (await call(triagePost, post({ message: 'When are you open?' }), e)).body.record;
  const b = (await call(auditPost, post({ op: 'append', prev: a, entry: { action: 'approved' } }), e)).body.record;
  assert.deepEqual((await call(auditPost, post({ op: 'verify', records: [a, b] }), e)).body, { ok: true });
  assert.deepEqual((await call(auditPost, post({ op: 'verify', records: [a, { ...b, action: 'rejected' }] }), e)).body, { ok: false, brokenAt: 2 });
  assert.deepEqual((await call(auditPost, post({ op: 'verify', records: 'nope' }), e)).body, { ok: true }); // not an array → empty chain
  assert.deepEqual((await call(auditPost, post({ op: 'verify', records: [42] }), e)).body, { ok: false, brokenAt: 1 });
  // 500 valid records plus a junk #501: only the first 500 are checked.
  const many: any[] = [];
  let prev: any = null;
  for (let i = 0; i < 500; i++) { prev = await appendRecord(prev, { at: 't', leadRef: 'l', decision: 'd', checks: [], models: {}, promptVersion: 'p', actor: 'a', action: 'approved' }); many.push(prev); }
  assert.deepEqual((await call(auditPost, post({ op: 'verify', records: [...many, null] }), e)).body, { ok: true });
  assert.deepEqual((await call(auditPost, post({ op: 'verify', records: [...many.slice(0, 499), null] }), e)).body, { ok: false, brokenAt: 500 });
});

test('/api/audit: unknown op and bad JSON are 400', async () => {
  const { env: e } = env();
  assert.deepEqual(await call(auditPost, post({ op: 'drop' }), e).then((r) => [r.status, r.body]), [400, { error: 'bad_op' }]);
  assert.deepEqual(await call(auditPost, post('nope'), e).then((r) => [r.status, r.body]), [400, { error: 'bad_json' }]);
});

bug('/api/audit append trusts prev.seq from the client: a string seq "5" yields seq "51"', async () => {
  const { env: e } = env();
  const r = await call(auditPost, post({ op: 'append', prev: { hash: 'f'.repeat(64), seq: '5' }, entry: { action: 'approved' } }), e);
  // Either reject the malformed prev or produce a numeric next seq.
  assert.ok(r.status === 400 || r.body.record.seq === 6, JSON.stringify(r.body));
});
