"use client";

// "Copy link" for a recording: makes a /share/<token> link anyone can open to
// watch or download it (30 days, the share store's longest) and copies it.
// Used where admins list recordings (Content > Files and a file's page); the
// Recordings page has its own. Made by POST /api/recordings/share, which
// allows the recorder, a host of the meeting, or an admin who moderates
// content (that last one is written to the admin audit log).

import { useState } from "react";

type State = { kind: "idle" } | { kind: "busy" } | { kind: "copied"; url: string; manual: boolean } | { kind: "error"; text: string };

export default function CopyRecordingLink({ recordingKey, className = "" }: { recordingKey: string; className?: string }) {
  const [s, setS] = useState<State>({ kind: "idle" });

  const copy = async () => {
    setS({ kind: "busy" });
    try {
      const res = await fetch("/api/recordings/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: recordingKey, label: recordingKey.split("/").pop() || recordingKey, ttlSeconds: 30 * 24 * 3600 }),
      });
      const j = (await res.json().catch(() => ({}))) as { share?: { token: string }; message?: string; error?: string };
      if (!res.ok || !j.share?.token) throw new Error(j.message || j.error || "Could not make a link.");
      const url = `${window.location.origin}/share/${j.share.token}`;
      let manual = false;
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        manual = true;
      }
      setS({ kind: "copied", url, manual });
    } catch (e) {
      setS({ kind: "error", text: e instanceof Error ? e.message : "Could not make a link." });
    }
  };

  return (
    <span className={`inline-flex flex-col gap-1 ${className}`}>
      <button
        type="button"
        onClick={copy}
        disabled={s.kind === "busy"}
        title="Copy a link anyone can open to watch or download this recording (30 days)"
        className="inline-flex w-fit items-center gap-1 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-[11px] text-emerald-100 transition hover:bg-emerald-400/20 disabled:opacity-50"
      >
        {s.kind === "busy" ? "Making a link…" : s.kind === "copied" ? "✓ Link copied" : "Copy link"}
      </button>
      {s.kind === "copied" && (
        <span role="status" className="break-all text-[11px] text-emerald-200/90">
          {s.manual ? "Copy it from here: " : "Works for 30 days: "}
          <a href={s.url} target="_blank" rel="noreferrer" className="underline">
            {s.url}
          </a>
        </span>
      )}
      {s.kind === "error" && (
        <span role="alert" className="text-[11px] text-red-300">
          {s.text}
        </span>
      )}
    </span>
  );
}
