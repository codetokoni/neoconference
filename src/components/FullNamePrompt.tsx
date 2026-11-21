"use client";

// The "Full name for attendance" step for a link that joins straight in
// (?join=1, from a KingsChat message or a notification), which skips the
// join screen and its camera and microphone setup. The name is required there
// too: it starts with the one they confirmed last time, they can change it,
// and it is confirmed (/api/me/full-name) before the meeting is asked for a
// token — so nothing joins, and no attendance is written, without one.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { attendanceNameProblem, cleanFullName, FULL_NAME_MAX } from "@/lib/attendeeName";

export default function FullNamePrompt({
  roomName,
  initial,
  loaded,
  error = "",
  onConfirm,
}: {
  roomName: string;
  /** What the field starts with (the saved name, or a suggestion). */
  initial: string;
  /** False while that is still being fetched. */
  loaded: boolean;
  /** A refusal to show (the server turned the join back for want of a name). */
  error?: string;
  /** Saves it and goes on; resolves to a problem to show, or null. */
  onConfirm: (fullName: string) => Promise<string | null>;
}) {
  const [value, setValue] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [problem, setProblem] = useState(error);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!touched) setValue(initial);
  }, [initial, touched]);
  useEffect(() => {
    if (error) setProblem(error);
  }, [error]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !loaded) return;
    const local = attendanceNameProblem(value);
    if (local) {
      setProblem(local);
      inputRef.current?.focus();
      return;
    }
    const name = cleanFullName(value);
    setValue(name);
    setBusy(true);
    setProblem("");
    try {
      const refused = await onConfirm(name);
      if (refused) {
        setProblem(refused);
        inputRef.current?.focus();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-65px)] flex items-center justify-center p-4">
      <form
        onSubmit={submit}
        noValidate
        aria-labelledby="full-name-title"
        className="w-full max-w-md rounded-3xl border border-cyan-400/20 bg-zinc-950/60 backdrop-blur-xl shadow-[0_0_60px_rgba(34,211,238,0.15)] p-6 md:p-8"
      >
        <div className="text-[10px] uppercase tracking-[0.35em] text-cyan-400/80">Joining {roomName}</div>
        <h1 id="full-name-title" className="mt-2 text-2xl font-bold text-white">Confirm your name</h1>
        <p className="mt-2 text-sm text-zinc-400">
          The meeting&apos;s organisers see this name in their attendance list. Others in the meeting see your display name.
        </p>
        <label htmlFor="attendance-name" className="mt-6 block text-[11px] uppercase tracking-[0.25em] text-cyan-400/70 mb-2">
          Full name for attendance <span aria-hidden="true" className="text-rose-300">*</span>
        </label>
        <input
          id="attendance-name"
          ref={inputRef}
          name="attendance-name"
          autoComplete="name"
          autoFocus
          required
          aria-required="true"
          value={value}
          disabled={!loaded}
          maxLength={FULL_NAME_MAX + 20}
          onChange={(e) => {
            setValue(e.target.value);
            setTouched(true);
            if (problem) setProblem("");
          }}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? "attendance-name-problem" : undefined}
          placeholder={loaded ? "Your first and last name" : "Loading…"}
          className={`w-full px-4 py-3 rounded-xl bg-black/60 border ${problem ? "border-rose-400/70" : "border-white/10"} focus:border-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-400/30 text-lg text-white placeholder:text-zinc-500 transition disabled:opacity-60`}
        />
        {problem ? (
          <p id="attendance-name-problem" role="alert" className="mt-2 text-sm text-rose-300">
            {problem}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy || !loaded}
          className="mt-6 w-full rounded-xl bg-cyan-400 px-4 py-3 font-semibold text-black transition hover:bg-cyan-300 disabled:opacity-60"
        >
          {busy ? "Joining…" : "Join"}
        </button>
      </form>
    </div>
  );
}
