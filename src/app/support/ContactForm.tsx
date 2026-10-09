"use client";

// src/app/support/ContactForm.tsx
//
// "Contact support" on /support. Signed in, the ticket goes on the account
// and a screenshot can be attached; signed out, it asks for an email, and the
// server checks a form token, a honeypot field and rate limits instead of a
// CAPTCHA. Before anything is sent it suggests help articles that match.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { TICKET_CATEGORIES } from "@/lib/support/model";

type Session = {
  signedIn: boolean;
  email: string | null;
  name: string | null;
  token: string;
  attachments: { allowed: boolean; maxBytes: number; types: string[] };
};
type Suggestion = { slug: string; title: string; summary: string };

const field =
  "w-full rounded-lg border border-white/12 bg-black/40 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-cyan-400/70";

export default function ContactForm() {
  const [session, setSession] = useState<Session | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ id: string; number: number } | null>(null);
  const honeypot = useRef<HTMLInputElement>(null);

  const loadSession = () => {
    setLoadError(false);
    fetch("/api/support/session", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((s: Session) => setSession(s))
      .catch(() => setLoadError(true));
  };
  useEffect(loadSession, []);

  // Suggest articles as they describe the problem.
  useEffect(() => {
    const text = `${subject} ${description.slice(0, 300)}`.trim();
    if (text.length < 4) {
      setSuggestions([]);
      return;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      const u = new URLSearchParams({ q: text });
      if (category) u.set("category", category);
      fetch(`/api/help/suggest?${u}`, { signal: ctl.signal })
        .then((r) => r.json())
        .then((d: { items?: Suggestion[] }) => setSuggestions(d.items ?? []))
        .catch(() => undefined);
    }, 400);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [subject, description, category]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) return;
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.set("subject", subject);
    fd.set("category", category);
    fd.set("description", description);
    fd.set("website", honeypot.current?.value ?? "");
    if (!session.signedIn) {
      fd.set("email", email);
      fd.set("name", name);
      fd.set("token", session.token);
    }
    if (file) fd.set("file", file);
    try {
      const r = await fetch("/api/support/tickets", { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(d.message ?? "Your request could not be sent. Try again.");
        if (d.reason === "expired") loadSession();
        return;
      }
      setSent(d.ticket);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5 text-left">
        <h3 className="text-base font-semibold text-emerald-100">Request #{sent.number} sent</h3>
        {session?.signedIn ? (
          <p className="mt-1 text-sm text-emerald-100/80">
            We&apos;ll reply by email and in your notifications.{" "}
            <Link href={`/support/tickets/${sent.id}`} className="font-medium text-emerald-200 underline">
              Follow it in My tickets
            </Link>
            .
          </p>
        ) : (
          <p className="mt-1 text-sm text-emerald-100/80">
            We&apos;ll reply to {email}. To follow it on the website, sign in with that address and open My tickets.
          </p>
        )}
      </div>
    );
  }

  if (loadError) {
    return (
      <p className="text-sm text-red-300">
        The form could not load.{" "}
        <button type="button" onClick={loadSession} className="underline">
          Try again
        </button>
        , or email <a href="mailto:info@neoconference.app" className="underline">info@neoconference.app</a>.
      </p>
    );
  }
  if (!session) return <p className="text-sm text-cyan-100/50">Loading the form…</p>;

  const maxMb = Math.round(session.attachments.maxBytes / (1024 * 1024));
  return (
    <form onSubmit={submit} className="space-y-4 text-left" aria-label="Contact support">
      {session.signedIn ? (
        <p className="text-sm text-cyan-100/60">
          Sending as <b className="text-cyan-100">{session.email}</b>. We&apos;ll reply there and in your notifications.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm text-cyan-100/80">
            Your email
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={`${field} mt-1`} />
          </label>
          <label className="block text-sm text-cyan-100/80">
            Your name <span className="text-cyan-100/40">(optional)</span>
            <input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} className={`${field} mt-1`} />
          </label>
        </div>
      )}
      <label className="block text-sm text-cyan-100/80">
        What is it about?
        <select required value={category} onChange={(e) => setCategory(e.target.value)} className={`${field} mt-1`}>
          <option value="" disabled>
            Choose one
          </option>
          {TICKET_CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm text-cyan-100/80">
        Subject
        <input required minLength={3} maxLength={150} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. My recording is missing" className={`${field} mt-1`} />
      </label>
      <label className="block text-sm text-cyan-100/80">
        Describe the problem
        <textarea
          required
          minLength={10}
          maxLength={5000}
          rows={6}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What happened, what you expected, and the meeting link if there is one."
          className={`${field} mt-1`}
        />
      </label>

      {suggestions.length > 0 && (
        <div className="rounded-lg border border-cyan-400/20 bg-cyan-400/5 p-3" aria-live="polite">
          <p className="text-sm font-medium text-cyan-100">These articles may answer it</p>
          <ul className="mt-1.5 space-y-1.5">
            {suggestions.map((s) => (
              <li key={s.slug}>
                <a href={`/help/${s.slug}`} target="_blank" rel="noopener" className="text-sm text-cyan-300 hover:text-cyan-200">
                  {s.title}
                </a>
                {s.summary && <span className="block text-xs text-cyan-100/50">{s.summary}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {session.attachments.allowed && (
        <label className="block text-sm text-cyan-100/80">
          Attach a screenshot <span className="text-cyan-100/40">(optional, PNG, JPEG, GIF, WebP, PDF or text, up to {maxMb} MB)</span>
          <input
            type="file"
            accept={session.attachments.types.join(",")}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setError(f && f.size > session.attachments.maxBytes ? `That file is larger than ${maxMb} MB.` : null);
              setFile(f && f.size <= session.attachments.maxBytes ? f : null);
            }}
            className="mt-1 block w-full text-sm text-cyan-100/70 file:mr-3 file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:py-1.5 file:text-sm file:text-cyan-50"
          />
        </label>
      )}

      {/* Hidden from people; form-filling bots fill it in. */}
      <div aria-hidden="true" className="absolute -left-[10000px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input ref={honeypot} name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
        </label>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy} className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-black hover:bg-cyan-400 disabled:opacity-40">
          {busy ? "Sending…" : "Send request"}
        </button>
        {!session.signedIn && (
          <span className="text-xs text-cyan-100/50">
            Have an account?{" "}
            <Link href="/sign-in?redirect_url=/support" className="underline">
              Sign in
            </Link>{" "}
            to attach a file and follow replies here.
          </span>
        )}
      </div>
    </form>
  );
}
