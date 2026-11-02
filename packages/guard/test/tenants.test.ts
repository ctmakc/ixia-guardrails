// Tenant isolation inside the core: one process serves many workspaces (the
// IXIA server). A workspace's prompt, grounding and checks may only ever use
// its own knowledge base and contact data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triage, type Workspace } from '../src/index';
import { retrieve } from '../src/retrieve';
import { fakeLlm, draftJson } from './helpers/fake-llm';

const A: Workspace = { name: 'Firm A', businessDesc: 'A', slaMinutes: 30, contactEmail: 'a@firm-a.example',
  kb: [{ id: 'fees', title: 'Fees', text: 'A first meeting costs EUR 100.' }] };
const B: Workspace = { name: 'Firm B', businessDesc: 'B', slaMinutes: 60, contactEmail: 'b@firm-b.example', contactPhone: '+32 2 555 01 99',
  kb: [{ id: 'fees', title: 'Fees', text: 'A first meeting costs EUR 250.' }, { id: 'secret', title: 'Partner line', text: 'Partners only: EUR 999 retainer.' }] };

test('the draft prompt of one workspace never contains another workspace\'s KB', async () => {
  const llmB = fakeLlm({ draft: draftJson('x') });
  await triage(llmB, B, { message: 'fees?' });
  const llmA = fakeLlm({ draft: draftJson('A first meeting costs EUR 100.', { citations: ['fees'] }) });
  await triage(llmA, A, { message: 'fees?' });
  const all = llmA.calls.chat.flatMap((c) => c.messages.map((m) => m.content)).join('\n');
  assert.match(all, /EUR 100/);
  assert.doesNotMatch(all, /EUR 250|EUR 999|Firm B|firm-b/);
});

test('another workspace\'s price, e-mail or phone is not grounded for this one', async () => {
  const price = await triage(fakeLlm({ draft: draftJson('A first meeting costs EUR 250.', { citations: ['fees'] }) }), A, { message: 'fees?' });
  assert.equal(price.decision, 'hold_for_review');
  assert.equal(price.checks.find((c) => c.id === 'grounded_numbers')!.status, 'review');

  const mail = await triage(fakeLlm({ draft: draftJson('Write to b@firm-b.example.', { citations: [] }) }), A, { message: 'email?' });
  assert.equal(mail.decision, 'block');

  const phone = await triage(fakeLlm({ draft: draftJson('Call +32 2 555 01 99.', { citations: [] }) }), A, { message: 'phone?' });
  assert.equal(phone.decision, 'block');
});

test('same snippet id in two workspaces: the embedding cache keeps them apart', async () => {
  // Embed returns a vector that encodes the text, so a cache mix-up would be visible in scores.
  const vec = (t: string) => [t.includes('100') ? 1 : 0, t.includes('250') ? 1 : 0, 0.01];
  const llm = fakeLlm({ embed: (texts) => texts.map(vec) });
  const a = await retrieve(llm, 'm', 'EUR 100', A.kb, 4);
  const b = await retrieve(llm, 'm', 'EUR 250', B.kb, 4);
  assert.equal(a.hits[0].snippet.text, A.kb[0].text);
  assert.equal(b.hits[0].snippet.text, B.kb[0].text);
  assert.ok(a.hits[0].score > 0.9 && b.hits[0].score > 0.9);
  assert.ok(a.hits.every((h) => A.kb.includes(h.snippet)));
  assert.ok(b.hits.every((h) => B.kb.includes(h.snippet)));
});

test('retrieval returns only the workspace\'s own snippets, at most k', async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, title: `T${i}`, text: `text ${i}` }));
  const r = await retrieve(fakeLlm(), 'm2', 'q', many, 4);
  assert.equal(r.hits.length, 4);
  assert.deepEqual(await retrieve(fakeLlm(), 'm2', 'q', [], 4), { hits: [], mode: 'dense' });
});

test('lexical fallback ranks by token overlap', async () => {
  const r = await retrieve(fakeLlm({ failEmbed: true }), 'm3', 'office hours please', [
    { id: 'fees', title: 'Fees', text: 'EUR 150' }, { id: 'hours', title: 'Office hours', text: 'Monday to Friday' }], 4);
  assert.equal(r.mode, 'lexical');
  assert.equal(r.hits[0].snippet.id, 'hours');
  assert.equal(r.hits[1].score, 0);
});
