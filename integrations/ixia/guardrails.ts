import 'server-only';
import { db, uid, now } from '@/db';
import {
  triage, restClient, appendRecord, verifyChain, sha256, AI_DISCLOSURE,
  type AuditRecord, type KbSnippet, type TriageResult, type Workspace as GuardWorkspace, type Lang,
} from '@/lib/guard';

/**
 * IXIA Guardrails: governed first responses. The gate needs Cloudflare
 * Workers AI credentials; without them IXIA keeps its previous single-draft
 * behaviour (lib/ai.ts), so existing installs are unaffected.
 */
export function guardConfigured() {
  return !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);
}

export function guardEnabledFor(ws: any) {
  return guardConfigured() && ws.guard_enabled !== 0;
}

export function listKb(wsId: string): (KbSnippet & { rowId: string })[] {
  return (db().prepare('SELECT id, slug, title, text FROM kb_snippets WHERE workspace_id=? ORDER BY created_at').all(wsId) as any[])
    .map((r) => ({ rowId: r.id, id: r.slug, title: r.title, text: r.text }));
}

function guardWorkspace(ws: any): GuardWorkspace {
  return {
    name: ws.name,
    businessDesc: ws.business_desc || '',
    slaMinutes: ws.sla_minutes || 60,
    bookingUrl: ws.booking_url || undefined,
    contactEmail: ws.from_email || undefined,
    kb: listKb(ws.id).map(({ id, title, text }) => ({ id, title, text })),
  };
}

export async function runGate(ws: any, input: { name?: string; email?: string; message?: string; channel?: string }): Promise<TriageResult> {
  const llm = restClient(process.env.CLOUDFLARE_ACCOUNT_ID!, process.env.CLOUDFLARE_API_TOKEN!);
  return triage(llm, guardWorkspace(ws), { name: input.name, message: input.message || '', channel: input.channel });
}

export async function audit(wsId: string, leadId: string | null, entry: {
  decision: string; action: string; actor: string;
  checks?: { id: string; status: string }[]; models?: Record<string, string>; promptVersion?: string; leadText?: string;
}): Promise<AuditRecord> {
  const d = db();
  const last = d.prepare('SELECT record_json FROM audit_log WHERE workspace_id=? ORDER BY seq DESC LIMIT 1').get(wsId) as any;
  const prev: AuditRecord | null = last ? JSON.parse(last.record_json) : null;
  const rec = await appendRecord(prev, {
    at: new Date().toISOString(),
    leadRef: entry.leadText ? (await sha256(entry.leadText)).slice(0, 16) : (leadId || '').slice(-16),
    decision: entry.decision,
    checks: entry.checks || [],
    models: entry.models || {},
    promptVersion: entry.promptVersion || '',
    actor: entry.actor,
    action: entry.action,
  });
  d.prepare('INSERT INTO audit_log (id,workspace_id,lead_id,seq,hash,record_json,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(uid('au'), wsId, leadId, rec.seq, rec.hash, JSON.stringify(rec), now());
  return rec;
}

export function auditRecords(wsId: string, leadId?: string): AuditRecord[] {
  const rows = leadId
    ? db().prepare('SELECT record_json FROM audit_log WHERE workspace_id=? AND lead_id=? ORDER BY seq').all(wsId, leadId)
    : db().prepare('SELECT record_json FROM audit_log WHERE workspace_id=? ORDER BY seq').all(wsId);
  return (rows as any[]).map((r) => JSON.parse(r.record_json));
}

export async function verifyWorkspaceChain(wsId: string) {
  const recs = auditRecords(wsId);
  return { ...(await verifyChain(recs)), count: recs.length };
}

export function disclosure(lang: string, firm: string) {
  const l = (['en', 'nl', 'de', 'fr', 'es', 'uk'].includes(lang) ? lang : 'en') as Lang;
  return AI_DISCLOSURE[l].replace('{firm}', firm);
}

export function pendingReviewCount(wsId: string): number {
  try {
    return (db().prepare("SELECT COUNT(*) n FROM leads WHERE workspace_id=? AND review_status='pending'").get(wsId) as any).n || 0;
  } catch { return 0; }
}
