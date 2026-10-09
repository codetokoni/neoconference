"use client";

// src/app/admin/AdminApi.tsx
//
// Client side of the admin area: who you are (from the layout), and
// adminFetch(), which turns the server's "step_up_required" / "mfa_required"
// answers into a code prompt and retries once the code is accepted — so a
// sensitive action reads as one click plus a code, never a dead end.
// adminDownload() does the same for exports and files, so a download never
// saves an error page. Below that, the one set of formatters every admin
// page uses for times, dates, numbers and money, all on the admin clock.

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import type { PublicAdminContext } from "@/lib/admin/context";
import type { AdminPermission } from "@/lib/admin/catalog";
import { dateTimeFormat, type DateStyle } from "@/lib/platform/model";
import { fmtMoney as fmtMoneyIn } from "@/lib/finance/money";
import { Dialog, btn } from "./ui";

export type ApiResult<T = Record<string, unknown>> = {
  ok: boolean;
  status: number;
  data: T & { error?: string; message?: string };
};

type Ctx = {
  me: PublicAdminContext;
  can: (p: AdminPermission) => boolean;
  adminFetch: <T = Record<string, unknown>>(url: string, init?: RequestInit & { json?: unknown }) => Promise<ApiResult<T>>;
  /** Fetches a file (export, PDF, archive) through the same code prompt and saves it. */
  adminDownload: (url: string, init?: RequestInit & { json?: unknown; filename?: string }) => Promise<ApiResult>;
};

const AdminCtx = createContext<Ctx | null>(null);

export function useAdmin(): Ctx {
  const c = useContext(AdminCtx);
  if (!c) throw new Error("useAdmin outside AdminProvider");
  return c;
}

/** The sentence to show for a failed call: the server's message, else its code, else the HTTP status. */
export function errorText(r: { status: number; data?: { message?: string; error?: string } | null }): string {
  return r.data?.message || r.data?.error || (r.status ? `The server answered ${r.status}.` : "Could not reach the server.");
}

const NETWORK = { error: "network", message: "Could not reach the server. Check your connection." };

function filenameFrom(res: Response, url: string, fallback?: string): string {
  const cd = res.headers.get("content-disposition") || "";
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // fall through to the plain filename
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  if (plain) return plain[1].trim();
  if (fallback) return fallback;
  const last = url.split("?")[0].split("/").filter(Boolean).pop();
  return last || "download";
}

