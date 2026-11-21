"use client";

// The meeting's report (GET /api/events/[id]/report): when it ran and for how
// long, who came — each person's join and leave times, minutes and rejoins —
// who was invited but never came, chat messages and the recording. Create a
// group, or add to one, from its people; the spreadsheet is the Attendance
// panel's download.
//
// Replaces "Create group from attendees", which did the first of those for
// the people who came only.

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AddToGroupDialog, { type GroupCandidate } from "@/components/groups/AddToGroupDialog";
import { groupErrorFrom, groupErrorMessage } from "@/lib/groupMessages";
import { reportTime } from "@/lib/reportTime";
import { matchesAttendee } from "@/lib/attendeeName";
import { AttendeeCells, AttendeeHeaderCells, AttendeeSearch } from "@/components/AttendeeColumns";

interface ReportPerson {
  key: string;
  userId?: string;
  name: string;
  /** By the attendee rules; "" when there is none ("Name unavailable"). */
  fullName?: string;
  username?: string;
  email: string;
  invited: boolean;
  status: "present" | "absent";
  declined: boolean;
  joinedAt: number | null;
  leftAt: number | null;
  attendedMs: number;
  entries: number;
}

interface Report {
  eventId: string;
  title: string;
  slug: string;
  hosts: string[];
  actualStart: string | null;
  actualEnd: string | null;
  durationMin: number;
  /** An always-open room: durationMin is its time in use, and times carry dates. */
  permanent?: boolean;
  participants: ReportPerson[];
  summary: {
    invited: number;
    attended: number;
    absent: number;
    chatMessages: number;
    recordingUrl: string | null;
    recorded: boolean;
  };
}

function clock(ms: number | string | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function minutes(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return ms > 0 ? "under a minute" : "—";
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

function kcHandleOf(p: ReportPerson): string | undefined {
  return p.key.startsWith("kc:") ? p.key.slice(3) : undefined;
}

export default function MeetingReportPanel({ eventId, currentUserId }: { eventId: string; currentUserId: string }) {
  const router = useRouter();
  const [report, setReport] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "new" | "existing">(null);
  const [done, setDone] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/events/${encodeURIComponent(eventId)}/report`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(await groupErrorFrom(res));
        const data = (await res.json()) as { report: Report };
        if (!cancelled) setReport(data.report);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : groupErrorMessage(null));
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (err) {
    return (
      <section className="space-y-2">
        <h2 className="text-sm uppercase tracking-widest text-slate-400">Meeting report</h2>
        <p className="text-sm text-rose-200">{err}</p>
      </section>
    );
  }
  if (!report) {
    return (
      <section className="space-y-2">
        <h2 className="text-sm uppercase tracking-widest text-slate-400">Meeting report</h2>
        <p className="text-sm text-slate-400">Loading the report…</p>
      </section>
    );
  }

  const s = report.summary;
  // You own whatever group you create, and are in the ones you add to.
  const candidates: GroupCandidate[] = report.participants
    .filter((p) => p.userId !== currentUserId)
    .filter((p) => p.userId || p.email || kcHandleOf(p))
    .map((p) => {
      const kc = kcHandleOf(p);
      return {
        name: p.fullName || p.name || p.email,
        detail:
          p.status === "present"
            ? `Came · ${minutes(p.attendedMs)}`
            : `Invited, didn't come${kc ? ` · @${kc}` : p.email ? ` · ${p.email}` : ""}`,
        userId: p.userId,
        email: p.email || undefined,
        kcHandle: kc,
        attended: p.status === "present",
        selected: p.status === "present" && Boolean(p.userId),
      };
    });

  const shown = report.participants.filter((p) => matchesAttendee(p, query));

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm uppercase tracking-widest text-slate-400">Meeting report</h2>
          <p className="text-sm text-slate-300 mt-1">
            {report.actualStart ? new Date(report.actualStart).toLocaleDateString() : ""} ·{" "}
            {clock(report.actualStart)}–{reportTime(report.actualEnd, report.actualStart)}
            {report.hosts.length ? ` · Hosted by ${report.hosts.join(", ")}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setDialog("new")}
            className="px-4 py-2 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition text-sm"
          >
            Create a group
          </button>
          <button
            type="button"
            onClick={() => setDialog("existing")}
            className="px-4 py-2 rounded-full border border-cyan-400/50 text-cyan-100 hover:bg-cyan-500/15 transition text-sm font-medium"
          >
            Add to a group
          </button>
        </div>
      </div>

      {done ? (
        <div role="status" className="text-xs text-emerald-200 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">
          {done}
        </div>
      ) : null}

      <dl className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {[
          [report.permanent ? "Time in use" : "Duration", report.durationMin ? `${report.durationMin} min` : "—"],
          ["Attended", String(s.attended)],
          ["Invited", String(s.invited)],
          ["Absent", String(s.absent)],
          ["Chat messages", String(s.chatMessages)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2">
            <dt className="text-[10px] uppercase tracking-widest text-slate-500">{label}</dt>
            <dd className="text-lg font-semibold text-slate-100">{value}</dd>
          </div>
        ))}
      </dl>

      <p className="text-sm text-slate-400">
        {s.recordingUrl ? (
          <Link href={s.recordingUrl} className="text-cyan-300 hover:text-cyan-200">
            Watch the replay
          </Link>
        ) : s.recorded ? (
          "Recorded; the replay is not open to watch."
        ) : (
          "Not recorded."
        )}
      </p>

      <AttendeeSearch value={query} onChange={setQuery} shown={shown.length} total={report.participants.length} />

      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-slate-900/60 text-xs uppercase tracking-widest text-slate-400">
            <tr>
              <AttendeeHeaderCells thClass="text-left px-3 py-2 font-medium" />
              <th className="text-left px-3 py-2 font-medium">Status</th>
              <th className="text-left px-3 py-2 font-medium">Joined</th>
              <th className="text-left px-3 py-2 font-medium">Left</th>
              <th className="text-left px-3 py-2 font-medium">Time in meeting</th>
              <th className="text-left px-3 py-2 font-medium">Joins</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr className="border-t border-slate-800">
                <td colSpan={8} className="px-3 py-4 text-center text-slate-400">
                  {query.trim() ? "No one in this meeting matches that." : "No one yet."}
                </td>
              </tr>
            ) : null}
            {shown.map((p) => (
              <tr key={p.key} className="border-t border-slate-800">
                <AttendeeCells p={p} tdClass="px-3 py-2" />
                <td className="px-3 py-2">
                  {p.status === "present" ? (
                    <span className="text-emerald-300">Present</span>
                  ) : (
                    <span className="text-amber-300">{p.declined ? "Declined" : "Absent"}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-300">{reportTime(p.joinedAt, report.actualStart)}</td>
                <td className="px-3 py-2 text-slate-300">{reportTime(p.leftAt, report.actualStart)}</td>
                <td className="px-3 py-2 text-slate-300">{p.status === "present" ? minutes(p.attendedMs) : "—"}</td>
                <td className="px-3 py-2 text-slate-300">{p.entries || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AddToGroupDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        candidates={candidates}
        suggestedName={report.title}
        fromEventId={report.eventId}
        startNew={dialog === "new"}
        onDone={(message, groupId) => {
          const created = dialog === "new";
          setDialog(null);
          if (created) router.push(`/dashboard/groups/${encodeURIComponent(groupId)}`);
          else setDone(message);
        }}
      />
    </section>
  );
}
