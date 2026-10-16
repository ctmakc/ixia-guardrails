import { appendRecord, verifyChain, type AuditRecord } from '../../../packages/guard/src/index';
import { json, type Env } from '../_lib/util';

// POST {op:"append", prev, entry} → next record (reviewer actions in the demo queue)
// POST {op:"verify", records}     → {ok, brokenAt}
export const onRequestPost: PagesFunction<Env> = async ({ request }) => {
  let b: any;
  try { b = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  if (b?.op === 'verify') {
    const recs: AuditRecord[] = Array.isArray(b.records) ? b.records.slice(0, 500) : [];
    return json(await verifyChain(recs));
  }
  if (b?.op === 'append') {
    const e = b.entry || {};
    const allowed = ['approved', 'edited_and_sent', 'rejected'];
    if (!allowed.includes(e.action)) return json({ error: 'bad_action' }, 400);
    const rec = await appendRecord(b.prev?.hash ? b.prev : null, {
      at: new Date().toISOString(),
      leadRef: String(e.leadRef || '').slice(0, 16),
      decision: String(e.decision || '').slice(0, 20),
      checks: [],
      models: {},
      promptVersion: String(e.promptVersion || '').slice(0, 40),
      actor: 'demo reviewer',
      action: e.action,
    });
    return json({ record: rec });
  }
  return json({ error: 'bad_op' }, 400);
};
