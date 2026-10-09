"use client";

// src/app/admin/analytics/period.tsx — the date filter shared by Analytics,
// Logs and the printable summary: preset ranges or two dates, kept in the
// URL so a view can be linked and reloaded. Days are calendar days in the
// viewer's time zone (the admin time zone setting is not on the platform
// yet), and the zone is named next to the filter.

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { field } from "../ui";

export function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function dayIn(ts: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(day + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
}

const isDay = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

export interface PeriodState {
  from: string;
  to: string;
  tz: string;
  /** "from=…&to=…&tz=…" for API calls and links. */
  query: string;
  set: (from: string, to: string) => void;
  /** Other URL params on the page (filters), merged and kept. */
  params: URLSearchParams;
  setParams: (patch: Record<string, string | null>) => void;
}

export function usePeriod(defaultDays: number): PeriodState {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() || "";
  const tz = useMemo(browserTz, []);
  const today = dayIn(Date.now(), tz);
  const to = isDay(sp?.get("to") ?? null) ? (sp!.get("to") as string) : today;
  const from = isDay(sp?.get("from") ?? null) ? (sp!.get("from") as string) : addDays(to, -(defaultDays - 1));
  const params = useMemo(() => new URLSearchParams(sp?.toString() ?? ""), [sp]);
  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(sp?.toString() ?? "");
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "") next.delete(k);
        else next.set(k, v);
      }
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [sp, router, pathname],
  );
  const set = useCallback((f: string, t: string) => setParams({ from: f, to: t }), [setParams]);
  const query = `from=${from}&to=${to}&tz=${encodeURIComponent(tz)}`;
  return { from, to, tz, query, set, params, setParams };
}

const PRESETS = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "12 months", days: 365 },
];

export function PeriodBar({ p, compareNote = true }: { p: PeriodState; compareNote?: boolean }) {
  const today = dayIn(Date.now(), p.tz);
  const days = Math.round((Date.parse(p.to) - Date.parse(p.from)) / 86_400_000) + 1;
  return (
    <div className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3 print:hidden">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Preset ranges">
        {PRESETS.map((x) => {
          const active = p.to === today && days === x.days;
          return (
            <button
              key={x.days}
              type="button"
              aria-pressed={active}
              onClick={() => p.set(addDays(today, -(x.days - 1)), today)}
              className={`rounded-lg px-2.5 py-1.5 text-xs ${active ? "bg-cyan-400/15 text-cyan-200" : "text-zinc-300 hover:bg-white/5"}`}
            >
              {x.label}
            </button>
          );
        })}
      </div>
      <label className="text-xs text-zinc-400">
        From
        <input type="date" value={p.from} max={p.to} onChange={(e) => e.target.value && p.set(e.target.value, p.to)} className={`${field} mt-0.5 py-1.5`} />
      </label>
      <label className="text-xs text-zinc-400">
        To
        <input type="date" value={p.to} min={p.from} onChange={(e) => e.target.value && p.set(p.from, e.target.value)} className={`${field} mt-0.5 py-1.5`} />
      </label>
      <p className="ml-auto text-xs text-zinc-500">
        Days in <b className="text-zinc-300">{p.tz}</b> (your browser)
        {compareNote && <> · compared with the {days} days before</>}
      </p>
    </div>
  );
}
