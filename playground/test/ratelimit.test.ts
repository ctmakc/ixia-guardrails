import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeBudget } from '../functions/_lib/util';
import { env, fakeKv } from './helpers';

const day = () => new Date().toISOString().slice(0, 10);

test('per-visitor cap: the 26th run from one IP in a day is refused', async () => {
  const kv = fakeKv();
  const e = env({}, kv);
  for (let i = 0; i < 25; i++) assert.equal((await takeBudget(e, '203.0.113.7')).ok, true, `run ${i + 1}`);
  assert.deepEqual(await takeBudget(e, '203.0.113.7'), { ok: false, reason: 'per_visitor_budget' });
  assert.equal((await takeBudget(e, '203.0.113.8')).ok, true); // another visitor is unaffected
});

test('global daily cap applies across visitors and reports what is left', async () => {
  const e = env({ DAILY_LIVE_RUNS: '3', PER_IP_PER_DAY: '10' });
  assert.deepEqual(await takeBudget(e, '1.1.1.1'), { ok: true, left: 2 });
  assert.deepEqual(await takeBudget(e, '2.2.2.2'), { ok: true, left: 1 });
  assert.deepEqual(await takeBudget(e, '3.3.3.3'), { ok: true, left: 0 });
  assert.deepEqual(await takeBudget(e, '4.4.4.4'), { ok: false, reason: 'daily_budget' });
});

test('counters are keyed by UTC day and expire after two days', async () => {
  const kv = fakeKv();
  await takeBudget(env({}, kv), '198.51.100.1');
  assert.equal(kv.data.get(`g:${day()}`), '1');
  assert.equal(kv.data.get(`ip:${day()}:198.51.100.1`), '1');
  assert.ok(kv.puts.every((p) => p.opts?.expirationTtl === 172800));
});

test('a refused run does not consume budget', async () => {
  const kv = fakeKv();
  const e = env({ DAILY_LIVE_RUNS: '5', PER_IP_PER_DAY: '1' }, kv);
  await takeBudget(e, '9.9.9.9');
  await takeBudget(e, '9.9.9.9');
  await takeBudget(e, '9.9.9.9');
  assert.equal(kv.data.get(`g:${day()}`), '1');
});

test('defaults: 120 per day globally, 25 per visitor', async () => {
  const kv = fakeKv();
  kv.data.set(`g:${day()}`, '119');
  assert.deepEqual(await takeBudget(env({}, kv), '5.5.5.5'), { ok: true, left: 0 });
  assert.deepEqual(await takeBudget(env({}, kv), '5.5.5.6'), { ok: false, reason: 'daily_budget' });
});
