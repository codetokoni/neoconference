"use client";

// A meeting's report: summary cards, the attendance table (sortable), the
// recording and the AI summary if there are any, and Export XLSX for Hosts.

import { useMemo, useState } from "react";
import Link from "next/link";
import type { MeetingReport, ReportParticipant } from "@/lib/groupReports";
import { minutesText as minutes } from "@/lib/durationText";

type SortKey = "name" | "join" | "duration" | "status";

function time(ms: number | null): string {
  return ms === null ? "—" : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

function span(ms: number): string {
  if (ms <= 0) return "—";
  const m = Math.round(ms / 60_000);
  return m < 1 ? "under a minute" : minutes(m);
}

function when(iso: string | null): string {
  return iso
    ? new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso))
    : "—";
}

function Card({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
      <div className="text-[11px] uppercase tracking-widest text-slate-400">{label}</div>
      <div className="mt-1 text-xl font-semibold text-slate-100">{value}</div>
    </div>
  );
}

function StatusCell({ p }: { p: ReportParticipant }) {
  if (p.status === "present") {
    return <span className="text-emerald-300"><span aria-hidden>✓ </span>Present</span>;
  }
  return (
    <span className="text-amber-300">
      <span aria-hidden>✕ </span>Absent{p.declined ? <span className="text-slate-400"> · declined</span> : null}
    </span>
  );
}

export default function MeetingReportView({
  report,
  groupId,
  canExport,
}: {
  report: MeetingReport;
  groupId: string;
  canExport: boolean;
}) {
  const [sort, setSort] = useState<SortKey>("status");
  const [desc, setDesc] = useState(false);
  const s = report.summary;

  const rows = useMemo(() => {
    const cmp: Record<SortKey, (a: ReportParticipant, b: ReportParticipant) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      join: (a, b) => (a.joinedAt ?? Infinity) - (b.joinedAt ?? Infinity),
      duration: (a, b) => a.attendedMs - b.attendedMs,
      status: (a, b) => (a.status === b.status ? 0 : a.status === "present" ? -1 : 1) || a.name.localeCompare(b.name),
    };
    const sorted = [...report.participants].sort(cmp[sort]);
    return desc ? sorted.reverse() : sorted;
  }, [report.participants, sort, desc]);

  function sortBy(k: SortKey) {
    if (k === sort) setDesc((d) => !d);
    else {
      setSort(k);
      setDesc(k === "duration");
    }
  }

  const Th = ({ k, children }: { k: SortKey; children: React.ReactNode }) => (
    <th scope="col" aria-sort={sort === k ? (desc ? "descending" : "ascending") : "none"} className="px-4 py-3 font-medium">
      <button type="button" onClick={() => sortBy(k)} className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-slate-200">
        {children}
        <span aria-hidden className="text-slate-500">{sort === k ? (desc ? "↓" : "↑") : "↕"}</span>
      </button>
    </th>
  );

  return (
    <main className="min-h-screen bg-[#05070d] text-white">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 py-10 space-y-8">
        <div>
          <Link href={`/dashboard/groups/${encodeURIComponent(groupId)}`} className="text-xs text-white/50 hover:text-white transition">
            ← {report.group?.name ?? "Group"}
          </Link>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-white break-words">{report.title}</h1>
              <p className="mt-1 text-sm text-slate-300">
                {when(report.actualStart ?? report.scheduledStart)} · Hosted by {report.hosts.join(", ")}
              </p>
              {report.scheduledStart && report.actualStart ? (
                <p className="text-xs text-slate-400">Scheduled for {when(report.scheduledStart)}</p>
              ) : null}
            </div>
            {canExport ? (
              <a
                href={`/api/groups/${encodeURIComponent(groupId)}/reports/${encodeURIComponent(report.eventId)}?format=xlsx`}
                className="px-4 py-2 rounded-full border border-cyan-400/50 text-cyan-100 hover:bg-cyan-500/15 transition text-sm"
              >
                Export XLSX
              </a>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Card label="Invited" value={s.invited} />
          <Card label="Attended" value={s.attended} />
          <Card label="Absent" value={s.absent} />
          <Card label="Duration" value={report.durationMin ? minutes(report.durationMin) : "—"} />
          <Card label="Call attempts" value={s.totalCallAttempts} />
          <Card label="Missed calls" value={s.totalMissedCalls} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 text-sm">
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 text-slate-300">
            First to join: <span className="text-slate-100">{s.firstToJoin ?? "—"}</span>
            <br />
            Last to leave: <span className="text-slate-100">{s.lastToLeave ?? "—"}</span>
            <br />
            Chat messages: <span className="text-slate-100">{s.chatMessages}</span>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 text-slate-300">
            Recording:{" "}
            {s.recordingUrl ? (
              <a href={s.recordingUrl} className="text-cyan-300 hover:text-cyan-200">Watch the replay</a>
            ) : s.recorded ? (
              <span className="text-slate-100">recorded; the host keeps the copy</span>
            ) : (
              <span className="text-slate-100">none</span>
            )}
          </div>
        </div>

        {s.aiSummary ? (
          <section aria-labelledby="summary-heading" className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
            <h2 id="summary-heading" className="text-xs uppercase tracking-widest text-slate-400">Summary</h2>
            <p className="mt-2 whitespace-pre-line text-sm text-slate-200">{s.aiSummary}</p>
          </section>
        ) : null}

        <section aria-labelledby="attendance-heading" className="space-y-2">
          <h2 id="attendance-heading" className="text-xs uppercase tracking-widest text-slate-400">Attendance</h2>
          <div className="overflow-x-auto rounded-2xl border border-slate-800">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-slate-900/70 text-left text-xs text-slate-400">
                <tr>
                  <Th k="name">Name</Th>
                  <Th k="join">Joined</Th>
                  <th scope="col" className="px-4 py-3 font-medium uppercase tracking-wider">Left</th>
                  <Th k="duration">Time attended</Th>
                  <th scope="col" className="px-4 py-3 font-medium uppercase tracking-wider">Entries</th>
                  <Th k="status">Status</Th>
                  <th scope="col" className="px-4 py-3 font-medium uppercase tracking-wider">Calls</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.key} className="border-t border-slate-800">
                    <td className="px-4 py-3">
                      <div className="text-slate-100">{p.name}</div>
                      {p.email ? <div className="max-w-[16rem] text-xs text-slate-400 [overflow-wrap:anywhere]">{p.email}</div> : null}
                      {!p.invited ? <div className="text-xs text-slate-500">not invited</div> : null}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-300">{time(p.joinedAt)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-300">{time(p.leftAt)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-300">{span(p.attendedMs)}</td>
                    <td className="px-4 py-3 text-slate-300">{p.entries || "—"}</td>
                    <td className="px-4 py-3 whitespace-nowrap"><StatusCell p={p} /></td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-300">
                      {p.callAttempts ? `${p.callAttempts} rung · ${p.missedCalls} missed` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
