"use client";

// src/app/support/tickets/MyTickets.tsx — the signed-in user's tickets.

import Link from "next/link";
import { useEffect, useState } from "react";
import { STATUS_LABEL, categoryLabel, type TicketStatus } from "@/lib/support/model";

type Row = { id: string; number: number; subject: string; category: string; status: TicketStatus; createdAt: number; updatedAt: number; awaitingYou: boolean };

export function StatusPill({ status }: { status: TicketStatus }) {
  const tone =
    status === "pending_user"
      ? "bg-amber-400/15 text-amber-200"
      : status === "resolved" || status === "closed"
        ? "bg-white/5 text-zinc-400"
        : "bg-cyan-400/10 text-cyan-200";
  return <span className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>{status === "pending_user" ? "Waiting for your reply" : STATUS_LABEL[status]}</span>;
}

export default function MyTickets() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/support/tickets", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.message ?? `HTTP ${r.status}`);
        setRows(d.tickets ?? []);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">My tickets</h1>
          <p className="mt-1 text-sm text-cyan-100/60">Your support requests and our replies.</p>
        </div>
        <Link href="/support#contact" className="rounded-lg bg-cyan-500 px-3.5 py-2 text-sm font-semibold text-black hover:bg-cyan-400">
          New request
        </Link>
      </div>
      {error && (
        <p role="alert" className="mt-6 text-sm text-red-300">
          {error}
        </p>
      )}
      {!rows && !error && <p className="mt-6 text-sm text-cyan-100/50">Loading…</p>}
      {rows && rows.length === 0 && (
        <p className="mt-6 rounded-lg border border-dashed border-white/10 px-4 py-8 text-center text-sm text-cyan-100/50">
          No tickets yet. Requests you send from the support page appear here.
        </p>
      )}
      {rows && rows.length > 0 && (
        <ul className="mt-6 divide-y divide-white/5 rounded-xl border border-white/10 bg-white/[0.03]">
          {rows.map((t) => (
            <li key={t.id}>
              <Link href={`/support/tickets/${t.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-white/5">
                <span className="font-mono text-xs text-cyan-100/40">#{t.number}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-cyan-50">{t.subject}</span>
                <StatusPill status={t.status} />
                <span className="w-full text-xs text-cyan-100/40 sm:w-auto">
                  {categoryLabel(t.category)} · updated {new Date(t.updatedAt).toLocaleDateString()}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
