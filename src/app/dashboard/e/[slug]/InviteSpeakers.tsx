"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Result = { email: string; status: string; reason?: string };

export default function InviteSpeakers({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState<"speaker" | "cohost" | "viewer">("speaker");
  const [preApproved, setPreApproved] = useState(true);
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSend() {
    if (!emails.trim()) return;
    setBusy(true);
    setErr(null);
    setResults(null);
    try {
      const res = await fetch("/api/events/" + eventId + "/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emails, role, preApproved, sendEmail: true }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(j.error || "failed");
      }
      setResults(j.invited || []);
      setEmails("");
      startTransition(() => router.refresh());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-200">Invite by email</h3>
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          magic-link via Clerk
        </span>
      </div>
      <textarea
        value={emails}
        onChange={(e) => setEmails(e.target.value)}
        placeholder="speaker@example.com, cohost@example.com"
        rows={3}
        className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-cyan-400/60 focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-2 text-slate-300">
          <span>Role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as any)}
            className="bg-slate-950/60 border border-slate-800 rounded-md px-2 py-1 text-slate-100 focus:border-cyan-400/60 focus:outline-none"
          >
            <option value="speaker">speaker</option>
            <option value="cohost">cohost</option>
            <option value="viewer">viewer</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-slate-300">
          <input
            type="checkbox"
            checked={preApproved}
            onChange={(e) => setPreApproved(e.target.checked)}
            className="accent-cyan-400"
          />
          Skip waiting room
        </label>
        <div className="flex-1" />
        <button
          onClick={handleSend}
          disabled={busy || isPending || !emails.trim()}
          className="px-4 py-1.5 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? "Sending..." : "Send invites"}
        </button>
      </div>
      {err ? <p className="text-xs text-rose-300">{err}</p> : null}
      {results && results.length > 0 ? (
        <ul className="text-xs space-y-1 pt-2 border-t border-slate-800">
          {results.map((r, i) => (
            <li key={i} className="flex items-center justify-between gap-2">
              <span className="text-slate-300 font-mono truncate">{r.email}</span>
              <span
                className={
                  "px-2 py-0.5 rounded-full uppercase tracking-wider text-[10px] " +
                  (r.status === "sent"
                    ? "bg-cyan-500/15 text-cyan-200 border border-cyan-400/40"
                    : r.status === "linked"
                    ? "bg-emerald-500/15 text-emerald-200 border border-emerald-400/40"
                    : r.status === "error"
                    ? "bg-rose-500/15 text-rose-200 border border-rose-400/40"
                    : "bg-slate-700/40 text-slate-300 border border-slate-500/40")
                }
                title={r.reason}
              >
                {r.status}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
