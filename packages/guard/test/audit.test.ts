import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendRecord, verifyChain, sha256, GENESIS, type AuditRecord } from '../src/audit';

const entry = (action: string, decision = 'hold_for_review') => ({ at: '2026-10-17T10:00:00Z', leadRef: 'abc', decision,
  checks: [{ id: 'x', status: 'review' }], models: { draft: 'm', safety: 's' }, promptVersion: 'v', actor: 'ixia-guard', action });

async function chainOf(n: number) {
  const out: AuditRecord[] = [];
  let prev: AuditRecord | null = null;
  for (let i = 0; i < n; i++) { prev = await appendRecord(prev, entry(i % 2 ? 'approved' : 'triaged')); out.push(prev); }
  return out;
}

test('sha256 matches the FIPS 180-2 test vector', async () => {
  assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('first record starts at seq 1 on the genesis hash; each record links to the previous', async () => {
  const c = await chainOf(3);
  assert.equal(c[0].seq, 1);
  assert.equal(c[0].prevHash, GENESIS);
  assert.equal(c[1].prevHash, c[0].hash);
  assert.equal(c[2].seq, 3);
  assert.deepEqual(await verifyChain([]), { ok: true });
});

test('model order does not change the hash (canonical form)', async () => {
  const a = await appendRecord(null, { ...entry('triaged'), models: { draft: 'm', safety: 's' } });
  const b = await appendRecord(null, { ...entry('triaged'), models: { safety: 's', draft: 'm' } });
  assert.equal(a.hash, b.hash);
});

test('deleting, reordering or re-hashing a record is detected', async () => {
  const c = await chainOf(4);
  assert.deepEqual(await verifyChain([c[0], c[2], c[3]]), { ok: false, brokenAt: 3 });
  assert.deepEqual(await verifyChain([c[1], c[0]]), { ok: false, brokenAt: 2 });
  const forged = { ...c[1], actor: 'mallory' };
  assert.equal((await verifyChain([c[0], forged, c[2]])).ok, false);
  const checks = { ...c[2], checks: [{ id: 'x', status: 'pass' }] };
  assert.deepEqual(await verifyChain([c[0], c[1], checks]), { ok: false, brokenAt: 3 });
});
