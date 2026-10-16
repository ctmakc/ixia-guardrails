// Copies the newest full eval run into the playground: eval.json (summary) and
// samples.json (recorded results for the sample chips, used when the daily
// live-model budget is exhausted).
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = path.join(root, 'eval/results');
const runs = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.json$/.test(f)).sort();
const latest = JSON.parse(fs.readFileSync(path.join(dir, runs.at(-1)), 'utf8'));
const pub = path.join(root, 'playground/public');
fs.writeFileSync(path.join(pub, 'eval.json'), JSON.stringify(latest.summary, null, 2));
const ids = ['s01', 'h01', 's08', 'h02', 'h04', 'h07', 's06', 'e05', 'h05'];
const samples = {};
for (const r of latest.runs) if (ids.includes(r.id) && r.decision) {
  samples[r.id] = { totalMs: r.ms, result: { decision: r.decision, lang: r.lang, draft: r.draft, outgoing: r.outgoing, checks: r.checks, retrieved: r.retrieved, trace: r.trace, promptVersion: latest.summary.promptVersion, models: latest.summary.models } };
}
fs.writeFileSync(path.join(pub, 'samples.json'), JSON.stringify(samples));
console.log('from', runs.at(-1), '→ eval.json, samples.json', Object.keys(samples).length);
