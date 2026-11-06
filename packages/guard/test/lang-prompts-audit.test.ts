// Language detection, templates, prompt builders, JSON parsing, audit chain.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectLang, normalizeLang, fill, SAFE_ACK, AI_DISCLOSURE, GREETING_NAMED, GREETING_ANON } from '../src/lang';
import { draftMessages, verifierMessages, parseJson } from '../src/prompts';
import { appendRecord, verifyChain, sha256, GENESIS, type AuditRecord } from '../src/audit';
import { DEMO_WORKSPACE } from '../src/demo-workspace';

describe('detectLang', () => {
  const cases: [string, string][] = [
    ['Hello, what are your office hours?', 'en'],
    ['Goedemiddag, ik heb een vraag over mijn contract', 'nl'],
    ['Guten Tag, ich habe eine Frage zu meinem Vertrag', 'de'],
    ['Bonjour, je voudrais un rendez-vous pour mon contrat', 'fr'],
    ['Hola, necesito ayuda con mi contrato', 'es'],
    ['Добрий день, скільки коштує консультація?', 'uk'],
  ];
  for (const [t, l] of cases) test(`${l}: ${t}`, () => assert.equal(detectLang(t), l));
  test('no stopwords → English fallback', () => {
    assert.equal(detectLang('Prijs?'), 'en');
    assert.equal(detectLang(''), 'en');
  });
  test('Spanish punctuation tips a short message to Spanish', () => assert.equal(detectLang('¿Precio?'), 'es'));
  test('German umlaut tips a short message to German', () => assert.equal(detectLang('Gebühr für Prüfung'), 'de'));
  test('mostly Latin text with a Cyrillic word stays Latin', () => assert.equal(detectLang('Hello, my name is Олег and I need help with the contract'), 'en'));
});

describe('normalizeLang', () => {
  test('keeps supported codes, trims regions and case', () => {
    assert.equal(normalizeLang('NL', 'en'), 'nl');
    assert.equal(normalizeLang('fr-BE', 'en'), 'fr');
    assert.equal(normalizeLang('uk_UA', 'en'), 'uk');
  });
  test('unsupported or empty → fallback', () => {
    assert.equal(normalizeLang('pt', 'de'), 'de');
    assert.equal(normalizeLang(undefined, 'es'), 'es');
    assert.equal(normalizeLang('', 'nl'), 'nl');
  });
});

