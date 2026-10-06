"use client";

// "Add participants", inside the room's participants panel, for group
// meetings only: Moderators and above invite more group members or anyone
// by email into the meeting that is already running. Nothing restarts; the
// people added are let in as soon as they open the link.
//
// Renders nothing outside a group meeting, or for anyone who may not add.

import { useEffect, useState } from "react";
import MemberPicker, { type PickableMember } from "@/components/groups/MemberPicker";
import { groupErrorFrom, groupErrorMessage } from "@/lib/groupMessages";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Info {
  kind: "scheduled" | "now" | "call";
  canAdd: boolean;
  groupName: string;
  candidates: PickableMember[];
}

export default function AddGroupParticipants({ slug }: { slug: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [emails, setEmails] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Bumped after adding, so the list of members not yet in the call refreshes.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/events/${encodeURIComponent(slug)}/participants`, { cache: "no-store" });
        const data = res.ok ? ((await res.json()) as Info) : null;
        if (!cancelled) setInfo(data);
      } catch {
        if (!cancelled) setInfo(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, version]);

  if (!info?.canAdd) return null;

  const list = emails
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter(Boolean);
  const badEmail = list.find((e) => !EMAIL.test(e));

  async function add() {
    if (badEmail) {
      setMsg({ kind: "err", text: `“${badEmail}” is not an email address.` });
      return;
    }
    if (picked.size === 0 && list.length === 0) {
      setMsg({ kind: "err", text: "Choose someone, or enter an email address." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(slug)}/participants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userIds: Array.from(picked), emails: list }),
      });
      if (!res.ok) {
        setMsg({ kind: "err", text: await groupErrorFrom(res) });
        return;
      }
      const data = (await res.json()) as { added: unknown[]; notified: { sent: number; unreachable: number } };
      const n = data.added.length;
      const told =
        data.notified.unreachable > 0
          ? ` Sent to ${data.notified.sent}, couldn't reach ${data.notified.unreachable}.`
          : data.notified.sent > 0
            ? ` Sent to ${data.notified.sent}.`
            : "";
      setMsg({ kind: "ok", text: n === 0 ? "They were already invited." : `Added ${n}.${told} They can join with the meeting link.` });
      setPicked(new Set());
      setEmails("");
      setVersion((v) => v + 1);
    } catch {
      setMsg({ kind: "err", text: groupErrorMessage(null) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)", color: "#e2e8f0" }}>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setMsg(null);
        }}
        aria-expanded={open}
        style={{
          width: "100%",
          padding: "8px 10px",
          fontSize: 12,
          fontWeight: 600,
          borderRadius: 6,
          border: "1px solid rgba(34,211,238,0.5)",
          background: "rgba(34,211,238,0.12)",
          color: "#cffafe",
          cursor: "pointer",
        }}
      >
        {open ? "Close" : "Add participants"}
      </button>
      {open ? (
        <div className="mt-3 space-y-3">
          {info.kind === "call" ? (
            <MemberPicker
              members={info.candidates}
              selected={picked}
              onChange={setPicked}
              emptyText={`Everyone in ${info.groupName} is already in this call.`}
            />
          ) : (
            <p className="text-xs text-slate-300">Everyone in {info.groupName} is already invited. Add people from outside the group by email.</p>
          )}
          <div className="space-y-1">
            <label htmlFor="add-participant-emails" className="text-xs text-slate-400">
              Email addresses
            </label>
            <input
              id="add-participant-emails"
              type="text"
              inputMode="email"
              autoComplete="off"
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              placeholder="name@example.com, …"
              className="w-full px-3 py-2 rounded-lg bg-slate-900 text-slate-100 placeholder:text-slate-500 border border-slate-700 focus:border-cyan-400 focus:outline-none text-sm"
            />
          </div>
          <button
            type="button"
            onClick={add}
            disabled={busy}
            className="w-full px-4 py-2 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition text-sm disabled:opacity-60"
          >
            {busy ? "Adding…" : "Add to meeting"}
          </button>
          {msg ? <p className={"text-xs " + (msg.kind === "ok" ? "text-emerald-300" : "text-rose-300")}>{msg.text}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
