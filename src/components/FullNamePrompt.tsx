"use client";

// Asked once, before joining a meeting, of someone who signed in with
// KingsChat and has no name anywhere: KingsChat gave none and the account has
// none (needsFullName in src/lib/attendeeName.ts). The name is saved on their
// account (/api/me/full-name), so the meeting's organisers see who came and
// it is never asked again. Shown before anything joins the meeting, so it
// writes no attendance of its own.

import { useState, type FormEvent } from "react";
import { fullNameProblem, FULL_NAME_MAX } from "@/lib/attendeeName";

export default function FullNamePrompt({
  roomName,
  onSaved,
}: {
  roomName: string;
  onSaved: (fullName: string) => void | Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const local = fullNameProblem(value);
    if (local) {
      setProblem(local);
      return;
    }
    setBusy(true);
    setProblem("");
    try {
      const res = await fetch("/api/me/full-name", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fullName: value }),
      });
      const body = (await res.json().catch(() => null)) as { fullName?: string; message?: string } | null;
      if (!res.ok || !body?.fullName) {
        setProblem(body?.message || "Your name could not be saved. Try again.");
        return;
      }
      await onSaved(body.fullName);
    } catch {
      setProblem("Your name could not be saved. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-65px)] flex items-center justify-center p-4">
      <form
        onSubmit={submit}
        aria-labelledby="full-name-title"
        className="w-full max-w-md rounded-3xl border border-cyan-400/20 bg-zinc-950/60 backdrop-blur-xl shadow-[0_0_60px_rgba(34,211,238,0.15)] p-6 md:p-8"
      >
        <div className="text-[10px] uppercase tracking-[0.35em] text-cyan-400/80">Before you join {roomName}</div>
        <h1 id="full-name-title" className="mt-2 text-2xl font-bold text-white">What is your full name?</h1>
        <p className="mt-2 text-sm text-zinc-400">
          KingsChat did not give us your name. The meeting&apos;s organisers see it in their attendance list. You will
          only be asked once.
        </p>
        <label htmlFor="full-name" className="mt-6 block text-[11px] uppercase tracking-[0.25em] text-cyan-400/70 mb-2">
          Full name
        </label>
        <input
          id="full-name"
          name="name"
          autoComplete="name"
          autoFocus
          value={value}
          maxLength={FULL_NAME_MAX + 20}
          onChange={(e) => {
            setValue(e.target.value);
            if (problem) setProblem("");
          }}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? "full-name-problem" : undefined}
          placeholder="First and last name"
          className="w-full px-4 py-3 rounded-xl bg-black/60 border border-white/10 focus:border-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-400/30 text-lg text-white placeholder:text-zinc-500 transition"
        />
        {problem ? (
          <p id="full-name-problem" role="alert" className="mt-2 text-sm text-rose-300">
            {problem}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded-xl bg-cyan-400 px-4 py-3 font-semibold text-black transition hover:bg-cyan-300 disabled:opacity-60"
        >
          {busy ? "Saving…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
