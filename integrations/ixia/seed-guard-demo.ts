// Fresh demo database for the Guardrails walkthrough: Demo Law Amsterdam
// (fictional) with its knowledge base, an owner login and a session token.
//   IXIA_DB_PATH=.hack/guard.db npx tsx scripts/seed-guard-demo.ts
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { scryptSync, randomBytes } from 'node:crypto';
import { DEMO_WORKSPACE } from '../src/lib/guard/demo-workspace';

const file = process.env.IXIA_DB_PATH || path.join(process.cwd(), '.hack', 'guard.db');
fs.mkdirSync(path.dirname(file), { recursive: true });
for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true });
const d = new Database(file);
d.exec(fs.readFileSync(path.join(process.cwd(), 'src', 'db', 'schema.sql'), 'utf8'));
for (const sql of ['ALTER TABLE leads ADD COLUMN is_sample INTEGER DEFAULT 0', 'ALTER TABLE workspaces ADD COLUMN digest_enabled INTEGER DEFAULT 1',
  'ALTER TABLE workspaces ADD COLUMN digest_last_sent_at INTEGER', 'ALTER TABLE workspaces ADD COLUMN trial_warned_at INTEGER',
  'ALTER TABLE workspaces ADD COLUMN guard_enabled INTEGER DEFAULT 1', 'ALTER TABLE leads ADD COLUMN guard_decision TEXT',
  'ALTER TABLE leads ADD COLUMN guard_json TEXT', 'ALTER TABLE leads ADD COLUMN review_status TEXT', 'ALTER TABLE leads ADD COLUMN ai_draft TEXT']) {
  try { d.exec(sql); } catch { /* exists */ }
}
const now = Date.now();
const uid = (p: string) => p + '_' + randomBytes(10).toString('hex');
const hash = (pw: string) => { const s = randomBytes(16).toString('hex'); return s + ':' + scryptSync(pw, s, 64).toString('hex'); };
const wsId = uid('ws');
const apiKey = 'ixk_demo_' + randomBytes(10).toString('hex');
d.prepare(`INSERT INTO workspaces (id,name,slug,api_key,plan,trial_ends_at,business_desc,from_email,notify_email,reply_tone,sla_minutes,booking_url,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(wsId, DEMO_WORKSPACE.name, 'demo-law-amsterdam', apiKey, 'pro', null,
  DEMO_WORKSPACE.businessDesc, DEMO_WORKSPACE.contactEmail, 'partners@demo-law.example', 'warm-professional', DEMO_WORKSPACE.slaMinutes, DEMO_WORKSPACE.bookingUrl, now);
const userId = uid('usr');
d.prepare('INSERT INTO users (id,workspace_id,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)').run(userId, wsId, 'intake@demo-law.example', hash('demo12345'), 'owner', now);
const token = 'demosession' + randomBytes(20).toString('hex');
d.prepare('INSERT INTO sessions (token,user_id,workspace_id,expires_at,created_at) VALUES (?,?,?,?,?)').run(token, userId, wsId, now + 30 * 86400000, now);
const ins = d.prepare('INSERT INTO kb_snippets (id,workspace_id,slug,title,text,created_at) VALUES (?,?,?,?,?,?)');
DEMO_WORKSPACE.kb.forEach((k, i) => ins.run(uid('kb'), wsId, k.id, k.title, k.text, now + i));
console.log('API_KEY=' + apiKey);
console.log('SESSION=' + token);
