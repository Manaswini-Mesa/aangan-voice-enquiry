# Requirements checklist

Statuses are based on verified implementation, not on UI existing.

- ✅ **Done & verified** — automated test or verified run
- 🟡 **Built, not verifiable here** — needs external credentials or accounts
- ⚠️ **Partial** — see note
- ⛔ **Not done**

Last updated: 2026-10-10.

## Business logic

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Deterministic server-side qualification (not prompt-based) | ✅ | `src/core/qualification/engine.ts`; 61 tests in `tests/unit/qualification.test.ts` |
| 2 | PASS / FAIL / UNKNOWN / REVIEW per criterion; unknown ≠ fail | ✅ | "unknown is not fail" tests |
| 3 | Documented precedence order; same facts + rule version → same outcome | ✅ | `decideDisposition` + precedence and determinism tests |
| 4 | Acceptance scenarios P01–P18 | ✅ | 18 scenario tests plus targeted assertions; also run end to end through the database, the HTTP server and the gateway |
| 5 | Scope rules (2BHK+, full floor, 2+ rooms, single complete room, rented non-structural; advice, styling, sourcing, Vastu, structural, restaurant/hotel/retail/gym excluded) | ✅ | Criterion tests |
| 6 | Pune + PCMC location with conservative handling of ambiguous places | ✅ | `src/core/locations.ts`; zone tests; ambiguity and low-confidence tests |
| 7 | Timeline: impossible fails, feasible passes, borderline reviews, missing unknown; source conflicts surfaced | ✅ | Threshold tests; `docs/BUSINESS_RULES.md#pending-confirmation` |
| 8 | 500 sq ft commercial minimum is configurable, PENDING_CONFIRMATION, and triggers review | ✅ | `COMMERCIAL_MIN_STATUS`; P15 and configuration tests |
| 9 | Budget optional; low volunteered budget goes to review; nothing invented | ✅ | P07, P08 and budget tests; replies checked for numbers |
| 10 | Authority: decision-maker or representative passes; research-only is not authorised; uncertain is non-blocking | ✅ | P09, P10 and authority tests |
| 11 | Fact source, confidence and validation stored; caller statements kept separate from AI inferences | ✅ | `facts` table; merge tests; facts table on the enquiry page |

## Conversation & pricing

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 12 | Stateful receptionist: one question at a time, no repeats, out-of-order answers, corrections, conflicts, silence, disconnects | ✅ | `src/core/conversation/engine.ts`; 14 conversation tests |
| 13 | Never claims qualification or confirmed booking | ✅ | Wording tests; appointment transition rules |
| 14 | Low transcription confidence → clarify before deciding | ✅ | Low-confidence tests (simulator has an STT confidence slider) |
| 15 | Exact approved pricing response; repeat-safe; backend outbound guard | ✅ | 26 pricing tests; end-to-end check of repeated pricing questions |
| 16 | Prompt-injection and internal-document requests refused | ✅ | Tests; X03 scenario |
| 17 | Pricing material kept out of the repo and out of LLM context | ✅ | `pricing.md` excluded and git-ignored; no prompt references pricing |
| 18 | Multilingual support | ⚠️ | Depends on VaaniVoice STT. The rule extractor is English-first; the optional Claude extractor helps with mixed language. **Not verified** for Hindi/Marathi callers |

