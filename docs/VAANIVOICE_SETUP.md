# VaaniVoice setup

**What was verified, and when.** On 2026-10-10, against the public documentation at https://docs.vaanivoice.ai (llms.txt / llms-full.txt):

| Capability | Documented? | How this system uses it |
|---|---|---|
| Inbound phone numbers | Yes — `deployment.phone.call_type.Inbound` (E.164), numbers provisioned or brought via SIP trunk | Callers dial the agent's inbound number |
| API auth | Yes — `X-API-Key` header, base `https://api.vaanivoice.ai` | `GET /api/agents` is used by **Integrations → Verify** |
| Webhooks | Yes — `call_started`, `user_picked_up_at`, `human_transfer_*`, `call_ended` (seconds), `call_postprocessing` (milliseconds; summary, transcript, entities, recording_url) | `/api/webhooks/vaani/<token>` |
| Webhook signatures | **Not documented** | Authenticity is enforced by a secret token in the URL path |
| Real-time custom LLM | Yes — "Bring your own LLM" (BYOL) WebSocket protocol | `voice-gateway/server.ts` connects each turn to our conversation engine |
| Human transfer | Yes, as an agent-side `transfer_call` tool, with transfer events reported by webhook | The BYOL protocol has no "transfer" instruction, so the system **does not trigger transfers**. It records transfer events if you configure the tool in Vaani. Complaints become escalation records and emails instead |
| Transcripts and recordings | Yes — `GET /api/call_details/{call_id}`, `GET /api/stream/{call_id}`, post-processing webhook | Transcript stored. Recording reference stored only when `CALL_RECORDING_ENABLED=true` |
| Usage or billing API | **Not documented** | Voice minutes are taken from call durations. Cost is shown as "unavailable", or as a labelled estimate if `VAANI_INR_PER_MINUTE_ESTIMATE` is set |

**Account status.** https://app.vaanivoice.ai shows a sign-in page. This build has **not** been connected to a VaaniVoice account, so **no live call has been placed or received**. Everything on our side has been tested with simulations and protocol-level smoke tests (`npm run test:gateway`).

## Architecture

```
Caller ──▶ VaaniVoice inbound number ──▶ Vaani agent (STT/TTS)
                                          │ BYOL WebSocket  wss://<gateway>/byol/<call_id>
                                          ▼
                              voice-gateway (Render/Railway/Fly/VM)
                                          │ POST https://<app>/api/voice/turn
                                          ▼
                              Next.js app on Vercel (rules, pricing guard, database)
Vaani webhooks ─────────────────────────▶ https://<app>/api/webhooks/vaani/<VAANI_WEBHOOK_TOKEN>
```

## Steps

1. **Deploy the app first** (see README §4) and note its URL, e.g. `https://aangan-enquiries.vercel.app`.
2. **Deploy the gateway.** It is a small Node service that must stay running.
   - **Render.com:** New → Web Service → connect the repo.
     - Build command: `npm ci`
     - Start command: `npm run gateway`
   - **Environment variables:**
     - `APP_BASE_URL` = your app URL
     - `VOICE_GATEWAY_SECRET` = the same value as in the app
     - `BYOL_AUTH_TOKEN` = a new random value
   - Health check: `https://<gateway-host>/health` should return `{"status":"ok"}`.
   - Locally you can use `npm run gateway` plus `ngrok http 8090`.
3. **Create the agent in VaaniVoice** (Dashboard → Agent Config):
   - **Persona → Identity → Greeting message:** use the text of `GREETING` in `src/core/conversation/templates.ts`. In BYOL mode Vaani speaks the greeting itself, and our engine assumes the greeting has been said.
   - **Senses → Brain → Bring your own LLM (BYOL):**
     - **URL:** `wss://<gateway-host>/byol` (Vaani appends `/<call_id>`)
     - **Auth Token:** the `BYOL_AUTH_TOKEN` value
     - **Fallback:** choose **No fallback**. If "Use platform LLM" is chosen, Vaani's own model answers when the gateway is down. That model would not run our rules or pricing guard live, although the post-call webhook path still qualifies the call from the transcript afterwards.
   - **Ears (STT):** add keyword boosting for Pune localities (Kothrud, Baner, Aundh, Wakad, Hinjewadi, Pimple Saudagar…).
   - **Language:** start with `en-IN`. Hindi/Marathi recognition depends on Vaani's STT; this system's rule-based extractor is English-first, and the optional Claude extractor handles mixed language better. Multilingual quality has **not** been verified.
4. **Telephony:** Settings → Telephony → provision a number (or connect a SIP trunk), then set it as the agent's **Inbound** number (Deployment).
5. **Webhooks:** Settings → Webhooks → add `https://<app>/api/webhooks/vaani/<VAANI_WEBHOOK_TOKEN>`.
6. **API key:** Settings → API Keys. Set `VAANI_API_KEY` and `VAANI_AGENT_ID` in the app, then click **Integrations → Verify now**.
7. **Recording:** leave recording off unless you have decided on consent wording. If you enable it, set `CALL_RECORDING_ENABLED=true`; the greeting then adds a recording notice.
8. **Place a real test call** to the number.
   - Expected: the call appears under **Call history** with the **Live** badge.
   - **Integrations** changes to "Connected & verified" once the API key is verified **and** at least one live call has been recorded.

## Things to confirm with VaaniVoice

- **Inbound call ID:** whether the BYOL `call_id` equals the webhook `room_name` for inbound calls. The system assumes it does, because the docs show the same format for outbound calls.
- **Caller number:** whether inbound `call_started` webhooks include `phone_number`. If not, the assistant asks the caller for a callback number.
- **Delivery retries:** webhook retry behaviour. Our handler returns 500 on processing failure so a retry can succeed, and de-duplicates repeats.
- **Billing data:** whether per-call usage or billing data can be exported. If so, add a usage importer that writes `cost_type = 'actual'` rows.
