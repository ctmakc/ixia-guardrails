import type { ModelClient } from '../../src/types';

// Scripted ModelClient: no network, no keys. Every call is recorded so a test
// can assert what reached the models.
export interface FakeOpts {
  draft?: object | string;
  verifier?: object | string;
  guard?: string;
  failDraft?: boolean;
  failVerifier?: boolean;
  failGuard?: boolean;
  failEmbed?: boolean;
  embed?: (texts: string[]) => number[][];
}

export interface Calls { chat: { model: string; messages: { role: string; content: string }[] }[]; embed: string[][]; guard: number }

export const PASSING_VERIFIER = { unsupported_claims: [], gives_specific_advice: false, promises_outcome: false, repeats_sensitive: false, note: '' };

export function fakeLlm(o: FakeOpts = {}): ModelClient & { calls: Calls } {
  const calls: Calls = { chat: [], embed: [], guard: 0 };
  return {
    calls,
    async chat(model, messages) {
      calls.chat.push({ model, messages });
      if (model.includes('gpt-oss')) {
        if (o.failVerifier) throw new Error('verifier down');
        const v = o.verifier ?? PASSING_VERIFIER;
        return typeof v === 'string' ? v : JSON.stringify(v);
      }
      if (o.failDraft) throw new Error('model down');
      const d = o.draft ?? '';
      return typeof d === 'string' ? d : JSON.stringify(d);
    },
    async embed(_m, texts) {
      calls.embed.push(texts);
      if (o.failEmbed) throw new Error('embed down');
      return o.embed ? o.embed(texts) : texts.map(() => [1, 1, 1]);
    },
    async guard() {
      calls.guard++;
      if (o.failGuard) throw new Error('guard down');
      return o.guard ?? 'safe';
    },
  };
}

export const draftJson = (reply: string, extra: object = {}) =>
  ({ lang: 'en', matter_type: 'fees', urgency: 'low', summary: 's', reply, citations: ['consult'], sensitive_data: [], ...extra });