export function AdminProvider({ me, clock, children }: { me: PublicAdminContext; clock?: AdminClock; children: ReactNode }) {
  // Before the children render, so their first fmtTime() already uses it.
  setAdminClock(clock);
  const [prompt, setPrompt] = useState<{ reason: string } | null>(null);
  const waiter = useRef<((ok: boolean) => void) | null>(null);

  const askForCode = useCallback((reason: string) => {
    setPrompt({ reason });
    return new Promise<boolean>((resolve) => {
      waiter.current = resolve;
    });
  }, []);

  const needsCode = useCallback(
    async (error: string | undefined): Promise<boolean | null> => {
      if (error !== "step_up_required" && error !== "mfa_required") return null;
      return askForCode(
        error === "step_up_required"
          ? "This is a sensitive action. Confirm it with a fresh code from your authenticator app."
          : "Your admin session has ended. Enter a code from your authenticator app to continue.",
      );
    },
    [askForCode],
  );

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
          return { ok: false, status: 0, data: NETWORK as ApiResult<T>["data"] };
        }
      };
      const first = await send();
      const code = await needsCode(first.data?.error);
      if (code === null) return first;
      if (!code) return { ok: false, status: 403, data: { error: "cancelled", message: "Cancelled." } as ApiResult<T>["data"] };
      return send();
    },
    [needsCode],
  );

  const adminDownload = useCallback(
    async (url: string, init: RequestInit & { json?: unknown; filename?: string } = {}): Promise<ApiResult> => {
      const { json, filename, ...rest } = init;
      const send = async (): Promise<{ res: Response | null; data: ApiResult["data"] }> => {
        try {
          const res = await fetch(url, {
            cache: "no-store",
            ...rest,
            headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
            body: json !== undefined ? JSON.stringify(json) : rest.body,
          });
          if (res.ok) return { res, data: {} };
          const data = (await res.json().catch(() => ({}))) as ApiResult["data"];
          return { res, data };
        } catch {
          return { res: null, data: NETWORK };
        }
      };
      let r = await send();
      if (!r.res?.ok) {
        const code = await needsCode(r.data?.error);
        if (code === false) return { ok: false, status: 403, data: { error: "cancelled", message: "Cancelled." } };
        if (code) r = await send();
      }
      if (!r.res || !r.res.ok) return { ok: false, status: r.res?.status ?? 0, data: r.data };
      try {
        const blob = await r.res.blob();
        const href = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = href;
        a.download = filenameFrom(r.res, url, filename);
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 10_000);
        return { ok: true, status: r.res.status, data: {} };
      } catch {
        return { ok: false, status: r.res.status, data: { error: "download_failed", message: "The file arrived but could not be saved." } };
      }
    },
    [needsCode],
  );

  const can = useCallback((p: AdminPermission) => me.permissions.includes(p), [me.permissions]);

  return (
    <AdminCtx.Provider value={{ me, can, adminFetch, adminDownload }}>
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
    <Dialog title="Confirm it's you" onClose={() => !busy && onDone(false)} z={100}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) submit();
        }}
      >
        <p className="mt-1 text-sm text-zinc-400">{reason}</p>
        <input
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="Authenticator code"
          aria-invalid={!!error}
          aria-describedby={error ? "stepup-error" : undefined}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="123 456 or a recovery code"
          className="mt-4 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2.5 text-center font-mono text-lg tracking-[0.3em] text-white outline-none focus:border-cyan-400 focus-visible:ring-2 focus-visible:ring-cyan-400/50"
        />
        {error && (
          <p id="stepup-error" role="alert" className="mt-2 text-sm text-red-400">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => onDone(false)} disabled={busy} className={btn.ghost}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !code.trim()} className={btn.primary}>
            {busy ? "Checking…" : "Confirm"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * The admin area's clock, from Settings → Regional (set by the layout via
 * AdminProvider): the zone timestamps are shown in ("local" = each
 * administrator's own), the date style and the number format.
 */
export type AdminClock = { timeZone: string; dateStyle: DateStyle; numberLocale: string };
let clock: AdminClock = { timeZone: "local", dateStyle: "medium", numberLocale: "en-US" };

export function setAdminClock(c: AdminClock | null | undefined) {
  if (c) clock = c;
}

export function adminClock(): AdminClock {
  return clock;
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The zone the admin clock is on, as an IANA name ("local" resolves to this browser's zone). */
export function adminZone(): string {
  return clock.timeZone && clock.timeZone !== "local" ? clock.timeZone : browserZone();
}

/** How to name the admin clock next to a date filter or a time input. */
export function zoneLabel(): string {
  return clock.timeZone && clock.timeZone !== "local" ? clock.timeZone : `${browserZone()} (your browser)`;
}

function zoneName(d: Date, timeZone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

function tzOption(): string | undefined {
  return clock.timeZone && clock.timeZone !== "local" ? clock.timeZone : undefined;
}

function dateOnlyFormat(timeZone: string | undefined): { locale: string | undefined; options: Intl.DateTimeFormatOptions } {
  const { locale, options } = dateTimeFormat(clock.dateStyle, timeZone);
  if (options.dateStyle) return { locale, options: { timeZone: options.timeZone, dateStyle: options.dateStyle } };
  const rest = { ...options };
  delete rest.hour;
  delete rest.minute;
  delete rest.hourCycle;
  delete rest.timeStyle;
  return { locale, options: rest };
}

/** A timestamp on the admin clock with the zone spelled out, so nobody guesses which clock it is on. */
export function fmtTime(ts: number | string | null | undefined): string {
  const n = typeof ts === "string" ? Date.parse(ts) : ts;
  if (!n || !Number.isFinite(n)) return "—";
  const d = new Date(n);
  const timeZone = tzOption();
  try {
    const { locale, options } = dateTimeFormat(clock.dateStyle, timeZone);
    return `${new Intl.DateTimeFormat(locale, options).format(d)} ${zoneName(d, timeZone)}`.trim();
  } catch {
    return d.toISOString();
  }
}

/** The calendar date of a timestamp on the admin clock (hover a <Time> for the full time and zone). */
export function fmtDate(ts: number | string | null | undefined): string {
  const n = typeof ts === "string" ? Date.parse(ts) : ts;
  if (!n || !Number.isFinite(n)) return "—";
  try {
    const { locale, options } = dateOnlyFormat(tzOption());
    return new Intl.DateTimeFormat(locale, options).format(new Date(n));
  } catch {
    return new Date(n).toISOString().slice(0, 10);
  }
}

/** A calendar day the server already worked out ("2026-10-09"), in the admin date style — not shifted by any zone. */
export function fmtDay(day: string | null | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}/.test(day)) return day || "—";
  try {
    const { locale, options } = dateOnlyFormat("UTC");
    return new Intl.DateTimeFormat(locale, options).format(new Date(Date.parse(day.slice(0, 10) + "T00:00:00Z")));
  } catch {
    return day.slice(0, 10);
  }
}

/** "5 min ago" / "in 3 h" — always paired with the absolute time (see <Time relative>). */
export function fmtRelative(ts: number | string | null | undefined, now = Date.now()): string {
  const n = typeof ts === "string" ? Date.parse(ts) : ts;
  if (!n || !Number.isFinite(n)) return "never";
  const s = Math.round((now - n) / 1000);
  const a = Math.abs(s);
  const v = a < 60 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} d`;
  return s >= 0 ? `${v} ago` : `in ${v}`;
}

/** A number in the admin's number format. */
export function fmtNumber(n: number | null | undefined, opts?: Intl.NumberFormatOptions): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat(clock.numberLocale, opts).format(n);
  } catch {
    return String(n);
  }
}

/** An amount with its currency code, in the admin's number format: "1,250.00 ESP". */
export function fmtMoney(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "—";
  return fmtMoneyIn(amount, currency ?? "ESP", clock.numberLocale);
}

function zoneOffsetMs(ts: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ts));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** A timestamp as the value of an <input type="datetime-local">, on the admin clock. */
export function toZonedInput(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return "";
  const tz = tzOption();
  if (!tz) {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  try {
    return new Date(ts + zoneOffsetMs(ts, tz)).toISOString().slice(0, 16);
  } catch {
    return new Date(ts).toISOString().slice(0, 16);
  }
}

/** The value of an <input type="datetime-local"> read on the admin clock, as a timestamp (null when empty). */
export function fromZonedInput(v: string | null | undefined): number | null {
  if (!v) return null;
  const tz = tzOption();
  if (!tz) {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }
  const guess = Date.parse(v.length === 16 ? `${v}:00Z` : `${v}Z`);
  if (!Number.isFinite(guess)) return null;
  try {
    const off = zoneOffsetMs(guess, tz);
    let ts = guess - off;
    const off2 = zoneOffsetMs(ts, tz);
    if (off2 !== off) ts = guess - off2;
    return ts;
  } catch {
    return guess;
  }
}

/** Today's calendar day on the admin clock ("2026-10-09"). */
export function adminToday(now = Date.now()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: adminZone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

/**
 * A timestamp for a table or a list. `date` shows the day only and
 * `relative` shows "5 min ago"; both keep the full time and zone in the
 * tooltip and, for screen readers, in the text.
 */
export function Time({ ts, mode = "datetime", className }: { ts: number | string | null | undefined; mode?: "datetime" | "date" | "relative"; className?: string }) {
  const n = typeof ts === "string" ? Date.parse(ts) : ts;
  if (!n || !Number.isFinite(n)) return <span className={className}>{mode === "relative" ? "never" : "—"}</span>;
  const full = fmtTime(n);
  if (mode === "datetime")
    return (
      <time dateTime={new Date(n).toISOString()} className={className}>
        {full}
      </time>
    );
  return (
    <time dateTime={new Date(n).toISOString()} title={full} className={className}>
      <span aria-hidden>{mode === "date" ? fmtDate(n) : fmtRelative(n)}</span>
      <span className="sr-only">{mode === "relative" ? `${fmtRelative(n)}, ${full}` : full}</span>
    </time>
  );
}
