import { triage, bindingClient, appendRecord, sha256, type AuditRecord } from '../../../packages/guard/src/index';
import { DEMO_WORKSPACE } from '../../../packages/guard/src/demo-workspace';
import { json, takeBudget, type Env } from '../_lib/util';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const message = String(body?.message || '').trim().slice(0, 2000);
  const name = String(body?.name || '').trim().slice(0, 80);
  if (message.length < 3) return json({ error: 'message_required' }, 400);

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const budget = await takeBudget(env, ip);
  if (!budget.ok) return json({ error: budget.reason }, 429);

  const t0 = Date.now();
  const result = await triage(bindingClient(env.AI), DEMO_WORKSPACE, { name, message, channel: 'form' });
  const prev: AuditRecord | null = body?.prev && typeof body.prev.hash === 'string' ? body.prev : null;
  const record = await appendRecord(prev, {
    at: result.createdAt,
    leadRef: (await sha256(`${name}\n${message}`)).slice(0, 16),
    decision: result.decision,
    checks: result.checks.map((c) => ({ id: c.id, status: c.status })),
    models: result.models,
    promptVersion: result.promptVersion,
    actor: 'ixia-guard',
    action: 'triaged',
  });
  const { raw, ...draft } = result.draft;
  return json({ result: { ...result, draft }, record, totalMs: Date.now() - t0, liveRunsLeftToday: budget.left });
};
