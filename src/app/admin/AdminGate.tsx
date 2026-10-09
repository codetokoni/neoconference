"use client";

// src/app/admin/AdminGate.tsx
//
// What an administrator sees before the admin area opens: set up two-factor
// (first visit) or enter a code (each new session). Both reload the page on
// success so the server-side layout re-checks with the new session cookie.
// Its calls are plain fetch by design: they run before an admin session
// exists, so adminFetch's code prompt has nothing to fall back on.

import { useState } from "react";
import { Notice } from "./ui";

const card = "w-full max-w-md rounded-2xl border border-white/10 bg-white/[0.03] p-6";
const input =
  "w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2.5 text-center font-mono text-lg tracking-[0.3em] text-white outline-none focus:border-cyan-400";
const primary = "rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-black hover:bg-cyan-400 disabled:opacity-40";

async function post(url: string, body?: unknown) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, data: { message: "Could not reach the server. Check your connection." } };
  }
}

export function MfaEnroll({ email, isOwner }: { email: string; isOwner: boolean }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);

  const copy = async (list: string[]) => {
    try {
      await navigator.clipboard.writeText(list.join("\n"));
      setCopied("yes");
    } catch {
      // No clipboard (insecure context, permission refused): say so rather than look done.
      setCopied("no");
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    const r = await post("/api/admin/mfa/enroll");
    setBusy(false);
    if (r.ok) setSetup({ secret: r.data.secret, qr: r.data.qr });
    else setError(r.data.message ?? "Could not start set-up.");
  };
  const confirm = async () => {
    setBusy(true);
    setError(null);
    const r = await post("/api/admin/mfa/confirm", { code });
    setBusy(false);
    if (r.ok) setCodes(r.data.recoveryCodes);
    else setError(r.data.message ?? "That code did not match.");
  };

  if (codes) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center p-4">
        <div className={card}>
          <h1 className="text-lg font-semibold text-white">Save your recovery codes</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Each code gets you in once if you lose your phone. They will not be shown again. Store them somewhere safe, away from your phone.
          </p>
          <ul aria-label="Recovery codes" className="mt-4 grid grid-cols-2 gap-2 rounded-lg bg-black/40 p-3 font-mono text-sm text-cyan-200">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className="rounded-lg border border-white/15 px-3 py-2 text-sm text-zinc-200 hover:bg-white/5" onClick={() => copy(codes)}>
              {copied === "yes" ? "Copied" : "Copy"}
            </button>
            <a
              className="rounded-lg border border-white/15 px-3 py-2 text-sm text-zinc-200 hover:bg-white/5"
              download="neoconference-admin-recovery-codes.txt"
              href={`data:text/plain;charset=utf-8,${encodeURIComponent(`NeoConference admin recovery codes for ${email}\n\n${codes.join("\n")}\n`)}`}
            >
              Download
            </a>
            <span role="status" aria-live="polite" className={`text-xs ${copied === "no" ? "text-red-300" : "text-emerald-300"}`}>
              {copied === "yes" ? "Copied to the clipboard." : copied === "no" ? "Could not copy: select the codes or use Download." : ""}
            </span>
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="h-4 w-4 accent-cyan-500" />
            I have saved these codes
          </label>
          <button type="button" disabled={!saved} onClick={() => window.location.reload()} className={`${primary} mt-4 w-full`}>
            Open the admin area
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-4">
      <div className={card}>
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-cyan-300">{isOwner ? "Platform owner" : "Administrator"}</p>
        <h1 className="mt-1 text-lg font-semibold text-white">Set up two-factor authentication</h1>
        <p className="mt-1 text-sm text-zinc-400">
          The admin area needs a second step besides your password or email code: a 6-digit code from an authenticator app (Google Authenticator,
          Microsoft Authenticator, 1Password, Authy…).
        </p>
        {!setup ? (
          <button type="button" onClick={start} disabled={busy} className={`${primary} mt-5 w-full`}>
            {busy ? "Starting…" : "Start set-up"}
          </button>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              confirm();
            }}
            className="mt-5"
          >
            <ol className="space-y-3 text-sm text-zinc-300">
              <li>1. In your authenticator app, add an account and scan this code:</li>
            </ol>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qr} alt="QR code for your authenticator app" width={220} height={220} className="mx-auto mt-3 rounded-lg bg-white p-2" />
            <p className="mt-3 text-xs text-zinc-400">
              Can&apos;t scan? Enter this key instead:{" "}
              <code className="break-all rounded bg-black/40 px-1.5 py-0.5 font-mono text-cyan-200">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
            </p>
            <p className="mt-4 text-sm text-zinc-300">2. Type the 6-digit code it shows:</p>
            <input autoFocus inputMode="numeric" autoComplete="one-time-code" aria-label="Code from your authenticator app" value={code} onChange={(e) => setCode(e.target.value)} className={`${input} mt-2`} placeholder="123456" />
            {error && (
              <p role="alert" className="mt-2 text-sm text-red-400">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy || code.replace(/\s/g, "").length < 6} className={`${primary} mt-4 w-full`}>
              {busy ? "Checking…" : "Turn on two-factor"}
            </button>
          </form>
        )}
        {error && !setup && (
          <p role="alert" className="mt-2 text-sm text-red-400">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export function MfaVerify({ email }: { email: string }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState(false);
  // A recovery code got them in: say how many are left before the page reloads, on the page itself.
  const [usedLeft, setUsedLeft] = useState<number | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const r = await post("/api/admin/mfa/verify", { code });
    if (r.ok) {
      if (r.data.usedRecoveryCode) {
        setUsedLeft(Number(r.data.recoveryLeft) || 0);
        return;
      }
      window.location.reload();
      return;
    }
    setBusy(false);
    setError(r.data.message ?? "That code did not work.");
  };
  if (usedLeft != null)
    return (
      <div className="flex min-h-[70vh] items-center justify-center p-4">
        <div className={card}>
          <h1 className="text-lg font-semibold text-white">Recovery code used</h1>
          <div className="mt-3">
            <Notice kind={usedLeft <= 3 ? "err" : "info"}>
              That code is used up. {usedLeft} recovery code{usedLeft === 1 ? "" : "s"} left. Replace them on the Security page if you are running low.
            </Notice>
          </div>
          <button type="button" autoFocus onClick={() => window.location.reload()} className={`${primary} w-full`}>
            Open the admin area
          </button>
        </div>
      </div>
    );
  return (
    <div className="flex min-h-[70vh] items-center justify-center p-4">
      <form
        className={card}
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) submit();
        }}
      >
        <h1 className="text-lg font-semibold text-white">Admin sign-in</h1>
        <p className="mt-1 text-sm text-zinc-400">
          {recovery ? "Enter one of your recovery codes." : "Enter the 6-digit code from your authenticator app."}{" "}
          <span className="text-zinc-400">({email})</span>
        </p>
        <input
          autoFocus
          inputMode={recovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          aria-label={recovery ? "Recovery code" : "Authenticator code"}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={recovery ? "abcd-efgh" : "123456"}
          className={`${input} mt-4`}
        />
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-400">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || !code.trim()} className={`${primary} mt-4 w-full`}>
          {busy ? "Checking…" : "Continue"}
        </button>
        <button
          type="button"
          onClick={() => {
            setRecovery(!recovery);
            setCode("");
            setError(null);
          }}
          className="mt-3 w-full text-center text-xs text-zinc-400 underline decoration-dotted underline-offset-2 hover:text-zinc-200"
        >
          {recovery ? "Use my authenticator app" : "Lost your phone? Use a recovery code"}
        </button>
      </form>
    </div>
  );
}

export function AdminRefused({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4">
      <div className={card}>
        <h1 className="text-lg font-semibold text-white">{title}</h1>
        <p className="mt-1 text-sm text-zinc-400">{body}</p>
      </div>
    </div>
  );
}
