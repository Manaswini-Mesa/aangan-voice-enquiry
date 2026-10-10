"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Room } from "livekit-client";

type Phase = "idle" | "connecting" | "live" | "processing" | "done" | "error";
interface Caption {
  speaker: string;
  text: string;
  id: string;
}

export function Talk({ configured }: { configured: boolean }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [room, setRoom] = useState<string | null>(null);
  const [result, setResult] = useState<{ leadId: string; leadRef: string; status: string } | null>(null);
  const [processingNote, setProcessingNote] = useState("");
  const roomRef = useRef<Room | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    logRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [captions]);

  useEffect(
    () => () => {
      void roomRef.current?.disconnect();
      wsRef.current?.close();
    },
    [],
  );

  async function start() {
    setError(null);
    setCaptions([]);
    setResult(null);
    setPhase("connecting");
    try {
      const res = await fetch("/api/vaani/webrtc", { method: "POST" });
      const s = await res.json();
      if (!res.ok) throw new Error(s.error ?? `Could not start (${res.status})`);
      setRoom(s.roomName);
      const { Room, RoomEvent, Track } = await import("livekit-client");
      const r = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = r;
      r.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          audioRef.current?.appendChild(el);
        }
      });
      r.on(RoomEvent.Disconnected, () => {
        if (roomRef.current === r) void finish(s.roomName);
      });
      if (s.liveCaptionsUrl) {
        const ws = new WebSocket(s.liveCaptionsUrl);
        wsRef.current = ws;
        ws.onmessage = (ev) => {
          try {
            const m = JSON.parse(ev.data);
            const add = (seg: { id?: string; speaker?: string; text?: string; is_final?: boolean; segment_index?: number }) => {
              if (!seg?.text || seg.is_final === false) return;
              setCaptions((c) => (c.some((x) => x.id === (seg.id ?? `${seg.segment_index}`)) ? c : [...c, { id: seg.id ?? `${seg.segment_index}-${c.length}`, speaker: seg.speaker ?? "?", text: seg.text! }]));
            };
            if (m.type === "history") (m.segments ?? []).forEach(add);
            if (m.type === "transcript") add(m.segment ?? m);
          } catch {
            /* ignore malformed caption frames */
          }
        };
      }
      await r.connect(s.connectionUrl, s.token);
      await r.localParticipant.setMicrophoneEnabled(true);
      setPhase("live");
    } catch (e) {
      setError((e as Error).name === "NotAllowedError" ? "Microphone permission was denied. Allow microphone access and try again." : (e as Error).message);
      setPhase("error");
      await roomRef.current?.disconnect();
      roomRef.current = null;
    }
  }

  async function hangUp() {
    const r = roomRef.current;
    roomRef.current = null;
    await r?.disconnect();
    if (room) await finish(room);
  }

  async function finish(roomName: string) {
    wsRef.current?.close();
    roomRef.current = null;
    setPhase("processing");
    // VaaniVoice post-processes the call (transcript + summary) before it can be qualified.
    for (let attempt = 0; attempt < 16; attempt++) {
      setProcessingNote(`Waiting for VaaniVoice to finish the transcript… (attempt ${attempt + 1})`);
      await new Promise((res) => setTimeout(res, attempt === 0 ? 8000 : 12000));
      await fetch("/api/vaani/sync", { method: "POST" }).catch(() => undefined);
      const st = await fetch(`/api/vaani/webrtc?room=${encodeURIComponent(roomName)}`).then((r) => r.json());
      if (st.found && st.finalized) {
        setResult({ leadId: st.leadId, leadRef: st.leadRef, status: st.status });
        setPhase("done");
        return;
      }
    }
    setProcessingNote("VaaniVoice hasn't finished processing this call yet. Use “Sync calls from VaaniVoice” on Call history in a minute.");
    setPhase("done");
  }

  if (!configured) {
    return <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">VaaniVoice is not configured on this server (VAANI_API_KEY and VAANI_AGENT_ID).</p>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm lg:col-span-1">
        <h2 className="text-sm font-semibold">Your test call</h2>
        <p className="mt-1 text-sm text-stone-600">Use headphones to avoid echo. Speak as a prospective client would — try a pricing question, an out-of-area project, or a complaint.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {phase === "live" ? (
            <button onClick={hangUp} className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700">
              Hang up
            </button>
          ) : (
            <button onClick={start} disabled={phase === "connecting" || phase === "processing"} className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50">
              {phase === "connecting" ? "Connecting…" : phase === "done" ? "Start another call" : "Start talking"}
            </button>
          )}
        </div>
        <p className="mt-4 text-sm" role="status">
          {phase === "idle" && "Not connected."}
          {phase === "connecting" && "Starting the VaaniVoice agent…"}
          {phase === "live" && <span className="font-medium text-emerald-700">● Live — the receptionist will greet you.</span>}
          {phase === "processing" && processingNote}
          {phase === "done" && !result && processingNote}
        </p>
        {error && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
        {result && (
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm">
            Qualified by the rules engine:{" "}
            <Link href={`/enquiries/${result.leadId}`} className="font-semibold text-brand-700 underline">
              {result.leadRef}
            </Link>{" "}
            — status <b>{result.status.replace("_", " ")}</b>.
          </div>
        )}
        <div ref={audioRef} className="hidden" aria-hidden />
      </section>
      <section className="rounded-xl border border-stone-200 bg-white shadow-sm lg:col-span-2" aria-label="Live captions">
        <h2 className="border-b border-stone-100 px-5 py-3 text-sm font-semibold">Live captions (from VaaniVoice)</h2>
        <ol ref={logRef} className="h-[420px] space-y-2 overflow-y-auto p-4" aria-live="polite">
          {captions.length === 0 && <li className="pt-16 text-center text-sm text-stone-500">Captions appear here during the call.</li>}
          {captions.map((c) => (
            <li key={c.id} className={c.speaker === "agent" ? "flex" : "flex justify-end"}>
              <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${c.speaker === "agent" ? "bg-stone-100" : "bg-sky-100"}`}>
                <div className="mb-0.5 text-[11px] font-semibold uppercase opacity-60">{c.speaker === "agent" ? "Receptionist" : "You"}</div>
                {c.text}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
