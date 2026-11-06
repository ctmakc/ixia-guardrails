// triage() decision logic and retrieval, with scripted model clients (no network).
import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { triage } from '../src/pipeline';
import { retrieve } from '../src/retrieve';
import { DEMO_WORKSPACE } from '../src/demo-workspace';
import type { ModelClient, KbSnippet, Workspace } from '../src/types';

const VERIFIER_OK = { unsupported_claims: [], gives_specific_advice: false, promises_outcome: false, repeats_sensitive: false };
interface Opts { verifier?: object | string; guard?: string | Error; failEmbed?: boolean; verifierHang?: boolean; calls?: string[] }
function fake(draft: object | string, o: Opts = {}): ModelClient {
  return {
    async chat(model) {
      o.calls?.push(`chat:${model}`);
      if (model.includes('gpt-oss')) {
        if (o.verifierHang) return new Promise<string>(() => {});
        return typeof o.verifier === 'string' ? o.verifier : JSON.stringify(o.verifier ?? VERIFIER_OK);
      }
      return typeof draft === 'string' ? draft : JSON.stringify(draft);
    },
    async embed(m, texts) { o.calls?.push(`embed:${m}`); if (o.failEmbed) throw new Error('down'); return texts.map(() => [1, 1, 1]); },
    async guard(m) { o.calls?.push(`guard:${m}`); if (o.guard instanceof Error) throw o.guard; return o.guard ?? 'safe'; },
  };
}
const ok = (reply: string, extra: object = {}) => ({ lang: 'en', matter_type: 'fees', urgency: 'low', summary: 's', reply, citations: ['consult'], sensitive_data: [], ...extra });
const check = (r: Awaited<ReturnType<typeof triage>>, id: string) => r.checks.find((c) => c.id === id);
const HOURS = 'Our office hours are Monday to Friday.';

