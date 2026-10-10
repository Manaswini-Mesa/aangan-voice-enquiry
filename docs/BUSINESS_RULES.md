# Business rules, sources and open decisions

**Sources** (copied unchanged into `docs/source/`):
- `qualified.md` — Nikhil's five-criteria rubric
- `services.md` — what Aangan does and doesn't do

`pricing.md` (the internal pricing guide) is **deliberately not** in this repository. Nothing in the system needs it, and keeping it out guarantees it can't leak into an AI prompt or a caller response. The case brief (`MESA_Case 03_Problem Statement`) and the September enquiry transcripts were read for context only. They are not stored here, because they contain real (anonymised) enquiries.

Rule configuration lives in `src/core/rules.ts`. Every assessment stores the rule version (`<base>+<config hash>`), so any outcome can be traced to the exact rules that produced it.

## Criteria (each is PASS / FAIL / UNKNOWN / REVIEW)

| Criterion | PASS | FAIL | REVIEW | UNKNOWN |
|---|---|---|---|---|
| **Scope** (qualified.md #1, services.md) | Design **and** execution for a full home, full floor, 2+ rooms or one complete room; rented only if non-structural | Advice-only, styling/colour/rearrangement, standalone sourcing, Vastu-only, design-only, structural work, restaurants/cafés/hotels/retail/gyms | Undocumented commercial type (e.g. salon), full-home 1BHK (services says 2BHK onwards), unclear partial scope | Engagement or spaces not yet known; rented with structural status unknown |
| **Location** (#2) | Locality named in services.md, or within Pune city / PCMC limits ("adjoining areas") | Talegaon, Lonavala, Nashik, Mumbai, other cities | Fringe/peri-urban areas (Wagholi, Chakan, Pirangut…); unrecognised names | Not given, or only "Pune" |
| **Timeline** (#3) | Completion ≥ 12 weeks away, flexible, or start date only; site available within 10 weeks | Completion < 6 weeks away (services.md hard minimum) | Completion 6–12 weeks away; site available later than 10 weeks; < 8 weeks between site availability and deadline | Not given, or "ASAP" with no date |
| **Budget** (#4) | Volunteered and not below configured floors | — never fails automatically | ≤ ₹1.5 lakh for multi-room/full-home (qualified.md's own example); below configured internal floors | Not mentioned / declined (treated as qualified) |
| **Authority** (#5) | Decision-maker or authorised representative | — | Researching for someone else without authority ("not sufficient on its own") | Not established (non-blocking, noted in handoff) |
| **Commercial size** | Within documented range | Below minimum **only if** the minimum is CONFIRMED | Above ~3,000 sq ft; below the provisional 500 sq ft minimum (mandatory review) | Area unknown |

**Low confidence.** A fact heard with low confidence, or one that conflicts with an earlier answer, can never cause a FAIL. The assistant asks the caller to confirm it. If it stays unconfirmed, the criterion becomes a mandatory REVIEW.

## Disposition precedence (`decideDisposition`, `src/core/qualification/engine.ts`)

The first matching step wins:

1. **Complaint / existing client** → separate escalation workflow.
2. **Any mandatory review condition** (provisional rule, unresolved conflict, low-confidence decisive fact) → **HUMAN_REVIEW**, even if there are failures. Failures stay recorded and visible.
3. **Two or more confirmed failures** → **DECLINED**, using qualified.md's wording: "This sounds like it may not be the right fit for us right now — but feel free to reach out if your timeline or scope changes."
4. **Exactly one confirmed failure** → **NOT_QUALIFIED** (an honest, specific, polite close), unless any review condition applies, in which case → HUMAN_REVIEW.
5. **Any other review condition** → **HUMAN_REVIEW**.
6. **No failures but scope, location or timeline unknown** → **INCOMPLETE**. The assistant asks one focused question; if the call ends, a callback follow-up is created.
7. **Otherwise** → **QUALIFIED**. Unknown budget or authority become notes in the handoff.

A human reviewer's decision is stored as a separate `human_override` assessment, with the reviewer's name and rationale. It never edits the automated assessment or the rules.

## Pricing

Every pricing question gets exactly this response:

> "Pricing depends on the site, the materials you choose, and the scope. Your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like."

The same line is used for repeated questions, with a short empathetic prefix. A backend guard (`guardOutbound`) checks **every** outgoing line for currency amounts, lakh/crore figures, per-sq-ft rates, "starting at"-style phrasing and discounts. If anything matches, the approved response is sent instead. Asking about price never affects qualification.

## Pending confirmation

These need a decision from Nikhil. They are configurable and do not block anything else.

1. **The 500 sq ft commercial minimum** (`COMMERCIAL_MIN_STATUS`). It came from a front-desk reply to a 180 sq ft enquiry and is not confirmed policy. It currently routes affected enquiries to review; set it to `CONFIRMED` to make it a hard decline, or `DISABLED` to remove it.
2. **The timeline thresholds.** qualified.md asks for the "site available within 8–10 weeks of the consultation". services.md says execution "cannot begin on a project that needs to be ready in under 6 weeks", with design taking 3–4 weeks and execution 8–16 weeks. These are three different measures. Rather than silently merging them, the system:
   - fails completion deadlines under 6 weeks;
   - reviews deadlines of 6–12 weeks, and sites available later than 10 weeks;
   - passes everything else.

   Please confirm the 12-week "clearly feasible" line and how T15-style cases (possession in 6 weeks) should be treated.
3. **Budget review floors** (`BUDGET_REVIEW_FLOORS`). Only qualified.md's own example (₹1–1.5 lakh for a full flat is clearly too low) is built in. Internal floors can be configured server-side; they are never spoken and never sent to the AI.
4. **Commercial maximum.** services.md says "up to approximately 3,000 sq ft", so larger spaces go to review rather than being declined.
5. **Fringe localities** (Wagholi, Chakan, Pirangut, Maan, Mahalunge…). These are currently sent to review. The list is in `src/core/locations.ts`.
6. **Business days.** The front desk covers 10am–7pm. Monday–Saturday is assumed for follow-up due times (`DEFAULT_BUSINESS_HOURS` in `src/core/time.ts`).

## Requests the system deliberately does not fulfil

- **Quoting per-square-foot prices.** The case brief quotes Nikhil asking for this ("the system should be able to quote our standard per-square-foot pricing"). `pricing.md`, his own operating instruction, forbids it: "No number from this guide should be quoted to a client". Indicative ranges quoted before a site visit would also set expectations the designer may have to walk back. The system follows `pricing.md` and gives the approved response, and this is the one ask it does not deliver.
- **Telling a caller their budget is too low.** qualified.md suggests addressing this on the call. Doing that without quoting numbers is a judgement call, so the assistant thanks the caller, notes the budget, and says the team will check how it fits the scope. The case goes to human review, and no figure is ever spoken.