describe('templates', () => {
  test('fill substitutes known keys and blanks unknown ones', () => {
    assert.equal(fill('Hi {first}, {missing}within {sla} min', { first: 'Ann', sla: 30 }), 'Hi Ann, within 30 min');
  });
  test('every language has every template, with the placeholders the pipeline fills', () => {
    for (const l of ['en', 'nl', 'de', 'fr', 'es', 'uk'] as const) {
      assert.match(SAFE_ACK[l], /\{greeting\}/); assert.match(SAFE_ACK[l], /\{firm\}/); assert.match(SAFE_ACK[l], /\{sla\}/);
      assert.match(AI_DISCLOSURE[l], /\{firm\}/);
      assert.match(GREETING_NAMED[l], /\{first\}/);
      assert.doesNotMatch(GREETING_ANON[l], /\{/);
    }
  });
});

describe('prompt builders', () => {
  const kb = DEMO_WORKSPACE.kb.slice(0, 2);
  test('draft prompt lists KB facts with ids, language hint, SLA and booking link; user turn fences the enquiry', () => {
    const [sys, user] = draftMessages(DEMO_WORKSPACE, { name: 'Emma', message: 'Hi', channel: 'chat' }, kb, 'nl');
    assert.equal(sys.role, 'system'); assert.equal(user.role, 'user');
    assert.match(sys.content, /\[areas\] Practice areas:/);
    assert.match(sys.content, /\[consult\] First consultation:/);
    assert.match(sys.content, /detected: nl/);
    assert.match(sys.content, /within 30 minutes/);
    assert.match(sys.content, /book: https:\/\/cal\.example\.com\/demo-law/);
    assert.equal(user.content, 'Channel: chat\nFrom: Emma\nMessage:\n<<<\nHi\n>>>');
  });
  test('empty KB and missing booking/name/channel are rendered explicitly', () => {
    const ws = { ...DEMO_WORKSPACE, bookingUrl: undefined };
    const [sys, user] = draftMessages(ws, { message: 'x' }, [], 'en');
    assert.match(sys.content, /KNOWLEDGE:\n\(empty\)/);
    assert.doesNotMatch(sys.content, /invite them to book/);
    assert.match(user.content, /^Channel: form\nFrom: unknown\n/);
  });
  test('verifier prompt carries KB, enquiry and draft', () => {
    const [, user] = verifierMessages(DEMO_WORKSPACE, { message: 'What does it cost?' }, 'EUR 150.', kb);
    assert.match(user.content, /KNOWLEDGE:\n\[areas\]/);
    assert.match(user.content, /ENQUIRY from unknown:\n<<<\nWhat does it cost\?\n>>>/);
    assert.match(user.content, /DRAFT:\n<<<\nEUR 150\.\n>>>$/);
  });
});

describe('parseJson', () => {
  test('extracts the JSON object from prose or code fences', () => {
    assert.deepEqual(parseJson('Sure! ```json\n{"a":1,"b":{"c":2}}\n``` done'), { a: 1, b: { c: 2 } });
  });
  test('returns null for empty, missing or malformed objects', () => {
    assert.equal(parseJson(''), null);
    assert.equal(parseJson('no json here'), null);
    assert.equal(parseJson('} {'), null);
    assert.equal(parseJson('{"a":'), null);
  });
  test('prose with braces after the object makes it unparseable (the pipeline then holds the draft)', () => {
    assert.equal(parseJson('{"a":1} see {note}'), null);
  });
});

describe('audit chain', () => {
  const entry = (action: string, models: Record<string, string> = { draft: 'm1', safety: 'm2' }) => ({
    at: '2026-10-17T10:00:00Z', leadRef: 'abc', decision: 'hold_for_review', checks: [{ id: 'x', status: 'review' }],
    models, promptVersion: 'v', actor: 'ixia-guard', action });
  async function build(n: number) {
    const out: AuditRecord[] = []; let prev: AuditRecord | null = null;
    for (let i = 0; i < n; i++) { prev = await appendRecord(prev, entry(i ? 'approved' : 'triaged')); out.push(prev); }
    return out;
  }

  test('sha256 matches the known test vector', async () => {
    assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  test('first record starts at seq 1 on the genesis hash; later ones link to the previous hash', async () => {
    const c = await build(3);
    assert.deepEqual(c.map((r) => r.seq), [1, 2, 3]);
    assert.equal(c[0].prevHash, GENESIS);
    assert.equal(c[1].prevHash, c[0].hash);
    assert.match(c[2].hash, /^[0-9a-f]{64}$/);
  });
  test('hashing is deterministic and independent of model-map key order', async () => {
    const a = await appendRecord(null, entry('triaged', { draft: 'm1', safety: 'm2' }));
    const b = await appendRecord(null, entry('triaged', { safety: 'm2', draft: 'm1' }));
    assert.equal(a.hash, b.hash);
  });
  test('empty chain verifies', async () => assert.deepEqual(await verifyChain([]), { ok: true }));
  test('deleting a middle record breaks verification at the next one', async () => {
    const c = await build(3);
    assert.deepEqual(await verifyChain([c[0], c[2]]), { ok: false, brokenAt: 3 });
  });
  test('reordering breaks verification', async () => {
    const c = await build(2);
    assert.deepEqual(await verifyChain([c[1], c[0]]), { ok: false, brokenAt: 2 });
  });
  test('editing the last record\'s action or its hash is detected', async () => {
    const c = await build(2);
    assert.deepEqual(await verifyChain([c[0], { ...c[1], action: 'rejected' }]), { ok: false, brokenAt: 2 });
    assert.deepEqual(await verifyChain([c[0], { ...c[1], hash: 'f'.repeat(64) }]), { ok: false, brokenAt: 2 });
  });
  test('a chain that does not start at genesis is rejected', async () => {
    const c = await build(2);
    assert.deepEqual(await verifyChain([c[1]]), { ok: false, brokenAt: 2 });
  });
});
