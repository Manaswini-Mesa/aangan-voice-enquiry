"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { SCENARIOS } from "@/core/scenarios";

interface Snapshot {
  leadId: string;
  leadRef: string;
  leadStatus: string;
  callStatus: string;
  stage: string;
  lastQuestion: string | null;
  pricingQuestions: number;
  facts: Array<{ key: string; value: unknown; source: string; confidence: number; validation?: string }>;
  assessment: {
    disposition: string;
    ruleVersion: string;
    criteria: Array<{ id: string; label: string; state: string; applicable: boolean; reasons: string[]; ruleCode: string }>;
    reviewReasons: Array<{ code: string; message: string; mandatory: boolean }>;
    missingCritical: string[];
    trace: string[];
  };
}

interface Line {
  who: "agent" | "caller" | "system";
  text: string;
}

const TONE: Record<string, string> = {
  PASS: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  FAIL: "bg-rose-50 text-rose-800 ring-rose-200",
  REVIEW: "bg-violet-50 text-violet-800 ring-violet-200",
  UNKNOWN: "bg-stone-100 text-stone-700 ring-stone-200",
};

function show(v: unknown): string {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if ("raw" in o) return String(o.canonical ?? o.raw);
    return JSON.stringify(v);
  }
  return Array.isArray(v) ? v.join(", ") : String(v);
}

