// src/lib/durationText.ts
//
// Lengths of time as the reports write them.

/** 45 → "45 min", 90 → "1 h 30 min", 120 → "2 h". */
export function minutesText(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

/** Time attended from milliseconds; "—" for none. */
export function attendedText(ms: number): string {
  if (ms <= 0) return "—";
  const m = Math.round(ms / 60_000);
  return m < 1 ? "under a minute" : minutesText(m);
}