describe('triage decisions', () => {
  test('auto_send: reply already signed with the firm name is not signed twice; draft fields are mapped', async () => {
    const r = await triage(fake(ok('Thanks! Demo Law Amsterdam is open Monday to Friday.')), DEMO_WORKSPACE, { message: 'hours?' });
    assert.equal(r.decision, 'auto_send');
    assert.doesNotMatch(r.outgoing, /— Demo Law Amsterdam/);
    assert.equal(r.draft.matterType, 'fees');
    assert.equal(r.draft.urgency, 'low');
    assert.deepEqual(r.draft.citations, ['consult']);
    assert.equal(r.promptVersion.length > 0, true);
  });

  test('anonymous hold uses the anonymous greeting; named hold uses the first name only', async () => {
    const anon = await triage(fake('not json'), DEMO_WORKSPACE, { message: 'What are your office hours?' });
    assert.equal(anon.decision, 'hold_for_review');
    assert.match(anon.outgoing, /^Hello,\n\nThank you for contacting Demo Law Amsterdam/);
    assert.match(anon.outgoing, /within 30 minutes/);
    const named = await triage(fake('not json'), DEMO_WORKSPACE, { name: '  Maria  de Vries ', message: 'What are your office hours?' });
    assert.match(named.outgoing, /^Hi Maria,/);
  });

  test('malformed or empty-reply draft JSON → draft_ok review, outbound checks skipped', async () => {
    for (const d of ['{"reply": "   "}', 'garbage', JSON.stringify({ lang: 'en' })]) {
      const calls: string[] = [];
      const r = await triage(fake(d, { calls }), DEMO_WORKSPACE, { message: 'What are your office hours?' });
      assert.equal(r.decision, 'hold_for_review', d);
      assert.equal(check(r, 'draft_ok')!.status, 'review');
      assert.equal(check(r, 'safety_model'), undefined);
      assert.ok(!calls.some((c) => c.startsWith('guard:')), 'safety model not called');
    }
  });

  test('sensitive category reported only by the draft model is merged and attributed to the model', async () => {
    const r = await triage(fake(ok(HOURS, { sensitive_data: ['health', 'not_a_category'] })), DEMO_WORKSPACE, { message: 'What are your office hours?' });
    const c = check(r, 'special_category_data')!;
    assert.equal(r.decision, 'hold_for_review');
    assert.equal(c.status, 'review');
    assert.equal(c.source, 'verifier');
    assert.match(c.detail, /health found by the draft model/);
    assert.doesNotMatch(c.detail, /not_a_category/);
  });

  test('model-reported category on top of a rule hit keeps source "rule"', async () => {
    const r = await triage(fake(ok(HOURS, { sensitive_data: ['minor'] })), DEMO_WORKSPACE, { message: 'I was arrested yesterday' });
    const c = check(r, 'special_category_data')!;
    assert.equal(c.source, 'rule');
    assert.match(c.detail, /criminal, minor/);
  });

  test('Llama Guard: "unsafe" with only S7 holds; S6+S2 blocks; unspecified unsafe holds; outage holds', async () => {
    const s7 = await triage(fake(ok(HOURS), { guard: 'unsafe\nS7' }), DEMO_WORKSPACE, { message: 'hours?' });
    assert.equal(s7.decision, 'hold_for_review');
    assert.match(check(s7, 'safety_model')!.detail, /S7 privacy/);
    const mixed = await triage(fake(ok(HOURS), { guard: 'unsafe\nS6,S2' }), DEMO_WORKSPACE, { message: 'hours?' });
    assert.equal(mixed.decision, 'block');
    const bare = await triage(fake(ok(HOURS), { guard: 'unsafe' }), DEMO_WORKSPACE, { message: 'hours?' });
    assert.equal(check(bare, 'safety_model')!.status, 'review');
    assert.match(check(bare, 'safety_model')!.detail, /unspecified/);
    const down = await triage(fake(ok(HOURS), { guard: new Error('503') }), DEMO_WORKSPACE, { message: 'hours?' });
    assert.equal(down.decision, 'hold_for_review');
    assert.match(check(down, 'safety_model')!.detail, /unavailable/);
  });

  test('verifier flags map to review/block; malformed verifier output holds', async () => {
    const claims = await triage(fake(ok(HOURS), { verifier: { ...VERIFIER_OK, unsupported_claims: ['open on Sundays', ''] } }), DEMO_WORKSPACE, { message: 'hours?' });
    assert.equal(check(claims, 'unsupported_claims')!.status, 'review');
    assert.equal(check(claims, 'unsupported_claims')!.detail, 'Not in KB: open on Sundays');
    const advice = await triage(fake(ok(HOURS), { verifier: { ...VERIFIER_OK, gives_specific_advice: true, note: 'tells them to resign' } }), DEMO_WORKSPACE, { message: 'hours?' });
    assert.equal(advice.decision, 'hold_for_review');
    assert.equal(check(advice, 'specific_advice')!.detail, 'tells them to resign');
    const promise = await triage(fake(ok(HOURS), { verifier: { ...VERIFIER_OK, promises_outcome: true } }), DEMO_WORKSPACE, { message: 'hours?' });
    assert.equal(promise.decision, 'block');
    assert.equal(check(promise, 'outcome_promise')!.source, 'verifier');
    const echo = await triage(fake(ok(HOURS), { verifier: { ...VERIFIER_OK, repeats_sensitive: true } }), DEMO_WORKSPACE, { message: 'hours?' });
    assert.equal(check(echo, 'repeats_sensitive')!.status, 'review');
    const broken = await triage(fake(ok(HOURS), { verifier: 'I think it is fine' }), DEMO_WORKSPACE, { message: 'hours?' });
    assert.equal(broken.decision, 'hold_for_review');
    assert.equal(check(broken, 'verifier')!.status, 'review');
  });

  test('citation to an unknown KB id holds; citing a KB entry that was not retrieved is still valid', async () => {
    const bad = await triage(fake(ok(HOURS, { citations: ['made_up'] })), DEMO_WORKSPACE, { message: 'hours?' });
    assert.equal(check(bad, 'citations')!.status, 'review');
    const notRetrieved = await triage(fake(ok(HOURS, { citations: ['privacy'] })), DEMO_WORKSPACE, { message: 'hours?' });
    assert.equal(check(notRetrieved, 'citations')!.status, 'pass');
  });

  test('a long reply in a different language than the draft-declared one holds; a short one is tolerated', async () => {
    const long = 'Unsere Bürozeiten sind Montag bis Freitag, wir sind für Sie da und helfen Ihnen gerne mit Ihrer Anfrage.';
    const r = await triage(fake(ok(long, { lang: 'en' })), DEMO_WORKSPACE, { message: 'What are your office hours?' });
    assert.equal(check(r, 'language_match')!.status, 'review');
    const short = await triage(fake(ok('Montag bis Freitag.', { lang: 'en' })), DEMO_WORKSPACE, { message: 'hours?' });
    assert.equal(check(short, 'language_match')!.status, 'pass');
  });

  test('unsupported draft language falls back to the heuristic language', async () => {
    const r = await triage(fake(ok('Montag bis Freitag.', { lang: 'pt' })), DEMO_WORKSPACE, { message: 'Guten Tag, wie sind Ihre Öffnungszeiten?' });
    assert.equal(r.lang, 'de');
    assert.match(r.outgoing, /KI-Assistenten/);
  });

  test('SLA and contact facts are always grounding: firm e-mail, booking link and "30" may be quoted', async () => {
    const r = await triage(fake(ok('Mail intake@demo-law.example or book at https://cal.example.com/demo-law, we reply within 30 minutes.', { citations: ['sla', 'contact'] })),
      DEMO_WORKSPACE, { message: 'How do I reach you?' });
    assert.equal(check(r, 'foreign_contacts')!.status, 'pass');
    assert.equal(check(r, 'citations')!.status, 'pass');
    assert.equal(r.decision, 'auto_send');
  });

  test('urgent wording raises urgency to high (info only, does not hold)', async () => {
    const r = await triage(fake(ok(HOURS)), DEMO_WORKSPACE, { message: 'I have a hearing tomorrow, what are your hours?' });
    assert.equal(r.draft.urgency, 'high');
    assert.equal(check(r, 'priority')!.status, 'info');
    assert.equal(r.decision, 'auto_send');
  });

  test('model-only fields are sanitised: invalid urgency → medium, long fields truncated, citations capped at 8', async () => {
    const r = await triage(fake(ok(HOURS, { urgency: 'extreme', matter_type: 'x'.repeat(100), summary: 'y'.repeat(300), citations: Array(12).fill('hours') })),
      DEMO_WORKSPACE, { message: 'office hours?' });
    assert.equal(r.draft.urgency, 'medium');
    assert.equal(r.draft.matterType.length, 60);
    assert.equal(r.draft.summary.length, 200);
    assert.equal(r.draft.citations.length, 8);
  });

  test('the enquiry is capped at 4000 characters before reaching the model', async () => {
    let seen = '';
    const llm = fake(ok(HOURS));
    const orig = llm.chat;
    llm.chat = async (m, msgs, o) => { if (!m.includes('gpt-oss')) seen = msgs[1].content; return orig(m, msgs, o); };
    await triage(llm, DEMO_WORKSPACE, { message: 'a'.repeat(5000) });
    assert.equal(seen.split('<<<\n')[1].split('\n>>>')[0], 'a'.repeat(4000));
  });

  test('a verifier that never answers holds the draft after the 25 s deadline', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const p = triage(fake(ok(HOURS), { verifierHang: true }), DEMO_WORKSPACE, { message: 'What are your office hours?' });
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      mock.timers.tick(25_000);
      const r = await p;
      assert.equal(r.decision, 'hold_for_review');
      assert.equal(check(r, 'verifier')!.status, 'review');
    } finally { mock.timers.reset(); }
  });

  test('trace records retrieve/draft/safety/verify steps; lexical fallback is noted', async () => {
    const r = await triage(fake(ok(HOURS), { failEmbed: true }), DEMO_WORKSPACE, { message: 'What are your office hours?' });
    assert.deepEqual(r.trace.map((t) => t.step).sort(), ['draft', 'retrieve', 'safety', 'verify']);
    assert.match(r.trace.find((t) => t.step === 'retrieve')!.note!, /lexical/);
    assert.equal(r.retrieved[0].id, 'hours');
  });
});

