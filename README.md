# IXIA Guardrails

**Instant AI replies to new client enquiries, with a human on the risky ones.**
Built for the TechEx Amsterdam Hackathon (AI & Big Data Expo Europe), 16–19 October 2026.

Live demo: **https://guardrails.ixia.online** · runs entirely on Cloudflare Workers AI.

## The problem

Law firms, immigration consultants and clinics lose clients to slow first replies: the enquirer
often books with whoever answers first. [IXIA](https://ixia.online), our AI lead-intake platform
(app.ixia.online), answers every enquiry in seconds. For a regulated firm that speed
creates a new risk: an AI reply that gives legal or medical advice, promises an outcome, quotes a fee the
firm never set, invents a phone number, or repeats a client's diagnosis or asylum case back in an e-mail.

## What Guardrails does

Every AI draft passes a gate before anyone receives it.

| Stage | What runs | Effect |
|---|---|---|
| Inbound rules | multilingual detectors for prompt injection and sensitive data (health, criminal matters, migration status, children, violence or self-harm, religion, trade union) + the draft model's own flags | sensitive or hostile enquiries go to a human |
| Retrieve | `@cf/baai/bge-m3` over the firm's knowledge base (fees, hours, services) | the draft may only use these facts |
| Draft | `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, JSON with citations, client's language | grounded first reply |
| Safety | `@cf/meta/llama-guard-3-8b` on the (enquiry, reply) pair | S6 specialised advice / S7 privacy → hold; other hazards → block |
| Verify | `@cf/openai/gpt-oss-120b` (a second model family) lists unsupported claims, case advice, promised outcomes, echoed sensitive details | hold or block |
| Rules | every price/percentage must be in the retrieved KB; contacts and links must be the firm's own; citations must exist; reply language must match | hold or block |

Decision: any **block** stops the draft, any **review** holds it, otherwise it is **sent**.
A held enquirer still gets an instant safe acknowledgement in their own language (EN, NL, DE, FR, ES, UK)
that confirms the SLA and repeats none of their details. Every message carries an AI-disclosure line.
Every decision and every reviewer action is appended to a SHA-256 hash chain, so a changed past decision
breaks verification of all later records.

## Measured

`npm run eval` sends 40 hand-written enquiries in six languages through the live models
(14 plain FAQs that must be answered at once, 18 sensitive or hostile ones that must never get an
automatic answer, 8 advice-seeking or bait questions). Latest run (17 Oct 2026 00:07 UTC, prompt `guard-2026-10-16.4`):

| Group | Cases | Sent at once | Held or blocked |
|---|---:|---:|---:|
| must_hold (health, arrest, detention, asylum, children, violence, self-harm, religion, trade union, injection) | 18 | **0** | 18 |
| must_send (plain FAQs the knowledge base answers) | 14 | **12** | 2 |
| either (advice-seeking, bait for invented facts) | 8 | 7 | 1 |

Without the gate, IXIA would have auto-replied to all 18 sensitive or hostile enquiries. Median 11.7 s per
enquiry; the slowest runs were the verifier queueing for 33–39 s, so after this run the verifier got a 25 s
deadline (past it the draft is held; in this run that would only have touched h11 and h12, both already held).
Details: [`eval/results/latest.md`](eval/results/latest.md);
per-case output (drafts, checks, timings) is in `eval/results/*.json`. These cases were written by the
team; treat them as a regression test, not a benchmark.

## Inside IXIA

The same core is vendored into the IXIA app (`integrations/ixia/` holds the integration code and the
diff against IXIA's main branch):

- intake runs the gate when Workers AI credentials are set; held drafts land in a **Review** queue
  (approve, send an edit, reject) with the reasons, citations and audit trail on each lead;
- **Settings → Knowledge base** is where the firm writes what the AI may say;
- held enquiries that pass the SLA without a human reply count as *leaking* on the intake monitor.

## Run it

```bash
npm install
npm test                      # scripted-model tests: send / hold / block paths, outage, injection, audit chain
CF_ENV_FILE=~/.config/cloudflare/api.env npm run smoke "What does a first consultation cost?"
npm run eval                  # 40 cases against Workers AI (≈ 2,800 neurons)
cd playground && npx wrangler pages dev   # local playground with the AI binding
```

`CF_ENV_FILE` (or the environment) must provide `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN`
with Workers AI access. The public playground caps live runs per day (KV counter) to stay inside the
free Workers AI allocation; after the cap the sample buttons replay recorded eval runs and say so.

## Layout

```
packages/guard/src   pipeline, detectors, prompts, retrieval, audit chain, Workers AI adapters
packages/guard/test  node:test suite with a scripted model client
eval/                cases.jsonl, runner, results
playground/          Cloudflare Pages site + Functions (/api/triage, /api/audit)
integrations/ixia/   how IXIA uses it (review queue page, server helpers, schema/actions diff)
```

## Built during the hackathon

IXIA itself existed before the event. Everything in this repository (the guard pipeline, detectors,
eval set, playground) and the IXIA integration on its `hack-techex` branch were written between
16 October 2026 19:00 UTC and the submission deadline; the commit history shows the order.

## Limits

- The verifier is a model too; it sometimes over-flags (a held FAQ costs a few minutes, an unsafe auto-reply costs a client).
- Keyword detectors cover six languages and will miss paraphrases; the draft model's sensitive-data flags are the second net.
- Demo Law Amsterdam and all eval enquiries are fictional. Do not paste real personal data into the playground.

MIT licence · INNOVA CONSULT LTD, Ottawa