export function Simulator() {
  const [session, setSession] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [text, setText] = useState("");
  const [conf, setConf] = useState(1);
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scenario, setScenario] = useState("");
  const [caller, setCaller] = useState("");
  const logRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    logRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [lines]);

  async function call(body: Record<string, unknown>) {
    const res = await fetch("/api/simulator", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
    return json;
  }

  async function start(number?: string): Promise<string | null> {
    setError(null);
    setBusy(true);
    try {
      const r = await call({ action: "start", callerNumber: number || caller || undefined });
      setSession(r.sessionId);
      setLines([{ who: "agent", text: r.reply }]);
      setSnap(r.snapshot);
      setEnded(false);
      return r.sessionId as string;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function say(utterance: string, sid = session, confidence = conf): Promise<boolean> {
    if (!sid) return false;
    setBusy(true);
    setError(null);
    setLines((l) => [...l, { who: "caller", text: utterance || "(silence)" }]);
    try {
      const r = await call({ action: "turn", sessionId: sid, text: utterance, confidence: confidence < 1 ? confidence : undefined });
      setLines((l) => [...l, { who: "agent", text: r.reply }]);
      setSnap(r.snapshot);
      if (r.endCall) {
        setEnded(true);
        setLines((l) => [...l, { who: "system", text: "The assistant ended the call." }]);
      }
      return !r.endCall;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function hangUp(sid = session) {
    if (!sid) return;
    setBusy(true);
    try {
      const r = await call({ action: "end", sessionId: sid });
      setSnap(r.snapshot);
      setEnded(true);
      setLines((l) => [...l, { who: "system", text: "Caller hung up / line dropped." }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runScenario() {
    const sc = SCENARIOS.find((s) => s.id === scenario);
    if (!sc) return;
    const sid = await start(sc.callerNumber?.replace(/\d{4}$/, String(Math.floor(1000 + Math.random() * 8999))));
    if (!sid) return;
    for (const t of sc.turns) {
      const cont = await say(t, sid, 1);
      if (!cont) return;
    }
    if (sc.disconnectAfter) await hangUp(sid);
  }

  const s = snap?.assessment;
  return (
    <div className="grid gap-4 xl:grid-cols-5">
      <section className="rounded-xl border border-stone-200 bg-white shadow-sm xl:col-span-3" aria-label="Simulated call">
        <div className="flex flex-wrap items-end gap-2 border-b border-stone-100 p-4">
          <div>
            <label htmlFor="caller" className="mb-1 block text-xs font-medium text-stone-600">
              Caller ID (optional)
            </label>
            <input id="caller" value={caller} onChange={(e) => setCaller(e.target.value)} placeholder="+9198…" className="w-40 rounded-lg border border-stone-300 px-3 py-2 text-sm" />
          </div>
          <button type="button" onClick={() => start()} disabled={busy} className="rounded-lg bg-stone-900 px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50">
            {session ? "New call" : "Start call"}
          </button>
          <div className="ml-auto flex items-end gap-2">
            <div>
              <label htmlFor="scenario" className="mb-1 block text-xs font-medium text-stone-600">
                Acceptance scenario
              </label>
              <select id="scenario" value={scenario} onChange={(e) => setScenario(e.target.value)} className="max-w-[260px] rounded-lg border border-stone-300 px-3 py-2 text-sm">
                <option value="">Choose…</option>
                {SCENARIOS.map((sc) => (
                  <option key={sc.id} value={sc.id}>
                    {sc.id} — {sc.title}
                  </option>
                ))}
              </select>
            </div>
            <button type="button" onClick={runScenario} disabled={busy || !scenario} className="rounded-lg border border-stone-300 bg-white px-3.5 py-2 text-sm font-medium disabled:opacity-50">
              Run
            </button>
          </div>
        </div>
        <ol ref={logRef} className="h-[460px] space-y-2 overflow-y-auto p-4" aria-live="polite">
          {lines.length === 0 && <li className="pt-20 text-center text-sm text-stone-500">Start a call, or run one of the acceptance scenarios.</li>}
          {lines.map((l, i) => (
            <li key={i} className={l.who === "caller" ? "flex justify-end" : l.who === "system" ? "text-center text-xs text-stone-500" : "flex"}>
              {l.who === "system" ? (
                l.text
              ) : (
                <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${l.who === "caller" ? "bg-sky-100 text-sky-950" : "bg-stone-100 text-stone-900"}`}>
                  <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide opacity-60">{l.who === "caller" ? "Caller" : "Assistant"}</div>
                  {l.text}
                </div>
              )}
            </li>
          ))}
        </ol>
        {error && (
          <p role="alert" className="mx-4 mb-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {error}
          </p>
        )}
        <form
          className="border-t border-stone-100 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            const t = text;
            setText("");
            void say(t);
          }}
        >
          <div className="flex gap-2">
            <label htmlFor="say" className="sr-only">
              What the caller says
            </label>
            <input id="say" value={text} onChange={(e) => setText(e.target.value)} disabled={!session || ended || busy} placeholder={session ? (ended ? "Call ended" : "Type what the caller says…") : "Start a call first"} className="flex-1 rounded-lg border border-stone-300 px-3 py-2 text-sm disabled:bg-stone-50" />
            <button disabled={!session || ended || busy || !text.trim()} className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              Say
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-stone-600">
            <label className="flex items-center gap-2">
              Speech-recognition confidence
              <input type="range" min={0.2} max={1} step={0.05} value={conf} onChange={(e) => setConf(Number(e.target.value))} />
              <span className="tabular w-8">{Math.round(conf * 100)}%</span>
            </label>
            <button type="button" disabled={!session || ended || busy} onClick={() => say("")} className="rounded-md border border-stone-300 px-2.5 py-1 disabled:opacity-50">
              Send silence
            </button>
            <button type="button" disabled={!session || ended || busy} onClick={() => hangUp()} className="rounded-md border border-rose-300 px-2.5 py-1 text-rose-700 disabled:opacity-50">
              Hang up / drop line
            </button>
          </div>
        </form>
      </section>

      <aside className="space-y-4 xl:col-span-2" aria-label="Live engine state">
        <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold">Engine state</h2>
          {!snap ? (
            <p className="mt-2 text-sm text-stone-500">No call yet.</p>
          ) : (
            <dl className="mt-2 space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-stone-500">Lead</dt>
                <dd>
                  <Link href={`/enquiries/${snap.leadId}`} className="text-brand-700 hover:underline">
                    {snap.leadRef}
                  </Link>{" "}
                  <span className="rounded-full bg-amber-50 px-2 text-xs text-amber-900 ring-1 ring-amber-200">Simulated</span>
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-stone-500">Conversation stage</dt>
                <dd className="font-mono text-xs">{snap.stage}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-stone-500">Disposition (so far)</dt>
                <dd className="font-medium">{s?.disposition.replace(/_/g, " ")}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-stone-500">Lead status</dt>
                <dd>{snap.leadStatus}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-stone-500">Pricing questions handled</dt>
                <dd className="tabular">{snap.pricingQuestions}</dd>
              </div>
            </dl>
          )}
        </section>
        {s && (
          <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold">Criteria</h2>
            <ul className="mt-2 space-y-2">
              {s.criteria
                .filter((c) => c.applicable)
                .map((c) => (
                  <li key={c.id} className="text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span>{c.label}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE[c.state]}`}>{c.state}</span>
                    </div>
                    <p className="text-xs text-stone-500">{c.reasons.join(" ")}</p>
                  </li>
                ))}
            </ul>
            {s.reviewReasons.length > 0 && <p className="mt-2 text-xs text-violet-800">Review: {s.reviewReasons.map((r) => r.message).join(" | ")}</p>}
          </section>
        )}
        {snap && (
          <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold">Facts captured</h2>
            {snap.facts.length === 0 ? (
              <p className="mt-2 text-sm text-stone-500">None yet.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-xs">
                {snap.facts.map((f) => (
                  <li key={f.key} className="flex justify-between gap-2">
                    <span className="font-mono text-stone-500">{f.key}</span>
                    <span className="text-right">
                      {show(f.value)}{" "}
                      <span className="text-stone-400">
                        ({f.source.replace("_", " ")}, {Math.round(f.confidence * 100)}%{f.validation && f.validation !== "valid" ? `, ${f.validation}` : ""})
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </aside>
    </div>
  );
}
