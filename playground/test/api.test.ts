// Pages Functions handlers called directly with a fake KV and a fake AI binding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as triage } from '../functions/api/triage';
import { onRequestPost as audit } from '../functions/api/audit';
import { env, fakeAi, fakeKv, post, ctx } from './helpers';

test('triage: bad JSON and too-short messages are rejected before any model call or budget use', async () => {
  const kv = fakeKv(); const ai = fakeAi(); const e = env({}, kv, ai);
  assert.equal((await triage(ctx(post('/api/triage', '{nope'), e))).status, 400);
  const r = await triage(ctx(post('/api/triage', { message: ' a ' }), e));
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'message_required' });
  assert.equal(ai.runs.length, 0);
  assert.equal(kv.puts.length, 0);
});

test('triage: over budget returns 429 and never calls a model', async () => {
  const ai = fakeAi(); const e = env({ PER_IP_PER_DAY: '0' }, fakeKv(), ai);
  const r = await triage(ctx(post('/api/triage', { message: 'What are your office hours?' }, { 'cf-connecting-ip': '203.0.113.9' }), e));
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { error: 'per_visitor_budget' });
  assert.equal(ai.runs.length, 0);
});

test('triage: success returns the decision and an audit record that holds no raw enquiry text', async () => {
  const e = env();
  const r = await triage(ctx(post('/api/triage', { name: 'Emma', message: 'What are your office hours?' }), e));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const b: any = await r.json();
  assert.equal(b.result.decision, 'auto_send');
  assert.equal(b.result.draft.raw, undefined);
  assert.equal(b.record.seq, 1);
  assert.match(b.record.leadRef, /^[0-9a-f]{16}$/);
  assert.doesNotMatch(JSON.stringify(b.record), /office hours|Emma/);
  assert.equal(b.liveRunsLeftToday, 119);
});

test('triage: message is capped at 2000 characters', async () => {
  const ai = fakeAi(); const e = env({}, fakeKv(), ai);
  const r = await triage(ctx(post('/api/triage', { message: 'x'.repeat(5000) }), e));
  const b: any = await r.json();
  assert.ok(b.result.draft.summary.length <= 200);
  assert.equal(r.status, 200);
});

test('audit: rejects unknown ops and actions', async () => {
  const e = env();
  assert.equal((await audit(ctx(post('/api/audit', '{'), e))).status, 400);
  assert.equal((await audit(ctx(post('/api/audit', { op: 'drop' }), e))).status, 400);
  const r = await audit(ctx(post('/api/audit', { op: 'append', entry: { action: 'deleted' } }), e));
  assert.deepEqual(await r.json(), { error: 'bad_action' });
});

test('audit: append chains onto prev and verify accepts the chain', async () => {
  const e = env();
  const a: any = await (await audit(ctx(post('/api/audit', { op: 'append', prev: null, entry: { action: 'approved', leadRef: 'abc', decision: 'hold_for_review' } }), e))).json();
  const b: any = await (await audit(ctx(post('/api/audit', { op: 'append', prev: a.record, entry: { action: 'rejected', leadRef: 'def', decision: 'block' } }), e))).json();
  assert.equal(b.record.seq, 2);
  assert.equal(b.record.prevHash, a.record.hash);
  assert.equal(b.record.actor, 'demo reviewer');
  const v: any = await (await audit(ctx(post('/api/audit', { op: 'verify', records: [a.record, b.record] }), e))).json();
  assert.deepEqual(v, { ok: true });
  const t: any = await (await audit(ctx(post('/api/audit', { op: 'verify', records: [{ ...a.record, decision: 'auto_send' }, b.record] }), e))).json();
  assert.deepEqual(t, { ok: false, brokenAt: 1 });
});
