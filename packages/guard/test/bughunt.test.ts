// Regression tests for the fail-open and robustness fixes (credits/repo-bughunt-1106-0226).
// Scripted model clients only: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triage, appendRecord, verifyChain, foreignContacts, GENESIS, type ModelClient } from '../src/index';
import { retrieve } from '../src/retrieve';
import { DEMO_WORKSPACE } from '../src/demo-workspace';

const GOOD_VERIFIER = JSON.stringify({ unsupported_claims: [], gives_specific_advice: false, promises_outcome: false, repeats_sensitive: false });
const draft = (sensitive: string[] = []) => JSON.stringify({ lang: 'en', matter_type: 'hours', urgency: 'low', summary: 's',
  reply: 'Our office hours are Monday to Friday, 09:00 to 17:30.', citations: ['hours'], sensitive_data: sensitive });

function client(o: { verifier?: () => Promise<string>; guard?: () => Promise<string>; sensitive?: string[] } = {}): ModelClient {
  return {
    async chat(model) { return model.includes('gpt-oss') ? (o.verifier ? o.verifier() : GOOD_VERIFIER) : draft(o.sensitive); },
    async embed(_m, texts) { return texts.map(() => [1, 1, 1]); },
    async guard() { return o.guard ? o.guard() : 'safe'; },
  };
}
const msg = { message: 'When are you open?' };
const status = (r: Awaited<ReturnType<typeof triage>>, id: string) => r.checks.find((c) => c.id === id)?.status;

test('baseline: clean FAQ still auto-sends', async () => {
  assert.equal((await triage(client(), DEMO_WORKSPACE, msg)).decision, 'auto_send');
});

test('verifier HTTP error whose body is JSON is held, not parsed as a clean verdict', async () => {
  const r = await triage(client({ verifier: async () => { throw new Error('workers-ai /v1/chat/completions 500: {"errors":[{"code":3040}],"success":false}'); } }), DEMO_WORKSPACE, msg);
  assert.equal(r.decision, 'hold_for_review');
  assert.equal(status(r, 'verifier'), 'review');
});

test('verifier answer without the expected fields is held', async () => {
  for (const out of ['{}', '{"note":"looks fine"}', '{"unsupported_claims":"price invented","gives_specific_advice":false,"promises_outcome":false,"repeats_sensitive":false}']) {
    const r = await triage(client({ verifier: async () => out }), DEMO_WORKSPACE, msg);
    assert.equal(r.decision, 'hold_for_review', out);
  }
});

test('Llama Guard: empty or unrecognised output is held, JSON verdicts are honoured', async () => {
  for (const g of ['', 'I cannot classify this.']) {
    const r = await triage(client({ guard: async () => g }), DEMO_WORKSPACE, msg);
    assert.equal(status(r, 'safety_model'), 'review', JSON.stringify(g));
    assert.equal(r.decision, 'hold_for_review');
  }
  assert.equal((await triage(client({ guard: async () => '{"safe":true,"categories":[]}' }), DEMO_WORKSPACE, msg)).decision, 'auto_send');
  assert.equal((await triage(client({ guard: async () => '{"safe":false,"categories":["S1"]}' }), DEMO_WORKSPACE, msg)).decision, 'block');
  assert.equal((await triage(client({ guard: async () => '{"safe":false,"categories":["S6"]}' }), DEMO_WORKSPACE, msg)).decision, 'hold_for_review');
  assert.equal((await triage(client({ guard: async () => { throw new Error('down'); } }), DEMO_WORKSPACE, msg)).decision, 'hold_for_review');
});

test('duplicate sensitive categories from the draft model are listed once', async () => {
  const r = await triage(client({ sensitive: ['health', 'health'] }), DEMO_WORKSPACE, msg);
  const d = r.checks.find((c) => c.id === 'special_category_data')!.detail;
  assert.equal(d.match(/health/g)!.length, 2, d); // once in "Mentions", once in "(… found by the draft model)"
});

test('verifyChain reports malformed records as broken instead of throwing', async () => {
  assert.deepEqual(await verifyChain([null as any]), { ok: false, brokenAt: 1 });
  assert.deepEqual(await verifyChain([{ seq: 1, prevHash: GENESIS, hash: 'x' } as any]), { ok: false, brokenAt: 1 });
  const a = await appendRecord(null, { at: 't', leadRef: 'l', decision: 'auto_send', checks: [], models: {}, promptVersion: 'p', actor: 'x', action: 'triaged' });
  assert.deepEqual(await verifyChain([a]), { ok: true });
});

test('a short embedding batch does not poison the cache', async () => {
  let n = 0;
  const llm: ModelClient = { async chat() { return ''; }, async guard() { return ''; },
    async embed(_m, texts) { n++; return n === 1 ? [[1, 0]] : texts.map(() => [1, 0]); } };
  const kb = [{ id: 'bh-a', title: 'Alpha', text: 'alpha text for the cache test' }];
  assert.equal((await retrieve(llm, 'bh-model', 'alpha', kb)).mode, 'lexical');
  assert.equal((await retrieve(llm, 'bh-model', 'alpha', kb)).mode, 'dense');
});

test('foreignContacts needs an exact e-mail / URL match, not a substring', () => {
  const allowed = 'intake@demo-law.example https://cal.example.com/demo-law';
  assert.deepEqual(foreignContacts('Write to e@demo-law.example', allowed), ['e@demo-law.example']);
  assert.deepEqual(foreignContacts('Book at https://cal.example.com/demo', allowed), ['https://cal.example.com/demo']);
  assert.deepEqual(foreignContacts('Write to intake@demo-law.example or book at https://cal.example.com/demo-law.', allowed), []);
  assert.deepEqual(foreignContacts('Book at https://cal.example.com/demo-law/', allowed), []);
});
