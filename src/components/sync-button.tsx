"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Pulls finished calls from VaaniVoice and qualifies them (POST /api/vaani/sync). */
export function SyncButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/vaani/sync", { method: "POST" });
      const j = await r.json();
      setMsg(j.error ? `Sync failed: ${j.error}` : `Checked ${j.checked} call(s), added ${j.ingested}.${j.historyAvailable === false ? " (VaaniVoice call history is currently unavailable — only known calls were checked.)" : ""}`);
      router.refresh();
    } catch {
      setMsg("Sync failed: network error.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center gap-3">
      {msg && (
        <span className="text-sm text-stone-600" role="status">
          {msg}
        </span>
      )}
      <button onClick={run} disabled={busy} className="rounded-lg border border-stone-300 bg-white px-3.5 py-2 text-sm font-medium hover:bg-stone-50 disabled:opacity-50">
        {busy ? "Syncing…" : "Sync calls from VaaniVoice"}
      </button>
    </div>
  );
}
