"use client";

// src/app/admin/AdminApi.tsx
//
// Client side of the admin area: who you are (from the layout), and
// adminFetch(), which turns the server's "step_up_required" / "mfa_required"
// answers into a code prompt and retries once the code is accepted — so a
// sensitive action reads as one click plus a code, never a dead end.

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import type { PublicAdminContext } from "@/lib/admin/context";
import type { AdminPermission } from "@/lib/admin/catalog";

export type ApiResult<T = Record<string, unknown>> = {
  ok: boolean;
  status: number;
  data: T & { error?: string; message?: string };
};

type Ctx = {
  me: PublicAdminContext;
  can: (p: AdminPermission) => boolean;
  adminFetch: <T = Record<string, unknown>>(url: string, init?: RequestInit & { json?: unknown }) => Promise<ApiResult<T>>;
};

const AdminCtx = createContext<Ctx | null>(null);

export function useAdmin(): Ctx {
  const c = useContext(AdminCtx);
  if (!c) throw new Error("useAdmin outside AdminProvider");
  return c;
}

export function AdminProvider({ me, children }: { me: PublicAdminContext; children: ReactNode }) {
  const [prompt, setPrompt] = useState<{ reason: string } | null>(null);
  const waiter = useRef<((ok: boolean) => void) | null>(null);

  const askForCode = useCallback((reason: string) => {
    setPrompt({ reason });
    return new Promise<boolean>((resolve) => {
      waiter.current = resolve;
    });
  }, []);

  const adminFetch = useCallback(
    async <T,>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<ApiResult<T>> => {
      const { json, ...rest } = init;
      const send = async (): Promise<ApiResult<T>> => {
        try {
          const res = await fetch(url, {
            cache: "no-store",
            ...rest,
            headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
            body: json !== undefined ? JSON.stringify(json) : rest.body,
          });
          const data = (await res.json().catch(() => ({}))) as ApiResult<T>["data"];
          return { ok: res.ok, status: res.status, data };
        } catch {
          return { ok: false, status: 0, data: { error: "network", message: "Could not reach the server. Check your connection." } as ApiResult<T>["data"] };
        }
      };
      const first = await send();
      if (first.data?.error === "step_up_required" || first.data?.error === "mfa_required") {
        const confirmed = await askForCode(
          first.data.error === "step_up_required"
            ? "This is a sensitive action. Confirm it with a fresh code from your authenticator app."
            : "Your admin session has ended. Enter a code from your authenticator app to continue.",
        );
        if (!confirmed) return { ok: false, status: 403, data: { error: "cancelled", message: "Cancelled." } as ApiResult<T>["data"] };
        return send();
      }
      return first;
    },
    [askForCode],
  );

  const can = useCallback((p: AdminPermission) => me.permissions.includes(p), [me.permissions]);

  return (
    <AdminCtx.Provider value={{ me, can, adminFetch }}>
      {children}
      {prompt && (
        <CodePrompt
          reason={prompt.reason}
          onDone={(ok) => {
            setPrompt(null);
            waiter.current?.(ok);
            waiter.current = null;
          }}
        />
      )}
    </AdminCtx.Provider>
  );
}

function CodePrompt({ reason, onDone }: { reason: string; onDone: (ok: boolean) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/mfa/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return onDone(true);
      setError(data?.message ?? "That code did not work.");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="stepup-title" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) submit();
        }}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0B1220] p-5 shadow-2xl"
      >
        <h2 id="stepup-title" className="text-base font-semibold text-white">
          Confirm it&apos;s you
        </h2>
        <p className="mt-1 text-sm text-zinc-400">{reason}</p>
        <input
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="Authenticator code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="123 456 or a recovery code"
          className="mt-4 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2.5 text-center font-mono text-lg tracking-[0.3em] text-white outline-none focus:border-cyan-400"
        />
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => onDone(false)} className="rounded-lg px-3 py-2 text-sm text-zinc-300 hover:bg-white/5">
            Cancel
          </button>
          <button type="submit" disabled={busy || !code.trim()} className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-black hover:bg-cyan-400 disabled:opacity-40">
            {busy ? "Checking…" : "Confirm"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Local time with the zone spelled out, so nobody guesses which clock a timestamp is on. */
export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
