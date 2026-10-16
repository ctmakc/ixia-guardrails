import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getContext } from '@/lib/auth';
import { db } from '@/db';
import { reviewLeadAction } from '@/app/actions';
import { guardConfigured, verifyWorkspaceChain, listKb } from '@/lib/guardrails';

export const dynamic = 'force-dynamic';

const ago = (ts: number) => {
  const m = Math.round((Date.now() - ts) / 60_000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const STATUS_CLASS: Record<string, string> = { review: 'gate-review', block: 'gate-block', pass: 'gate-pass', info: 'gate-info' };

export default async function ReviewPage() {
  const ctx = await getContext();
  if (!ctx) redirect('/login');
  const ws = ctx.workspace;
  const pending = db().prepare("SELECT * FROM leads WHERE workspace_id=? AND review_status='pending' ORDER BY CASE urgency WHEN 'high' THEN 0 ELSE 1 END, created_at").all(ws.id) as any[];
  const done = db().prepare("SELECT id,name,email,review_status,guard_decision,created_at FROM leads WHERE workspace_id=? AND review_status IN ('approved','edited','rejected') ORDER BY created_at DESC LIMIT 8").all(ws.id) as any[];
  const totals = db().prepare("SELECT guard_decision d, COUNT(*) n FROM leads WHERE workspace_id=? AND guard_decision IS NOT NULL GROUP BY guard_decision").all(ws.id) as any[];
  const t = Object.fromEntries(totals.map((r) => [r.d, r.n]));
  const chain = await verifyWorkspaceChain(ws.id);
  const kbCount = listKb(ws.id).length;
  const slaMs = (ws.sla_minutes || 60) * 60_000;

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 22 }}>
        <div>
          <span className="kicker">Guardrails · review queue</span>
          <h1 style={{ fontSize: '2.1rem', marginTop: 6 }}>Held for a human</h1>
          <p className="muted" style={{ margin: '6px 0 0', maxWidth: '62ch' }}>
            These enquirers already got an instant acknowledgement in their language. The AI draft below was held by the gate; approve it, edit it, or reject it before the SLA ({ws.sla_minutes} min) runs out.
          </p>
        </div>
        <div className="mono" style={{ fontSize: '.78rem', textAlign: 'right' }}>
          <div>Audit chain · {chain.count} records · {chain.ok ? <span style={{ color: 'var(--go)' }}>intact</span> : <span style={{ color: 'var(--leak)' }}>broken at {chain.brokenAt}</span>}</div>
          <div className="subtle">Gate decisions · sent {t.auto_send || 0} · held {t.hold_for_review || 0} · blocked {t.block || 0}</div>
        </div>
      </div>

      {!guardConfigured() && (
        <div className="card" style={{ padding: 16, marginBottom: 18, borderLeft: '3px solid var(--amber)' }}>
          Guardrails is off on this install: set <code>CLOUDFLARE_ACCOUNT_ID</code> and <code>CLOUDFLARE_API_TOKEN</code> (Workers AI) to turn it on.
        </div>
      )}
      {guardConfigured() && kbCount === 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 18, borderLeft: '3px solid var(--amber)' }}>
          Your knowledge base is empty, so every factual answer will be held. <Link href="/settings#kb" style={{ color: 'var(--accent)' }}>Add fees, hours and services →</Link>
        </div>
      )}

      <div style={{ display: 'grid', gap: 16 }}>
        {pending.length === 0 && <div className="card muted" style={{ padding: 22 }}>Nothing waiting. New sensitive or uncertain enquiries will appear here.</div>}
        {pending.map((l) => {
          let g: any = {};
          try { g = JSON.parse(l.guard_json || '{}'); } catch { /* */ }
          const flags = (g.checks || []).filter((c: any) => c.status === 'review' || c.status === 'block');
          const overdue = Date.now() - l.created_at > slaMs;
          return (
            <article key={l.id} className="card review-item">
              <div className="review-head">
                <div>
                  <Link href={`/leads/${l.id}`} style={{ fontWeight: 700, fontSize: '1.05rem' }}>{l.name || l.email || 'Anonymous'}</Link>
                  <span className="mono subtle" style={{ fontSize: '.74rem', marginLeft: 10 }}>{l.channel} · {g.lang || '—'} · {l.matter_type || 'unclassified'} · {ago(l.created_at)}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {l.urgency === 'high' && <span className="pill pill-leak">urgent</span>}
                  {overdue && <span className="pill pill-leak">SLA passed</span>}
                  <span className={`pill ${l.guard_decision === 'block' ? 'pill-leak' : 'pill-amber'}`}>{l.guard_decision === 'block' ? 'blocked' : 'held'}</span>
                </div>
              </div>
              <p className="review-msg">{l.message}</p>
              <ul className="gate-flags">
                {flags.map((c: any) => (
                  <li key={c.id} className={STATUS_CLASS[c.status]}><b>{c.label}</b><span>{c.detail}</span><em className="mono">{c.source}</em></li>
                ))}
              </ul>
              <div className="review-cols">
                <div>
                  <span className="kicker" style={{ color: 'var(--go)' }}>Already sent</span>
                  <p className="review-sent">{l.ai_reply}</p>
                </div>
                <form action={reviewLeadAction}>
                  <input type="hidden" name="id" value={l.id} />
                  <label htmlFor={`t-${l.id}`}>AI draft · edit before sending</label>
                  <textarea id={`t-${l.id}`} name="text" rows={6} defaultValue={l.ai_draft || ''} />
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                    <button className="btn btn-primary" name="action" value="approved" style={{ minHeight: 38, padding: '7px 14px', fontSize: '.85rem' }}>Approve draft</button>
                    <button className="btn btn-ghost" name="action" value="edited_and_sent" style={{ minHeight: 38, padding: '7px 14px', fontSize: '.85rem' }}>Send my edit</button>
                    <button className="btn btn-ghost" name="action" value="rejected" style={{ minHeight: 38, padding: '7px 14px', fontSize: '.85rem' }}>Reject draft</button>
                  </div>
                  {g.draft?.citations?.length > 0 && <p className="mono subtle" style={{ fontSize: '.72rem', margin: '10px 0 0' }}>Cites: {g.draft.citations.join(', ')}</p>}
                </form>
              </div>
            </article>
          );
        })}
      </div>

      {done.length > 0 && (
        <div className="card" style={{ padding: 20, marginTop: 26 }}>
          <span className="kicker">Recently reviewed</span>
          <table className="leads" style={{ marginTop: 8 }}>
            <tbody>
              {done.map((d) => (
                <tr key={d.id}><td><Link href={`/leads/${d.id}`}>{d.name || d.email || 'Anonymous'}</Link></td><td className="mono subtle" style={{ fontSize: '.78rem' }}>{d.guard_decision}</td><td><span className={`pill ${d.review_status === 'rejected' ? '' : 'pill-go'}`}>{d.review_status}</span></td><td className="mono subtle" style={{ fontSize: '.78rem' }}>{ago(d.created_at)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