## Persistence & workflows

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 19 | PostgreSQL schema + migrations + repository layer | ✅ | `migrations/001_init.sql`; runs on PGlite (tests, demo) |
| 19a | The same schema on a hosted PostgreSQL (Neon) | 🟡 | No `DATABASE_URL` available, so production persistence is not verified |
| 20 | Partial calls saved; duplicate webhooks and turns do not duplicate | ✅ | Integration and end-to-end tests |
| 21 | Handoff saved before email; failed email visible and retryable; never sent twice | ✅ | Integration test with failing then working provider; end-to-end retry |
| 22 | Human-review queue; override preserves the original assessment; rules unchanged | ✅ | Integration test; manual UI check |
| 23 | Separate complaint escalation | ✅ | P14 plus integration and end-to-end tests |
| 24 | Follow-ups with due dates (business-hours aware), overdue view | ✅ | `follow_ups`; workspace page |
| 25 | Appointment requests: pending until a person or calendar confirms; no invented slots | ✅ | Transition tests; integration test |
| 26 | Calendar integration | ⛔ | None exists; requests stay "needs human confirmation" (allowed by the brief) |
| 27 | Duplicate detection without merging on similar names | ✅ | Same phone + unfinished enquiry links; otherwise flagged `possible_duplicate_of` only |
| 28 | Audit history for important changes | ✅ | `audit_log`; shown on the enquiry page |
| 29 | Retention controls | ✅ | `retention_until` + daily sweep purge; integration test |

## Providers

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 30 | Voice provider interface + VaaniVoice adapter from verified docs | ✅ | `src/server/providers/voice/vaani.ts`; protocol tests |
| 30a | Live VaaniVoice calls | 🟡 | Requires your VaaniVoice account; **no live call verified** |
| 31 | BYOL real-time gateway | ✅ | `voice-gateway/server.ts`; `npm run test:gateway` (protocol level) |
| 32 | Webhook authenticity | ✅ | Token in URL path; VaaniVoice documents no signatures |
| 33 | Human transfer | ⚠️ | No API to trigger it from BYOL. Transfer events are recorded if the transfer tool is configured in Vaani. Complaints are escalated by record + email |
| 34 | LLM provider-independent layer; schema-validated output; fallback | ✅ | `src/server/providers/ai/*`; fallback integration test |
| 34a | Live Anthropic calls | 🟡 | No `ANTHROPIC_API_KEY` available; **not verified** |
| 35 | Email adapter (Resend) behind an interface; idempotency key | ✅ | Adapter built to Resend's documented API; tested with a test double |
| 35a | Live Resend sending | 🟡 | Requires your key and a verified domain; **no real email sent** |
| 36 | Telegram | ⛔ | Not required; not built |
| 37 | Usage and cost tracking; actual vs estimate never mixed | ✅ | `usage_events`; cost summary test; costs page. VaaniVoice has no billing API, so voice cost is unavailable or a labelled estimate |

## Dashboard, security, operations

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 38 | Overview, pipeline, detail, review, workspace, complaints, calls, simulator, costs, integrations | ✅ | All pages render; checked in a browser and by end-to-end tests |
| 39 | Metrics from stored records with honest zero states; simulated data labelled | ✅ | Metrics tests; "live only" view returns 0 on demo data |
| 40 | Authentication; roles enforced server-side; designers see only assigned leads | ✅ | Unit, integration and end-to-end tests (including forged cookie) |
| 41 | No secrets in client bundle, logs or UI | ✅ | Bundle scan; integrations page shows only set/unset; logs carry codes only |
| 42 | Rate limiting on public endpoints | ⚠️ | In-memory per instance (best-effort on serverless); secrets are the primary control |
| 43 | Health endpoint without infrastructure details | ✅ | End-to-end check |
| 44 | Demo vs live modes clearly distinct | ✅ | Banners, badges, integration states; live mode without a database refuses rather than faking |
| 45 | Production build | ✅ | `npm run build` passes (type-check + lint) |
| 46 | Vercel deployment | ⚠️ | Deployed (demo mode) to https://aangan-voice-enquiry.vercel.app. Without `DATABASE_URL`, data is not shared between serverless functions. The app shows a warning banner; add Neon to fix |
| 47 | Documentation for a beginner | ✅ | README, `docs/VAANIVOICE_SETUP.md`, `docs/BUSINESS_RULES.md`, `.env.example` |
| 48 | WhatsApp and web form later, without dependencies now | ✅ (design) | `leads.channel`; the call service is provider-agnostic, so a WhatsApp/form adapter would call `handleCallerTurn` (or replay a transcript) with a new provider key. Not built, as per the brief |
| 49 | Legal compliance (DPDP, recording consent, TRAI) | ⛔ | Not verified; must be reviewed before going live |
