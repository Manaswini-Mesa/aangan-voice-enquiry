// Aangan voice gateway — VaaniVoice "Bring Your Own LLM" (BYOL) WebSocket server.
//
// Why a separate process: VaaniVoice BYOL keeps one WebSocket open per call, and Vercel
// serverless functions cannot hold WebSocket connections. This tiny gateway runs on any
// always-on Node host (Render, Railway, Fly.io, a VM, or locally behind ngrok) and forwards
// each caller turn to the Next.js app (/api/voice/turn), where the conversation engine,
// qualification rules, pricing guard and persistence live. It holds no data and makes no
// decisions itself.
//
// Protocol (docs.vaanivoice.ai/guides/byol):
//   Vaani connects to  <BYOL URL>/<call_id>  with optional "Authorization: Bearer <token>".
//   We send {"interaction_type":"config"} then {"interaction_type":"greeting"} on connect.
//   Each turn Vaani sends {"interaction_type":"response_required","response_id",...,"transcript":[...]}
//   We reply {"response_type":"response","response_id",content,"content_complete":true,"end_call"?}.
//
// Env: PORT, APP_BASE_URL, VOICE_GATEWAY_SECRET, BYOL_AUTH_TOKEN (required unless
//      ALLOW_UNAUTHENTICATED_BYOL=true for local testing).

import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { BYOL_HANDSHAKE, byolResponseFrame, latestCallerText, parseByolMessage } from "../src/server/providers/voice/vaani";

const PORT = Number(process.env.PORT ?? 8090);
const APP = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SECRET = process.env.VOICE_GATEWAY_SECRET ?? "";
const BYOL_TOKEN = process.env.BYOL_AUTH_TOKEN ?? "";
const ALLOW_UNAUTH = process.env.ALLOW_UNAUTHENTICATED_BYOL === "true";
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 8000);
const FALLBACK = "I'm sorry, I'm having a little trouble on my side. Could you say that once more?";

function log(level: "info" | "warn" | "error", code: string, extra: Record<string, unknown> = {}) {
  // No transcripts or phone numbers in logs.
  console.log(JSON.stringify({ t: new Date().toISOString(), level, src: "voice-gateway", code, ...extra }));
}

if (!SECRET) {
  log("error", "MISSING_VOICE_GATEWAY_SECRET");
  process.exit(1);
}
if (!BYOL_TOKEN && !ALLOW_UNAUTH) {
  log("error", "MISSING_BYOL_AUTH_TOKEN", { hint: "Set BYOL_AUTH_TOKEN (and the same value in Vaani's BYOL Auth Token field)" });
  process.exit(1);
}

async function postTurn(body: Record<string, unknown>): Promise<{ reply?: string; endCall?: boolean }> {
  const res = await fetch(`${APP}/api/voice/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`app responded ${res.status}`);
  return (await res.json()) as { reply?: string; endCall?: boolean };
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://gateway");
  const match = url.pathname.match(/^\/byol\/([A-Za-z0-9._:-]{1,200})$/);
  const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!match || (!ALLOW_UNAUTH && !safeEqual(auth, BYOL_TOKEN))) {
    log("warn", match ? "WS_AUTH_REJECTED" : "WS_BAD_PATH");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => onCall(ws, match[1]));
});

function onCall(ws: WebSocket, callId: string) {
  log("info", "CALL_CONNECTED", { callId });
  for (const frame of BYOL_HANDSHAKE) ws.send(JSON.stringify(frame));
  let callerNumber: string | undefined;
  let queue = Promise.resolve();
  let ended = false;

  ws.on("message", (data) => {
    const msg = parseByolMessage(data.toString());
    if (!msg) return;
    if ("pingPong" in msg) return;
    if (msg.interaction_type !== "response_required" || typeof msg.response_id !== "number") return;
    const responseId = msg.response_id;
    callerNumber ??= typeof msg.req_body?.contact_number === "string" ? msg.req_body.contact_number : undefined;
    const text = latestCallerText(msg.transcript);
    // Process turns strictly in order for this call.
    queue = queue.then(async () => {
      let reply = FALLBACK;
      let endCall = false;
      try {
        const r = await postTurn({ event: "turn", callId, responseId, text, callerNumber });
        reply = r.reply ?? FALLBACK;
        endCall = !!r.endCall;
      } catch (err) {
        log("error", "TURN_FORWARD_FAILED", { callId, responseId, err: (err as Error).message });
      }
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(byolResponseFrame(responseId, reply, endCall)));
      if (endCall) ended = true;
    });
  });

  const keepAlive = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ response_type: "ping_pong" }));
  }, 20_000);

  ws.on("close", () => {
    clearInterval(keepAlive);
    log("info", "CALL_CLOSED", { callId, completedByAssistant: ended });
    queue.then(() => postTurn({ event: "disconnect", callId })).catch((err) => log("error", "DISCONNECT_FORWARD_FAILED", { callId, err: (err as Error).message }));
  });
  ws.on("error", (err) => log("warn", "WS_ERROR", { callId, err: err.message }));
}

server.listen(PORT, () => log("info", "LISTENING", { port: PORT, byolPath: "/byol/<call_id>", app: APP }));
