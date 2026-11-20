// Language detection, templates, prompt builders and the tolerant JSON parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLang, normalizeLang, fill, AI_DISCLOSURE, SAFE_ACK, GREETING_NAMED, GREETING_ANON } from '../src/lang';
import { draftMessages, verifierMessages, parseJson, PROMPT_VERSION } from '../src/prompts';
import { DEMO_WORKSPACE } from '../src/demo-workspace';
import type { Lang, Workspace } from '../src/types';

const LANGS: Lang[] = ['en', 'nl', 'de', 'fr', 'es', 'uk'];

test('detectLang: typical first-contact sentences in the six languages', () => {
  const cases: [string, Lang][] = [
    ['Hello, can you help me with my contract?', 'en'],
    ['Goedemiddag, ik heb een vraag over mijn ontslag.', 'nl'],
    ['Guten Tag, ich habe eine Frage zu meinem Vertrag.', 'de'],
    ['Bonjour, je voudrais savoir comment prendre rendez-vous.', 'fr'],
    ['Hola, ¿cuánto cuesta una consulta?', 'es'],
    ['Доброго дня, мені потрібна консультація', 'uk'],
  ];
  for (const [t, want] of cases) assert.equal(detectLang(t), want, t);
});

test('detectLang: empty, one-word and non-alphabetic input falls back to English', () => {
  for (const t of ['', 'Prijs?', '???', '12345', undefined as any]) assert.equal(detectLang(t), 'en', String(t));
});

test('detectLang: Cyrillic wins only when it outweighs Latin letters', () => {
  assert.equal(detectLang('Привіт, I need help with my employment contract please'), 'en');
  assert.equal(detectLang('Мене звільнили з роботи, що робити? (HR)'), 'uk');
});

test('normalizeLang: two-letter prefix, case-insensitive, unknown → fallback', () => {
  assert.equal(normalizeLang('NL', 'en'), 'nl');
  assert.equal(normalizeLang('de-AT', 'en'), 'de');
  assert.equal(normalizeLang('uk_UA', 'en'), 'uk');
  assert.equal(normalizeLang('pt', 'fr'), 'fr');
  assert.equal(normalizeLang('', 'es'), 'es');
  assert.equal(normalizeLang(undefined, 'nl'), 'nl');
});

test('fill: replaces known placeholders, blanks unknown ones, keeps numbers', () => {
  assert.equal(fill('{a} and {b} in {n} min, {missing}!', { a: 'X', b: 'Y', n: 30 }), 'X and Y in 30 min, !');
  assert.equal(fill('no placeholders', {}), 'no placeholders');
  assert.equal(fill('{n}', { n: 0 }), '0');
});

test('templates: every language has a disclosure, acknowledgement and both greetings with the right placeholders', () => {
  for (const l of LANGS) {
    assert.match(AI_DISCLOSURE[l], /\{firm\}/, `disclosure ${l}`);
    for (const ph of ['{greeting}', '{firm}', '{sla}']) assert.ok(SAFE_ACK[l].includes(ph), `ack ${l} ${ph}`);
    assert.match(GREETING_NAMED[l], /\{first\}/, `named ${l}`);
    assert.doesNotMatch(GREETING_ANON[l], /\{/, `anon ${l}`);
    // A filled acknowledgement leaves no placeholder behind.
    const ack = fill(SAFE_ACK[l], { greeting: fill(GREETING_NAMED[l], { first: 'Ana' }), firm: 'F', sla: 15 });
    assert.doesNotMatch(ack, /\{\w+\}/, `ack filled ${l}`);
    assert.ok(ack.includes('15') && ack.includes('Ana'), `ack values ${l}`);
  }
});

test('draftMessages: system prompt carries firm, KB facts with ids, SLA and language hint; user turn fences the enquiry', () => {
  const kb = DEMO_WORKSPACE.kb.slice(0, 2);
  const [sys, user] = draftMessages(DEMO_WORKSPACE, { name: 'Emma', message: 'What does it cost?', channel: 'chat' }, kb, 'nl');
  assert.equal(sys.role, 'system');
  assert.equal(user.role, 'user');
  assert.ok(sys.content.includes('"Demo Law Amsterdam"'));
  assert.ok(sys.content.includes('[consult] First consultation: The first consultation takes 45 minutes'));
  assert.ok(sys.content.includes('(detected: nl)'));
  assert.ok(sys.content.includes('within 30 minutes'));
  assert.ok(sys.content.includes('invite them to book: https://cal.example.com/demo-law'));
  assert.equal(user.content, 'Channel: chat\nFrom: Emma\nMessage:\n<<<\nWhat does it cost?\n>>>');
});

test('draftMessages: no booking line without a booking URL, "(empty)" without KB, defaults for channel and name', () => {
  const ws: Workspace = { name: 'Bare Firm', businessDesc: '', slaMinutes: 60, kb: [] };
  const [sys, user] = draftMessages(ws, { message: 'hi' }, [], 'en');
  assert.doesNotMatch(sys.content, /invite them to book/);
  assert.match(sys.content, /KNOWLEDGE:\n\(empty\)/);
  assert.match(user.content, /^Channel: form\nFrom: unknown\n/);
});

test('verifierMessages: KB, enquiry and draft are all present and fenced', () => {
  const [sys, user] = verifierMessages(DEMO_WORKSPACE, { message: 'Price?' }, 'It costs EUR 150.', DEMO_WORKSPACE.kb.slice(1, 2));
  assert.match(sys.content, /unsupported_claims/);
  assert.ok(user.content.startsWith('KNOWLEDGE:\n[consult] First consultation:'));
  assert.ok(user.content.includes('ENQUIRY from unknown:\n<<<\nPrice?\n>>>'));
  assert.ok(user.content.endsWith('DRAFT:\n<<<\nIt costs EUR 150.\n>>>'));
});

test('parseJson: strict JSON, JSON wrapped in prose or code fences, and garbage', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJson('Sure! ```json\n{"a":{"b":[1,2]}}\n``` done'), { a: { b: [1, 2] } });
  assert.equal(parseJson(''), null);
  assert.equal(parseJson('no json here'), null);
  assert.equal(parseJson('} backwards {'), null);
  assert.equal(parseJson('{"a":1} and then {oops}'), null); // first "{" to last "}" is not valid JSON → null, never a partial object
  assert.equal(parseJson('{"a": }'), null);
});

test('PROMPT_VERSION is a non-empty versioned id', () => {
  assert.match(PROMPT_VERSION, /^guard-\d{4}-\d{2}-\d{2}\.\d+$/);
});
