// Shared helpers for the offline test suite. No network: every model call is scripted.
import { test } from 'node:test';
import type { ModelClient } from '../src/index';

// Known bugs are written as tests that assert the CORRECT behaviour and are
// skipped with a "bug: …" reason, so the suite stays green while the bug is
// documented. `RUN_BUGS=1 npm test` runs them (they are expected to fail until fixed).
export function bug(name: string, fn: () => void | Promise<void>) {
  test(`bug: ${name}`, { skip: process.env.RUN_BUGS ? false : `bug: ${name}` }, fn);
}

export const CLEAN_VERDICT = { unsupported_claims: [], gives_specific_advice: false, promises_outcome: false, repeats_sensitive: false };

export interface Calls {
  draft: { messages: any[]; opts: any }[];
  verifier: { messages: any[]; opts: any }[];
  guard: any[][];
  embed: string[][];
}

// Scripted model client that records every call.
export function scripted(o: {
  draft?: object | string | (() => Promise<string>);
  verifier?: object | string | (() => Promise<string>);
  guard?: string | (() => Promise<string>);
  embed?: (texts: string[]) => Promise<number[][]>;
} = {}): { llm: ModelClient; calls: Calls } {
  const calls: Calls = { draft: [], verifier: [], guard: [], embed: [] };
  const out = async (v: any, dflt: any) => {
    if (typeof v === 'function') return v();
    const x = v === undefined ? dflt : v;
    return typeof x === 'string' ? x : JSON.stringify(x);
  };
  const llm: ModelClient = {
    async chat(model, messages, opts) {
      if (model.includes('gpt-oss')) { calls.verifier.push({ messages, opts }); return out(o.verifier, CLEAN_VERDICT); }
      calls.draft.push({ messages, opts });
      return out(o.draft, '');
    },
    async embed(_m, texts) {
      calls.embed.push(texts);
      return o.embed ? o.embed(texts) : texts.map(() => [1, 1, 1]);
    },
    async guard(_m, messages) { calls.guard.push(messages); return out(o.guard, 'safe'); },
  };
  return { llm, calls };
}

export const draftJson = (reply: string, extra: object = {}) =>
  ({ lang: 'en', matter_type: 'fees', urgency: 'low', summary: 's', reply, citations: ['consult'], sensitive_data: [], ...extra });
