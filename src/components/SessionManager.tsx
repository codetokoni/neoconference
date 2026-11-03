"use client";

// src/components/SessionManager.tsx
//
// Settings → Security → Device sessions: the devices signed in to this
// account, signing out one of them or all the others, "Allow login on
// multiple devices", and the two sign-out scopes for this device or
// everywhere. Backed by /api/auth/devices (src/lib/deviceSessions.ts).

import { useCallback, useEffect, useState } from "react";
import { useClerk } from "@clerk/nextjs";

type Scope = "device" | "all";

interface Device {
  id: string;
  label: string;
  ip: string | null;
  signedInAt: number;
  lastActiveAt: number;
  current: boolean;
}

interface DevicesState {
  multiDevice: boolean;
  devices: Device[];
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

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return typeof body?.message === "string" ? body.message : fallback;
}

export default function SessionManager() {
  const { signOut } = useClerk();
  const [data, setData] = useState<DevicesState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/devices", { credentials: "same-origin" });
      if (!res.ok) throw new Error(`devices ${res.status}`);
      setData(await res.json());
      setLoadFailed(false);
    } catch (err) {
      console.error("[SessionManager] load failed", err);
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(key: string, body: Record<string, unknown>) {
    if (pending) return;
    setPending(key);
    setError(null);
    try {
      const res = await fetch("/api/auth/devices", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readError(res, `That did not go through (${res.status}).`));
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not go through.");
      load();
    } finally {
      setPending(null);
    }
  }

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

  const others = data?.devices.filter((d) => !d.current) ?? [];

  return (
    <div className="space-y-6">
      <label className="flex items-start justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-cyan-100">Allow login on multiple devices</span>
          <span className="mt-0.5 block text-xs text-zinc-400">
            {data?.multiDevice
              ? "This account can stay signed in on several devices at once."
              : "Off: signing in on another device signs this account out everywhere else."}
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="mt-1 h-5 w-5 shrink-0 accent-cyan-400"
          checked={data?.multiDevice ?? false}
          disabled={data === null || pending !== null}
          aria-checked={data?.multiDevice ?? false}
          onChange={(e) => act("multi", { action: "multi", on: e.target.checked })}
        />
      </label>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
        {data === null ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            {loadFailed ? "Could not load your devices. Reload the page to try again." : "Loading devices…"}
          </p>
        ) : data.devices.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">No active devices.</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {data.devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-cyan-100 truncate">{d.label}</span>
                    {d.current && (
                      <span className="shrink-0 rounded-full border border-cyan-300/30 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-medium text-cyan-200">
                        This device
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-zinc-500 truncate">
                    {d.ip ?? "IP unknown"} · active {timeAgo(d.lastActiveAt)}
                  </div>
                </div>
                {!d.current && (
                  <button
                    type="button"
                    onClick={() => act(d.id, { action: "sign_out", id: d.id })}
                    disabled={pending !== null}
                    className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-cyan-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {pending === d.id ? "Signing out…" : "Sign out"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        {others.length > 0 && (
          <button
            type="button"
            onClick={() => act("others", { action: "sign_out_others" })}
            disabled={pending !== null}
            className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending === "others" ? "Signing out…" : "Sign out all other devices"}
          </button>
        )}

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
