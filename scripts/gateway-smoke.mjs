// Voice-gateway smoke test: plays VaaniVoice's side of the documented BYOL WebSocket protocol
// against the real gateway + real app (demo mode). No VaaniVoice account is involved — this
// proves our side of the protocol, not a live phone call.
// Usage: npm run build && npm run test:gateway

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const APP_PORT = 3913;
const GW_PORT = 8099;
const SECRET = "smoke-gateway-secret-0123456789";
const BYOL = "smoke-byol-token-0123456789";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aangan-gw-"));
const env = { ...process.env, APP_MODE: "demo", DEMO_DATA_DIR: dataDir, VOICE_GATEWAY_SECRET: SECRET, DEMO_SEED: "off" };

const app = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(APP_PORT)], { cwd: ROOT, env, stdio: "ignore" });
const gw = spawn(process.execPath, [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), "voice-gateway/server.ts"], {
  cwd: ROOT,
  env: { ...env, PORT: String(GW_PORT), APP_BASE_URL: `http://localhost:${APP_PORT}`, BYOL_AUTH_TOKEN: BYOL },
  stdio: ["ignore", "pipe", "pipe"],
});
let gwLog = "";
gw.stdout.on("data", (d) => (gwLog += d));
gw.stderr.on("data", (d) => (gwLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHttp(url) {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`not up: ${url}`);
}

let failures = 0;
const ok = (c, m) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${m}`);
  if (!c) failures++;
};

try {
  await waitHttp(`http://localhost:${APP_PORT}/api/health`);
  await waitHttp(`http://localhost:${GW_PORT}/health`);

  // Unauthorised connection is refused
  await new Promise((resolve) => {
    const bad = new WebSocket(`ws://localhost:${GW_PORT}/byol/call-x`, { headers: { Authorization: "Bearer wrong" } });
    bad.on("unexpected-response", (_req, res) => {
      ok(res.statusCode === 401, `wrong BYOL token rejected (${res.statusCode})`);
      resolve();
    });
    bad.on("open", () => {
      ok(false, "wrong BYOL token was accepted");
      bad.close();
      resolve();
    });
    bad.on("error", () => resolve());
  });

  const callId = `inbound-smoke-${Date.now()}`;
  const ws = new WebSocket(`ws://localhost:${GW_PORT}/byol/${callId}`, { headers: { Authorization: `Bearer ${BYOL}` } });
  const frames = [];
  ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
  await new Promise((r, j) => {
    ws.on("open", r);
    ws.on("error", j);
  });
  await sleep(300);
  ok(frames[0]?.interaction_type === "config" && frames[1]?.interaction_type === "greeting", "handshake frames sent (config, greeting)");

  const transcript = [{ role: "system", content: "persona" }, { role: "assistant", content: "Hello, thank you for calling Aangan Studio." }];
  const turns = [
    "Hi, I'm Tara. 3BHK in Aundh, full home redesign with execution.",
    "How much per square foot?",
    "By end of March.",
    "Yes, it's my own flat.",
    "No thanks, not right now.",
    "That's all, bye.",
  ];
  let id = 0;
  for (const text of turns) {
    id += 1;
    transcript.push({ role: "user", content: text });
    const before = frames.length;
    ws.send(JSON.stringify({ interaction_type: "response_required", response_id: id, call_id: callId, transcript, req_body: null }));
    for (let i = 0; i < 60 && frames.length === before; i++) await sleep(250);
    const f = frames.at(-1);
    ok(f?.response_type === "response" && f.response_id === id && f.content_complete === true && typeof f.content === "string", `turn ${id}: valid response frame`);
    console.log(`        caller: ${text}\n        agent : ${f?.content}${f?.end_call ? "  [end_call]" : ""}`);
    if (text.startsWith("How much")) ok(/^Pricing depends on the site/.test(f?.content ?? ""), "pricing question answered with approved line only");
    transcript.push({ role: "assistant", content: f?.content ?? "" });
    if (f?.end_call) break;
  }
  ok(frames.at(-1)?.end_call === true, "assistant ends the call with end_call:true");
  ws.close();
  await sleep(1500);
  ok(/CALL_CLOSED/.test(gwLog), "gateway logged call close and forwarded disconnect");
  ok(!/Tara|Aundh|\+91/.test(gwLog), "gateway logs contain no caller data");
} catch (err) {
  console.error(err);
  failures++;
} finally {
  app.kill();
  gw.kill();
  await sleep(500);
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
console.log(failures ? `\n${failures} gateway check(s) failed` : "\nAll gateway checks passed.");
process.exit(failures ? 1 : 0);
