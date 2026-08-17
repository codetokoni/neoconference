"use client";

// src/components/SessionManager.tsx
//
// Lists the devices the user is currently signed in on, and offers the two
// sign-out scopes: this device, or everywhere.

import { useCallback, useEffect, useState } from "react";
import { useClerk } from "@clerk/nextjs";

type Scope = "device" | "all";

interface ActiveSession {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: number;
  lastActivityAt: number;
  current: boolean;
}

/** Best-effort, purely cosmetic label for the device list. */
function describeDevice(userAgent: string | null): string {
  const ua = userAgent || "";
  if (!ua) return "Unknown device";

  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";

  const os =
    /Windows/.test(ua) ? "Windows"
    : /Android/.test(ua) ? "Android"
    : /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : "Unknown OS";

  return `${browser} on ${os}`;
}

function timeAgo(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function SessionManager() {
  const { signOut } = useClerk();
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [pending, setPending] = useState<Scope | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/sessions", { credentials: "same-origin" });
      if (!res.ok) throw new Error(`sessions ${res.status}`);
      const data = await res.json();
      setSessions(data.sessions ?? []);
    } catch (err) {
      console.error("[SessionManager] load failed", err);
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleLogout(scope: Scope) {
    if (pending) return;
    setPending(scope);
    setError(null);
    try {
      const res = await fetch(`/api/auth/logout?scope=${scope}`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `Sign out failed (${res.status})`);
      }
      // Revoke server-side first, then drop the Clerk session. The scope rides
      // along so the sign-in page can say which kind of sign-out happened.
      await signOut({ redirectUrl: `/sign-in?signed_out=${scope}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sign out failed";
      console.error("[SessionManager]", err);
      setError(message);
      setPending(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
        {sessions === null ? (
          <p className="px-4 py-6 text-sm text-zinc-500">Loading devices…</p>
        ) : sessions.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">No other active devices.</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-cyan-100 truncate">
                      {describeDevice(s.userAgent)}
                    </span>
                    {s.current && (
                      <span className="shrink-0 rounded-full border border-cyan-300/30 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-medium text-cyan-200">
                        This device
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-zinc-500 truncate">
                    {s.ip ?? "IP unknown"} · active {timeAgo(s.lastActivityAt)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => handleLogout("device")}
          disabled={pending !== null}
          className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending === "device" ? "Signing out…" : "Sign out this device"}
        </button>

        <button
          type="button"
          onClick={() => handleLogout("all")}
          disabled={pending !== null}
          className="rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-300 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending === "all" ? "Signing out everywhere…" : "Sign out everywhere"}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
