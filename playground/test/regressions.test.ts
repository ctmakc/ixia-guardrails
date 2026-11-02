// One test per playground bug fixed on this branch. Each failed before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeBudget, visitorKey, isAuditRecord } from '../functions/_lib/util';
import { onRequestPost as audit } from '../functions/api/audit';
import { onRequestPost as triage } from '../functions/api/triage';
import { appendRecord } from '../../packages/guard/src/audit';
import { env, fakeKv, post, ctx } from './helpers';

const day = () => new Date().toISOString().slice(0, 10);

test('fix: a malformed limit falls back to the default instead of disabling the cap', async () => {
  for (const PER_IP_PER_DAY of ['twenty-five', '', ' ', '-1', 'NaN']) {
    const kv = fakeKv();
    kv.data.set(`ip:${day()}:1.2.3.4`, '25');
    assert.deepEqual(await takeBudget(env({ PER_IP_PER_DAY }, kv), '1.2.3.4'), { ok: false, reason: 'per_visitor_budget' }, PER_IP_PER_DAY);
  }
  const kv = fakeKv();
  kv.data.set(`g:${day()}`, '120');
  assert.deepEqual(await takeBudget(env({ DAILY_LIVE_RUNS: 'lots' }, kv), '1.2.3.4'), { ok: false, reason: 'daily_budget' });
  assert.equal((await takeBudget(env({ PER_IP_PER_DAY: '0' }), '1.2.3.4')).ok, false); // an explicit 0 still means closed
});

test('fix: IPv6 visitors share one bucket per /64', async () => {
  assert.equal(visitorKey('2001:db8:abcd:12:1:2:3:4'), visitorKey('2001:db8:abcd:12::99'));
  assert.equal(visitorKey('2001:DB8:ABCD:0012:ffff::1'), '2001:db8:abcd:12::/64');
  assert.notEqual(visitorKey('2001:db8:abcd:12::1'), visitorKey('2001:db8:abcd:13::1'));
  assert.equal(visitorKey('203.0.113.7'), '203.0.113.7');
  assert.equal(visitorKey('::ffff:198.51.100.4'), '198.51.100.4');
  const e = env({ PER_IP_PER_DAY: '2' });
  assert.equal((await takeBudget(e, '2001:db8::1')).ok, true);
  assert.equal((await takeBudget(e, '2001:db8::2')).ok, true);
  assert.deepEqual(await takeBudget(e, '2001:db8::3'), { ok: false, reason: 'per_visitor_budget' });
});

const rec = (seq = 1) => appendRecord(null, { at: 'now', leadRef: 'r', decision: 'block', checks: [], models: {}, promptVersion: 'v', actor: 'a', action: 'approved' })
  .then((r) => ({ ...r, seq }));

test('fix: verify with malformed records answers instead of throwing', async () => {
  const good = await rec();
  for (const records of [[{ seq: 1, prevHash: '0'.repeat(64), hash: 'x' }], [null], [{ ...good, checks: undefined }], [{ ...good, models: null }]]) {
    const r = await audit(ctx(post('/api/audit', { op: 'verify', records }), env()));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: false, brokenAt: 1 }, JSON.stringify(records));
  }
});

test('fix: append rejects a malformed prev instead of corrupting seq', async () => {
  const bad = await audit(ctx(post('/api/audit', { op: 'append', prev: { hash: 'x', seq: '5' }, entry: { action: 'approved' } }), env()));
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'bad_prev' });
  const prev = await rec(5);
  const ok: any = await (await audit(ctx(post('/api/audit', { op: 'append', prev, entry: { action: 'approved' } }), env()))).json();
  assert.equal(ok.record.seq, 6);
  assert.ok(isAuditRecord(ok.record));
});

test('fix: triage ignores a malformed prev and starts a fresh chain', async () => {
  const r: any = await (await triage(ctx(post('/api/triage', { message: 'What are your office hours?', prev: { hash: 'x', seq: '5' } }), env()))).json();
  assert.equal(r.record.seq, 1);
});
