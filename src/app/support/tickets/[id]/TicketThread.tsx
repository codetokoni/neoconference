"use client";

// src/app/support/tickets/[id]/TicketThread.tsx — one of the user's tickets:
// the conversation with support, a reply box, and "Mark as solved".

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { categoryLabel, type TicketStatus } from "@/lib/support/model";
import { StatusPill } from "../MyTickets";

type Attachment = { name: string; size: number; type: string; url: string | null };
type Message = { id: string; ts: number; author: "user" | "agent" | "system"; authorName: string; body: string; attachments: Attachment[] };
type Ticket = { id: string; number: number; subject: string; category: string; status: TicketStatus; createdAt: number };

const field =
  "w-full rounded-lg border border-white/12 bg-black/40 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-cyan-400/70";

export function Attachments({ list }: { list: Attachment[] }) {
  if (!list.length) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2">
      {list.map((a, i) => (
        <li key={i}>
          {a.url ? (
            <a href={a.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded border border-white/10 px-2 py-1 text-xs text-cyan-200 hover:bg-white/5">
              📎 {a.name} <span className="text-cyan-100/40">({Math.max(1, Math.round(a.size / 1024))} KB)</span>
            </a>
          ) : (
            <span className="text-xs text-cyan-100/40">📎 {a.name} (unavailable)</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function TicketThread({ id }: { id: string }) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/support/tickets/${encodeURIComponent(id)}`, { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setError(d.message ?? `HTTP ${r.status}`);
    setTicket(d.ticket);
    setMessages(d.messages ?? []);
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const fd = new FormData();
    fd.set("body", reply);
    if (file) fd.set("file", file);
    try {
      const r = await fetch(`/api/support/tickets/${encodeURIComponent(id)}/messages`, { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return setNotice(d.message ?? "Your reply could not be sent.");
      setReply("");
      setFile(null);
      (e.target as HTMLFormElement).reset();
      await load();
    } finally {
      setBusy(false);
    }
  };

  const solve = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/support/tickets/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "resolved" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return setNotice(d.message ?? "Could not update the ticket.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div>
        <Link href="/support/tickets" className="text-sm text-cyan-300 hover:text-cyan-200">
          ← My tickets
        </Link>
        <p role="alert" className="mt-4 text-red-300">
          {error}
        </p>
      </div>
    );
  }
  if (!ticket) return <p className="text-sm text-cyan-100/50">Loading…</p>;
  const open = ticket.status !== "resolved" && ticket.status !== "closed";

  return (
    <div>
      <Link href="/support/tickets" className="text-sm text-cyan-300 hover:text-cyan-200">
        ← My tickets
      </Link>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-white">{ticket.subject}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-cyan-100/50">
            <span className="font-mono">#{ticket.number}</span>
            <StatusPill status={ticket.status} />
            <span>{categoryLabel(ticket.category)}</span>
          </p>
        </div>
        {open && (
          <button type="button" onClick={solve} disabled={busy} className="rounded-lg border border-white/15 px-3 py-1.5 text-sm text-cyan-100/80 hover:bg-white/5 disabled:opacity-40">
            Mark as solved
          </button>
        )}
      </div>

      <ol className="mt-6 space-y-3">
        {messages.map((m) =>
          m.author === "system" ? (
            <li key={m.id} className="text-center text-xs text-cyan-100/40">
              {m.body} · {new Date(m.ts).toLocaleString()}
            </li>
          ) : (
            <li
              key={m.id}
              className={`rounded-xl border p-4 ${m.author === "agent" ? "border-cyan-400/25 bg-cyan-400/[0.06]" : "border-white/10 bg-white/[0.03]"}`}
            >
              <p className="text-xs text-cyan-100/50">
                <b className="text-cyan-100/80">{m.author === "agent" ? `${m.authorName} · NeoConference support` : m.authorName || "You"}</b> ·{" "}
                {new Date(m.ts).toLocaleString()}
              </p>
              <p className="mt-2 whitespace-pre-line text-sm text-cyan-50/90">{m.body}</p>
              <Attachments list={m.attachments} />
            </li>
          ),
        )}
      </ol>

      {ticket.status === "closed" ? (
        <p className="mt-6 text-sm text-cyan-100/60">
          This ticket is closed.{" "}
          <Link href="/support#contact" className="text-cyan-300 underline">
            Send a new request
          </Link>{" "}
          if you need more help.
        </p>
      ) : (
        <form onSubmit={send} className="mt-6 space-y-3">
          <label className="block text-sm text-cyan-100/80">
            {ticket.status === "resolved" ? "Still a problem? Reply to reopen it" : "Reply"}
            <textarea required rows={4} maxLength={5000} value={reply} onChange={(e) => setReply(e.target.value)} className={`${field} mt-1`} />
          </label>
          <input
            type="file"
            aria-label="Attach a file"
            accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-cyan-100/70 file:mr-3 file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:py-1.5 file:text-sm file:text-cyan-50"
          />
          {notice && (
            <p role="alert" className="text-sm text-red-300">
              {notice}
            </p>
          )}
          <button type="submit" disabled={busy || !reply.trim()} className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-black hover:bg-cyan-400 disabled:opacity-40">
            {busy ? "Sending…" : "Send reply"}
          </button>
        </form>
      )}
    </div>
  );
}
