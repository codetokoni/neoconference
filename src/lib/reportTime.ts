// src/lib/reportTime.ts
//
// A join or leave time on a meeting report. The clock alone when it falls on
// the day the meeting started; with its date otherwise ("13 Oct, 11:51").
// A permanent room's report spans weeks, and bare clocks read as someone
// leaving at 11:51 after joining at 13:59.

function day(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function reportTime(ms: number | string | null | undefined, startedAt?: number | string | null): string {
  if (ms === null || ms === undefined || ms === "") return "—";
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return "—";
  const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(at);
  const ref = startedAt === null || startedAt === undefined || startedAt === "" ? null : new Date(startedAt);
  if (ref && !Number.isNaN(ref.getTime()) && day(ref) === day(at)) return clock;
  const date = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
  }).format(at);
  return `${date}, ${clock}`;
}
