"use client";

// The attendee's identity in an attendance report, the same in every report
// on screen: Full Name, then Username, then Email (the spreadsheets' order),
// and a search across all three (src/lib/attendeeName.ts).

import { NAME_UNAVAILABLE, cleanFullName } from "@/lib/attendeeName";

export interface AttendeeIdentity {
  key: string;
  fullName?: string;
  username?: string;
  email: string;
}

/** The username to show: the account's, or the KingsChat handle someone was invited by. */
export function usernameOf(p: AttendeeIdentity): string {
  return cleanFullName(p.username) || (p.key.startsWith("kc:") ? p.key.slice(3) : "");
}

export function AttendeeHeaderCells({ thClass }: { thClass: string }) {
  return (
    <>
      <th scope="col" className={thClass}>Full Name</th>
      <th scope="col" className={thClass}>Username</th>
      <th scope="col" className={thClass}>Email</th>
    </>
  );
}

export function AttendeeCells({ p, tdClass }: { p: AttendeeIdentity; tdClass: string }) {
  const full = cleanFullName(p.fullName);
  const username = usernameOf(p);
  return (
    <>
      {/* The table scrolls sideways on a narrow screen: a name may wrap,
          a username or an email stays whole. */}
      <td className={`${tdClass} min-w-[10rem]`} data-col="full-name">
        {full ? <span className="text-slate-100">{full}</span> : <span className="italic text-slate-500">{NAME_UNAVAILABLE}</span>}
      </td>
      <td className={`${tdClass} whitespace-nowrap text-slate-300`} data-col="username">{username || "—"}</td>
      <td className={`${tdClass} whitespace-nowrap text-slate-300`} data-col="email">{p.email || "—"}</td>
    </>
  );
}

export function AttendeeSearch({
  value,
  onChange,
  shown,
  total,
}: {
  value: string;
  onChange: (v: string) => void;
  shown: number;
  total: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="sr-only" htmlFor="attendee-search">Search attendees</label>
      <input
        id="attendee-search"
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search by full name, username or email"
        className="w-full sm:w-80 rounded-xl border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-400/30"
      />
      {value.trim() ? (
        <span role="status" className="text-xs text-slate-400">
          {shown} of {total}
        </span>
      ) : null}
    </div>
  );
}
