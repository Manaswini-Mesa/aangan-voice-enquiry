# Aangan Studio — AI Voice Enquiry System

An AI receptionist and internal dashboard for Aangan Studio's inbound phone enquiries.

- **Answers calls** (through VaaniVoice) in a warm, conversational way, one question at a time.
- **Qualifies enquiries with deterministic rules** taken from `docs/source/qualified.md` and `docs/source/services.md`. The rules are code, not an AI prompt, and they are tested.
- **Never quotes prices.** Every pricing question gets the approved response, and a backend guard blocks any price, range or rate.
- **Hands qualified leads to designers** with a structured brief by email. Ambiguous cases go to a **human-review queue**, and complaints from existing clients go to a **separate escalation queue**.
- **Keeps everything**: partial calls, transcripts, facts (with source and confidence), every assessment and its rule version, follow-ups, notifications and an audit history.
- **Gives management a dashboard** with metrics calculated from the stored records, including usage and cost. Actual costs and estimates are never mixed.

> **Status in one line:** fully working in **demo mode**. **Live mode** is built and tested against simulations, but needs your VaaniVoice, Neon, Resend and (optionally) Anthropic accounts configured before it is verified with a real phone call. See [docs/ACCEPTANCE_REPORT.md](docs/ACCEPTANCE_REPORT.md).

---

## 1. Try it on your computer (demo mode, 5 minutes)

You need Node.js 20.9 or newer (`node -v`).

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Open http://localhost:3000 and sign in with a **demo account**. All data is synthetic.

| Role | Email | Password |
|---|---|---|
| Admin (everything) | `admin@aangan.demo` | `aangan-demo-2026` |
| Studio manager | `manager@aangan.demo` | `aangan-demo-2026` |
| Designer (sees only assigned leads) | `designer.riya@aangan.demo` | `aangan-demo-2026` |

On first start, the app runs 21 synthetic phone conversations (the acceptance scenarios P01–P18 and three extras) through the real engine. That gives the dashboard realistic, clearly labelled **Simulated** data. Signing in for the first time takes a few seconds while this happens. Demo data lives in `./.data/pglite`; delete that folder to start fresh.

**Things to try**
- **Talk to receptionist** — a real voice conversation with the VaaniVoice agent in your browser (needs `VAANI_API_KEY` + `VAANI_AGENT_ID` and a shared database). After you hang up, the call is pulled from VaaniVoice and qualified by the rules.
- **Call simulator:** type as a caller, or run any acceptance scenario. Watch facts and criteria update live.
- **Review queue:** open a case, choose a decision and give a rationale. The automated assessment is kept alongside your decision.
- **Handoffs & follow-ups:** assign a designer, or retry the deliberately failed demo email.
- **Integrations:** see exactly what is live, simulated or unconfigured.

For development with hot reload, use `npm run dev` instead of build + start.

## 2. How it works

```
Caller ─phone─▶ VaaniVoice (speech-to-text, text-to-speech, telephony)
                    │  BYOL WebSocket, one per call
                    ▼
            voice-gateway/server.ts  (small always-on Node service)
                    │  HTTPS  POST /api/voice/turn   (Bearer VOICE_GATEWAY_SECRET)
                    ▼
   Next.js app (Vercel) ── conversation engine ── qualification rules ── pricing guard
        │                    (src/core, pure TypeScript, fully unit-tested)
        ├── PostgreSQL (Neon) ── leads, calls, transcripts, facts, assessments, handoffs …
        ├── Resend ── designer handoff / review / complaint emails (saved first, then sent)
        ├── Anthropic Claude (optional) ── extra fact extraction + call summaries
        └── Dashboard (signed-in staff only)
VaaniVoice webhooks ──▶ /api/webhooks/vaani/<token>  (call started/ended/post-processing)
```

Why a separate gateway: VaaniVoice's "Bring your own LLM" (BYOL) feature keeps a WebSocket open for each call, and Vercel functions cannot hold WebSockets. The gateway only relays messages; every decision is made in the app.

| Folder | What's inside |
|---|---|
| `src/core/` | Business logic with no framework or vendor code: rules, qualification engine, conversation engine, pricing policy, extraction, locations, scenarios |
| `src/server/` | Database, repositories, services (calls, webhooks, workflow, notifications, metrics), provider adapters (voice, AI, email, scheduling), auth |
| `src/app/` | Dashboard pages, server actions and API routes |
| `voice-gateway/` | VaaniVoice BYOL WebSocket gateway |
| `migrations/` | SQL schema (runs on Neon and on the embedded demo database) |
| `tests/` | Unit and integration tests (Vitest) |
| `scripts/` | End-to-end test, gateway smoke test, migrations, user creation |
| `docs/` | Business rules, setup guides, requirements checklist, acceptance report |

## VaaniVoice agent (current setup)

The agent **Aangan Studio Receptionist** exists in the VaaniVoice account; its script is versioned in [`vaani/agent-system-prompt.md`](vaani/agent-system-prompt.md). Until the BYOL gateway is hosted, the live conversation runs on VaaniVoice's own model following that script, and this app applies the deterministic rules **after** each call (pulled via the VaaniVoice API, or pushed by webhook if registered). Any price the provider's agent speaks is flagged as an operational error. Note: VaaniVoice's `GET /api/call-history` returned HTTP 500 ("Invalid client_id format") for this account on 2026-10-10 — a provider-side issue; the sync falls back to looking up known calls individually.

