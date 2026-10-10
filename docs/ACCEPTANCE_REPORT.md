# Acceptance report — 2026-10-10

Every result below comes from commands actually run on 2026-10-10 (Windows 11, Node 24.21.0, Next.js 15.5.27).

## Automated tests

| Suite | Command | Result |
|---|---|---|
| Unit + integration (Vitest) | `npm test` | **162 / 162 passed** |
| — qualification & acceptance P01–P18 | `tests/unit/qualification.test.ts` | 61 / 61 |
| — pricing policy & guard | `tests/unit/pricing.test.ts` | 26 / 26 |
| — fact extraction & merging | `tests/unit/extractor.test.ts` | 23 / 23 |
| — conversation engine | `tests/unit/conversation.test.ts` | 14 / 14 |
| — time, appointments, metrics, VaaniVoice protocol, auth | `tests/unit/platform.test.ts` | 15 / 15 |
| — integration on real PostgreSQL engine (PGlite) | `tests/integration/workflows.test.ts` | 23 / 23 |
| End-to-end against production build | `npm run build && npm run test:e2e` | **20 / 20 passed** |
| Voice gateway (BYOL protocol over real WebSocket) | `npm run test:gateway` | **all checks passed** |
| Type-check | `npx tsc --noEmit` | passed |
| Lint | `npm run lint` | passed |
| Production build | `npm run build` | passed |

### End-to-end checks against the required list

| Required check | Result |
|---|---|
| 1. Qualified residential enquiry reaches the handoff queue | PASS |
| 2. Unsupported project is declined | PASS |
| 3. Missing locality triggers clarification | PASS |
| 4. Borderline timeline reaches human review | PASS |
| 5. Repeated pricing questions never produce invented prices | PASS |
| 6. Existing-client complaint enters its own workflow | PASS |
| 7. Disconnected call remains recorded as incomplete | PASS |
| 8. Lead persists after refreshing the application | PASS |
| 9. Failed email notification remains visible and retryable | PASS |
| 10. Unauthorised user cannot access protected lead information | PASS (unauthenticated, forged cookie, and designer role) |
| 11. Demo mode works without live credentials | PASS |
| 12. Live integrations report their actual state | PASS (live mode without DB → 503 "unavailable"; integrations page shows "Simulated", not "verified") |

**Browser tooling.** These are HTTP-level tests, not browser automation. Playwright was not installed, to avoid a large browser download. The UI was additionally checked by hand in a browser:
- sign-in
- overview
- review decision submitted through the form
- notification retry
- live simulator conversation

The visual and layout check was limited: screenshots in the review environment rendered at a small, cropped size.

## Manual verification findings (fixed)

- **Dropped-call count was inflated.** Callers who hung up after the closing line were counted as dropped. Fixed.
- **"Okay, thanks" after a decline did not end the call.** Fixed.
- **Human overrides overwrote the engine's recorded disposition.** The disposition column now keeps the engine's value, and the override is stored separately.
- **Success messages were lost on redirects with a `#fragment`.** Fixed.
- **Malformed provider timestamps failed a whole webhook.** They now fall back to the receive time.
- **Date filter inputs stacked vertically.** Fixed.

## Deployment

- **Vercel:** https://aangan-voice-enquiry.vercel.app — deployed and verified on 2026-10-10:
  - `/api/health` returns 200 in demo mode.
  - Sign-in, the overview and the enquiries list work.
  - The warning banner shows.
- **Limitation verified on Vercel.** With no `DATABASE_URL`, each serverless function keeps its own temporary demo database:
  - A simulator API call returned 401 because its function had a different database.
  - The first sign-in on a cold instance redirected back to login.

  The app now shows a red banner and marks the database "Error" on the Integrations page. **Fix: add a Neon `DATABASE_URL`.**
- **Access.** The production URL is publicly reachable, and the demo accounts are documented only in the repository. Per-deployment preview URLs are protected by Vercel Authentication.

## Integration status (honest)

| Integration | Status |
|---|---|
| VaaniVoice | **Adapter, webhooks and BYOL gateway built from the official docs and protocol-tested; not connected.** No account access, so no live call has been placed or received |
| AI (Anthropic Claude) | **Built, not verified live** (no API key). Rule-based extraction runs in all modes |
| Database | **Verified on PGlite** (embedded PostgreSQL) locally and in tests. **Neon/hosted PostgreSQL not verified** (no `DATABASE_URL`) |
| Email (Resend) | **Built to Resend's documented API, tested with a test double. No real email sent** (no key or verified domain) |
| Authentication | **Verified**: scrypt passwords, HMAC-signed cookies, server-enforced roles |
| Calendar | **Not integrated.** Consultation requests stay "needs human confirmation" |

## Production readiness

**Not production-ready yet.** These steps need you, because they require accounts, credentials or business decisions:
- Neon database
- `AUTH_SECRET` and the first admin
- Resend key and a verified domain
- VaaniVoice account, agent, BYOL gateway hosting, inbound number and webhook — then a real test call
- (optional) Anthropic key
- Confirmation of the pending business rules
- Legal review of consent and recording

See README §4.
