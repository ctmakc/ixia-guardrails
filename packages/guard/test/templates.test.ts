// What the enquirer actually receives. Templates must never carry a price, a
// figure, a contact detail or a promise of their own, and a held draft must
// never leak into the outgoing message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triage, AI_DISCLOSURE, SAFE_ACK, promisesOutcome, type Lang } from '../src/index';
import { GREETING_ANON, GREETING_NAMED, fill } from '../src/lang';
import { draftMessages, verifierMessages, parseJson } from '../src/prompts';
import { DEMO_WORKSPACE } from '../src/demo-workspace';
import { fakeLlm, draftJson } from './helpers/fake-llm';

const LANGS: Lang[] = ['en', 'nl', 'de', 'fr', 'es', 'uk'];

test('static templates contain no figures, prices, contacts or promises', () => {
  for (const l of LANGS) {
    for (const tpl of [SAFE_ACK[l], AI_DISCLOSURE[l], GREETING_ANON[l], GREETING_NAMED[l]]) {
      assert.doesNotMatch(tpl, /\d/, `${l}: ${tpl}`);
      assert.doesNotMatch(tpl, /[€$£%@]|https?:|www\./, `${l}: ${tpl}`);
      assert.equal(promisesOutcome(tpl), false, `${l}: ${tpl}`);
    }
    assert.match(SAFE_ACK[l], /\{sla\}/);
    assert.match(SAFE_ACK[l], /\{firm\}/);
    assert.match(AI_DISCLOSURE[l], /\{firm\}/);
  }
});

test('fill substitutes known keys, blanks unknown ones and never re-expands values', () => {
  assert.equal(fill('{a} {b} {c}', { a: 1, b: '{c}' }), '1 {c} ');
});

test('held enquiries get the safe acknowledgement in their own language; the draft never leaks', async () => {
  const msgs: Record<Lang, string> = {
    en: 'Hello, I need help with my contract please.',
    nl: 'Goedemiddag, ik heb een vraag over mijn contract.',
    de: 'Guten Tag, ich habe eine Frage zu meinem Vertrag, bitte.',
    fr: "Bonjour, j'ai une question sur mon contrat, merci.",
    es: 'Hola, tengo una pregunta sobre mi contrato, gracias.',
    uk: 'Добрий день, маю питання щодо мого договору.',
  };
  for (const l of LANGS) {
    // The draft invents a price, so it is held; the outgoing text must not carry it.
    const r = await triage(fakeLlm({ draft: draftJson('Our fee is EUR 99 and you will certainly succeed.', { lang: l }) }),
      DEMO_WORKSPACE, { message: msgs[l] });
    assert.notEqual(r.decision, 'auto_send', l);
    assert.equal(r.lang, l);
    const expected = fill(SAFE_ACK[l], { greeting: GREETING_ANON[l], firm: DEMO_WORKSPACE.name, sla: DEMO_WORKSPACE.slaMinutes });
    assert.ok(r.outgoing.startsWith(expected), `${l}: ${r.outgoing}`);
    assert.ok(r.outgoing.endsWith(fill(AI_DISCLOSURE[l], { firm: DEMO_WORKSPACE.name })), l);
    assert.doesNotMatch(r.outgoing, /99|succeed/, l);
    assert.ok(!r.outgoing.includes(msgs[l]), `${l}: enquiry echoed`);
    // The only figure in the acknowledgement is the configured SLA.
    assert.deepEqual(r.outgoing.match(/\d+/g), [String(DEMO_WORKSPACE.slaMinutes)], l);
  }
});

test('auto-sent reply is the checked draft plus signature and AI disclosure, nothing else', async () => {
  const reply = 'The first consultation takes 45 minutes and costs EUR 150 excluding VAT.';
  const r = await triage(fakeLlm({ draft: draftJson(reply) }), DEMO_WORKSPACE, { name: 'Emma', message: 'What does a first consultation cost?' });
  assert.equal(r.decision, 'auto_send');
  assert.equal(r.outgoing, `${reply}\n\n— ${DEMO_WORKSPACE.name}\n\n${fill(AI_DISCLOSURE.en, { firm: DEMO_WORKSPACE.name })}`);
});

test('a draft already signed by the firm is not signed twice', async () => {
  const reply = 'Our office hours are Monday to Friday.\n\nDemo Law Amsterdam';
  const r = await triage(fakeLlm({ draft: draftJson(reply, { citations: ['hours'] }) }), DEMO_WORKSPACE, { message: 'What are your office hours?' });
  assert.equal(r.decision, 'auto_send');
  assert.equal(r.outgoing.split(DEMO_WORKSPACE.name).length - 1, 2); // signature + disclosure
});

test('the held greeting uses the first name only', async () => {
  const r = await triage(fakeLlm({ failDraft: true }), DEMO_WORKSPACE, { name: '  Lisa   Jansen ', message: 'Hello, I need help please.' });
  assert.match(r.outgoing, /^Hi Lisa,\n/);
  assert.doesNotMatch(r.outgoing, /Jansen/);
});

test('the SLA in the acknowledgement comes from workspace settings', async () => {
  const ws = { ...DEMO_WORKSPACE, slaMinutes: 15 };
  const r = await triage(fakeLlm({ failDraft: true }), ws, { message: 'Hello, I need help please.' });
  assert.match(r.outgoing, /within 15 minutes/);
});

test('draft prompt carries only the given KB plus the hard rules', () => {
  const [sys, user] = draftMessages(DEMO_WORKSPACE, { message: 'hi', name: 'Ann' }, [DEMO_WORKSPACE.kb[1]], 'en');
  assert.match(sys.content, /\[consult\] First consultation: .*EUR 150/);
  assert.doesNotMatch(sys.content, /EUR 395/);
  assert.match(sys.content, /Never invent prices, deadlines, phone numbers, e-mail addresses or links/);
  assert.match(sys.content, /Never predict or promise an outcome/);
  assert.match(user.content, /From: Ann/);
  assert.match(draftMessages({ ...DEMO_WORKSPACE, kb: [] }, { message: 'hi' }, [], 'en')[0].content, /KNOWLEDGE:\n\(empty\)/);
  assert.match(verifierMessages(DEMO_WORKSPACE, { message: 'hi' }, 'draft', [])[1].content, /KNOWLEDGE:\n\(empty\)/);
});

test('parseJson tolerates prose around the object and rejects garbage', () => {
  assert.deepEqual(parseJson('Here you go: {"a":1} thanks'), { a: 1 });
  assert.equal(parseJson(''), null);
  assert.equal(parseJson('no json'), null);
  assert.equal(parseJson('{broken'), null);
  assert.equal(parseJson('} {'), null);
});