## 3. Tests

```bash
npm test
```
This runs **163 unit and integration tests**. They cover all 18 acceptance scenarios, every rule, precedence, pricing enforcement, persistence on a real PostgreSQL engine (PGlite), webhooks, notifications, authorisation and failure handling.

```bash
npm run build
```
```bash
npm run test:e2e
```
This runs **20 end-to-end checks** against the real production server: login forms, roles, the voice endpoint, webhooks, notification retry, and live-mode honesty when no database is configured.

```bash
npm run test:gateway
```
This **smoke-tests the voice gateway** by playing VaaniVoice's documented BYOL protocol over a real WebSocket.

## 4. Going live (step by step)

1. **Database — Neon** (free tier is fine to start). Create a project, then copy the **pooled** connection string into `DATABASE_URL`. Tables are created automatically on first use, or you can run `npm run db:migrate`.
2. **Secrets.** Generate `AUTH_SECRET`, `VAANI_WEBHOOK_TOKEN`, `VOICE_GATEWAY_SECRET`, `BYOL_AUTH_TOKEN` and `CRON_SECRET`. Make each one a different random value:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
3. **Deploy the app to Vercel.**
   - Import the folder (or run `vercel`).
   - Set `APP_MODE=live`, `APP_BASE_URL`, `DATABASE_URL`, `AUTH_SECRET`, `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`, plus the variables below.
   - Sign in, then add staff with `npm run user:create -- --email … --name "…" --role manager|designer` (run it locally with `DATABASE_URL` set).
4. **Email — Resend.**
   - Add and verify your domain, then create an API key.
   - Set `RESEND_API_KEY`, `EMAIL_FROM` (on the verified domain) and the `NOTIFY_*` recipient lists.
   - On **Integrations**, click **Verify now**.
5. **Voice — VaaniVoice.** Follow [docs/VAANIVOICE_SETUP.md](docs/VAANIVOICE_SETUP.md). In short:
   - Deploy the gateway (Render, Railway or Fly.io).
   - Point the agent's BYOL URL at it.
   - Register the webhook URL.
   - Attach an inbound number.
   - Place a real test call.
6. **AI (optional) — Anthropic.** Set `ANTHROPIC_API_KEY`. The rules work without it. With it, Claude adds fact extraction (schema-validated, lower-trust) and call summaries.
7. **Confirm business rules with Nikhil.** See [docs/BUSINESS_RULES.md](docs/BUSINESS_RULES.md#pending-confirmation): the 500 sq ft commercial minimum, the timeline thresholds and the budget review floors.

Every variable is described in [.env.example](.env.example).

## 5. Logs and troubleshooting

- **Dashboard → Costs & performance → Recent operational events.** Fallbacks, failed emails and webhook errors are listed here, without personal data.
- **Dashboard → Integrations.** Shows the real state of every provider and recent webhook deliveries.
- **Vercel:** Project → **Logs**. Errors are logged as structured JSON with no transcripts or phone numbers.
- **Gateway:** your host's log view. Lines look like `{"src":"voice-gateway","code":"CALL_CONNECTED",…}`.

| Symptom | Likely cause |
|---|---|
| Sign-in says "disabled" | `AUTH_SECRET` is missing or shorter than 32 characters (live mode) |
| `/api/health` returns 503 | `DATABASE_URL` is missing or unreachable |
| Emails show "Not configured" | `RESEND_API_KEY` / `EMAIL_FROM` are missing; fix them, then press **Retry** |
| Webhook endpoint returns 404 | The token in the URL doesn't match `VAANI_WEBHOOK_TOKEN` |
| Gateway says "turn forward failed" | `APP_BASE_URL` is wrong, or `VOICE_GATEWAY_SECRET` differs between the gateway and the app |
| The caller hears "I'm having a little trouble on my side" | The app could not process the turn. Check the operational events and Vercel logs |

## 6. Security and privacy

- **Secrets** live only in server environment variables, and none reach the browser bundle. `.env*` files are git-ignored, except `.env.example`.
- **Access control.** Staff sign in with scrypt-hashed passwords and receive signed, HTTP-only session cookies. Roles (admin, manager, designer) are enforced on the server for every page, action and API. Designers see only the leads assigned to them.
- **Shared secrets.** The webhook and gateway use secrets compared in constant time. Rate limits are best-effort per instance.
- **Idempotency.** Webhooks, voice turns and emails are idempotent, so retries never duplicate records or send an email twice.
- **Recording is off by default.** Recording references are stored only if `CALL_RECORDING_ENABLED=true`, and the greeting then tells callers. Transcripts carry a retention date (`TRANSCRIPT_RETENTION_DAYS`).
- **Internal pricing material is not in this repository**, and is never sent to the AI or to callers.
- **Compliance is not established.** Legal requirements (for example India's DPDP Act, call-recording consent and TRAI rules) have **not** been verified. Review them before going live.