describe('retrieve', () => {
  const kb: KbSnippet[] = [
    { id: 'a', title: 'Alpha', text: 'apples' },
    { id: 'b', title: 'Beta', text: 'bananas' },
    { id: 'c', title: 'Gamma', text: 'cherries' },
  ];
  const vec: Record<string, number[]> = { 'Alpha. apples': [1, 0], 'Beta. bananas': [0, 1], 'Gamma. cherries': [0.7, 0.7] };

  test('empty KB returns no hits without calling the model', async () => {
    let called = false;
    const r = await retrieve({ embed: async () => { called = true; return []; } } as any, 'm-empty', 'q', []);
    assert.deepEqual(r, { hits: [], mode: 'dense' });
    assert.equal(called, false);
  });

  test('dense: ranks by cosine similarity, top-k, and caches snippet embeddings per model', async () => {
    const batches: string[][] = [];
    const llm = { embed: async (_m: string, texts: string[]) => { batches.push(texts); return texts.map((t) => vec[t] ?? [1, 0.1]); } } as any;
    const r1 = await retrieve(llm, 'm-dense', 'query', kb, 2);
    assert.equal(r1.mode, 'dense');
    assert.deepEqual(r1.hits.map((h) => h.snippet.id), ['a', 'c']);
    const r2 = await retrieve(llm, 'm-dense', 'query 2', kb, 2);
    assert.deepEqual(r2.hits.map((h) => h.snippet.id), ['a', 'c']);
    assert.deepEqual(batches[1], ['query 2'], 'second call embeds only the query');
    await retrieve(llm, 'm-dense-other', 'query', kb, 2);
    assert.equal(batches[2].length, 4, 'another model id re-embeds the KB');
  });

  test('a zero vector does not produce NaN scores', async () => {
    const llm = { embed: async (_m: string, texts: string[]) => texts.map(() => [0, 0]) } as any;
    const r = await retrieve(llm, 'm-zero', 'q', kb, 3);
    assert.ok(r.hits.every((h) => h.score === 0));
  });

  test('lexical fallback on embedding failure: token overlap, words of ≤2 chars ignored', async () => {
    const llm = { embed: async () => { throw new Error('down'); } } as any;
    const r = await retrieve(llm, 'm-lex', 'Do you sell bananas or cherries?', kb, 3);
    assert.equal(r.mode, 'lexical');
    assert.deepEqual(r.hits.slice(0, 2).map((h) => h.snippet.id).sort(), ['b', 'c']);
    assert.equal(r.hits[2].score, 0);
    const none = await retrieve(llm, 'm-lex', 'a b', kb, 1);
    assert.equal(none.hits[0].score, 0);
  });

  test('cross-workspace: an edited snippet text is re-embedded (cache key includes text)', async () => {
    const seen: string[] = [];
    const llm = { embed: async (_m: string, texts: string[]) => { seen.push(...texts); return texts.map(() => [1, 0]); } } as any;
    const ws: Workspace['kb'] = [{ id: 'x', title: 'T', text: 'v1' }];
    await retrieve(llm, 'm-edit', 'q', ws);
    await retrieve(llm, 'm-edit', 'q', [{ id: 'x', title: 'T', text: 'v2' }]);
    assert.ok(seen.includes('T. v2'));
  });
});
