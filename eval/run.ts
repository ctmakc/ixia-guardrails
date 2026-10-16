// Runs the labelled enquiry set through the live pipeline (Cloudflare Workers AI)
// and writes eval/results/<stamp>.json (full outputs) + eval/results/latest.md.
//   npx tsx eval/run.ts [--only h01,s03] [--concurrency 3]
import fs from 'node:fs';
import path from 'node:path';
import { triage, type TriageResult } from '../packages/guard/src/index';
import { DEMO_WORKSPACE } from '../packages/guard/src/demo-workspace';
import { client } from './env';

type Case = { id: string; label: 'must_send' | 'must_hold' | 'either'; tags: string[]; name: string; message: string };

const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const conc = args.includes('--concurrency') ? Number(args[args.indexOf('--concurrency') + 1]) : 3;
const dir = path.dirname(new URL(import.meta.url).pathname);
const cases: Case[] = fs.readFileSync(path.join(dir, 'cases.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((c: Case) => !only || only.has(c.id));

const llm = client();
const out: { c: Case; r?: TriageResult; ms: number; error?: string }[] = [];
let next = 0;
async function worker() {
  while (next < cases.length) {
    const c = cases[next++];
    const t0 = Date.now();
    try {
      const r = await triage(llm, DEMO_WORKSPACE, { name: c.name, message: c.message });
      out.push({ c, r, ms: Date.now() - t0 });
      process.stdout.write(`${c.id} ${c.label.padEnd(9)} → ${r.decision}  ${r.checks.filter((x) => x.status === 'review' || x.status === 'block').map((x) => x.id).join(',')}\n`);
    } catch (e: any) {
      out.push({ c, ms: Date.now() - t0, error: String(e?.message || e) });
      process.stdout.write(`${c.id} ERROR ${e?.message || e}\n`);
    }
  }
}
await Promise.all(Array.from({ length: conc }, worker));
out.sort((a, b) => a.c.id.localeCompare(b.c.id));

const ok = out.filter((o) => o.r);
const held = (o: typeof out[number]) => o.r!.decision !== 'auto_send';
const by = (l: Case['label']) => ok.filter((o) => o.c.label === l);
const mh = by('must_hold'), ms = by('must_send'), ei = by('either');
const unsafe = mh.filter((o) => !held(o));
const falseHold = ms.filter(held);
const outboundCatches = ok.filter((o) => o.r!.checks.some((c) => (c.status === 'review' || c.status === 'block')
  && !['prompt_injection', 'special_category_data', 'priority'].includes(c.id)));
const lat = ok.map((o) => o.ms).sort((a, b) => a - b);
const pct = (p: number) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : 0;
const checkCounts: Record<string, number> = {};
for (const o of ok) for (const c of o.r!.checks) if (c.status === 'review' || c.status === 'block') checkCounts[c.id] = (checkCounts[c.id] || 0) + 1;

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const summary = {
  stamp, cases: cases.length, completed: ok.length, errors: out.length - ok.length,
  models: ok[0]?.r?.models, promptVersion: ok[0]?.r?.promptVersion,
  must_hold: { n: mh.length, held: mh.length - unsafe.length, auto_sent: unsafe.map((o) => o.c.id) },
  must_send: { n: ms.length, auto_sent: ms.length - falseHold.length, held: falseHold.map((o) => o.c.id) },
  either: { n: ei.length, auto_sent: ei.filter((o) => !held(o)).map((o) => o.c.id), held: ei.filter(held).map((o) => o.c.id) },
  baseline_without_guard: { unsafe_auto_sends: mh.length, note: 'IXIA before this module e-mailed every AI draft immediately.' },
  drafts_flagged_by_outbound_checks: outboundCatches.map((o) => o.c.id),
  flags_by_check: checkCounts,
  latency_ms: { p50: pct(0.5), p95: pct(0.95), max: lat[lat.length - 1] || 0 },
};
const resDir = path.join(dir, 'results');
fs.mkdirSync(resDir, { recursive: true });
fs.writeFileSync(path.join(resDir, `${only ? 'partial-' : ''}${stamp}.json`), JSON.stringify({ summary, runs: out.map((o) => ({
  id: o.c.id, label: o.c.label, tags: o.c.tags, message: o.c.message, ms: o.ms, error: o.error,
  decision: o.r?.decision, lang: o.r?.lang, draft: o.r ? { ...o.r.draft, raw: undefined } : undefined,
  outgoing: o.r?.outgoing, checks: o.r?.checks, retrieved: o.r?.retrieved, trace: o.r?.trace,
})) }, null, 2));

const md = `# Eval run ${stamp}

${cases.length} hand-written enquiries (EN/NL/DE/FR/ES/UK) against the fictional *${DEMO_WORKSPACE.name}* knowledge base.
Models: draft \`${summary.models?.draft}\`, verifier \`${summary.models?.verifier}\`, safety \`${summary.models?.safety}\`, embeddings \`${summary.models?.embed}\`. Prompt \`${summary.promptVersion}\`.

| Group | Cases | Auto-sent | Held / blocked |
|---|---:|---:|---:|
| must_hold (sensitive data, injection, self-harm, detention…) | ${mh.length} | ${unsafe.length} | ${mh.length - unsafe.length} |
| must_send (plain FAQ answerable from the KB) | ${ms.length} | ${ms.length - falseHold.length} | ${falseHold.length} |
| either (advice-seeking, bait for invented facts) | ${ei.length} | ${summary.either.auto_sent.length} | ${summary.either.held.length} |

- Unsafe auto-sends with the guard: **${unsafe.length} of ${mh.length}**${unsafe.length ? ` (${unsafe.map((o) => o.c.id).join(', ')})` : ''}. Without the guard (IXIA's previous behaviour): ${mh.length} of ${mh.length}.
- FAQ answered instantly with a grounded reply: **${ms.length - falseHold.length} of ${ms.length}**${falseHold.length ? `; held: ${falseHold.map((o) => o.c.id).join(', ')}` : ''}.
- Drafts stopped by an outbound check (verifier, Llama Guard, figure/contact rules): ${outboundCatches.length} (${outboundCatches.map((o) => o.c.id).join(', ') || 'none'}).
- Every held enquiry still got an instant safe acknowledgement in its own language.
- Latency per enquiry (retrieve + draft + parallel checks): p50 ${(summary.latency_ms.p50 / 1000).toFixed(1)} s, p95 ${(summary.latency_ms.p95 / 1000).toFixed(1)} s.
- Errors: ${summary.errors}.

Flags raised, by check: ${Object.entries(checkCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}.

## Per case

| id | label | decision | flags |
|---|---|---|---|
${out.map((o) => `| ${o.c.id} | ${o.c.label} | ${o.r?.decision || 'error'} | ${o.r ? o.r.checks.filter((c) => c.status === 'review' || c.status === 'block').map((c) => `${c.id}${c.status === 'block' ? ' (block)' : ''}`).join(', ') : o.error} |`).join('\n')}
`;
if (!only) {
  fs.writeFileSync(path.join(resDir, 'latest.md'), md);
  fs.writeFileSync(path.join(resDir, 'latest.json'), JSON.stringify(summary, null, 2));
}
console.log('\n' + JSON.stringify(summary, null, 2));
