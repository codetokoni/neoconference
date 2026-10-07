"use client";

// Put people into a group: one of yours (Moderator and up) or a new one.
// The people come from a meeting — its report, or the room — and anyone can
// be added by KingsChat handle or email. Someone with no account yet is kept
// in the group, pending, and joins the first time they sign in with that
// email or handle (POST /api/groups/[id]/members with pending: true).
//
// The app's add_to_group_sheet.dart, for the web.

import { useEffect, useRef, useState } from "react";
import { useModal } from "@/components/ui/useModal";
import { groupErrorFrom, groupErrorMessage } from "@/lib/groupMessages";
import UpgradeHint from "@/components/groups/UpgradeHint";

/** Someone who could be put in a group. */
export interface GroupCandidate {
  name: string;
  /** A line under the name: "Came · 42 min", "Invited, didn't come". */
  detail?: string;
  userId?: string;
  email?: string;
  kcHandle?: string;
  /** Was in the meeting: a new group made from that meeting takes them at once. */
  attended?: boolean;
  /** Ticked when the dialog opens. */
  selected?: boolean;
}

/** Typed text as emails and KingsChat handles: "ada@x.com" is an email; "@ada" and "ada" are handles. */
export function splitPeople(text: string): { emails: string[]; handles: string[] } {
  const emails: string[] = [];
  const handles: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const s = raw.trim();
    if (!s) continue;
    if (s.indexOf("@") > 0) emails.push(s.toLowerCase());
    else {
      const h = s.replace(/^@/, "").toLowerCase();
      if (h) handles.push(h);
    }
  }
  return { emails, handles };
}

interface MyGroup {
  id: string;
  name: string;
  role: string;
  memberCount: number;
}

interface AddResult {
  added?: unknown[];
  alreadyMembers?: unknown[];
  pending?: Array<{ kind: string; value: string }>;
  alreadyPending?: unknown[];
}

const CAN_ADD = new Set(["owner", "host", "moderator"]);
const NEW_GROUP = "";

function people(n: number): string {
  return n === 1 ? "1 person" : `${n} people`;
}

function addedText(r: AddResult): string {
  const parts = [
    r.added?.length ? `Added ${people(r.added.length)}.` : "",
    r.pending?.length
      ? `${people(r.pending.length)} without an account yet will join when they sign up: ${r.pending
          .map((p) => (p.kind === "kc" ? `@${p.value}` : p.value))
          .join(", ")}.`
      : "",
    r.alreadyMembers?.length ? `${people(r.alreadyMembers.length)} already in the group.` : "",
    r.alreadyPending?.length ? `${people(r.alreadyPending.length)} already waiting to sign up.` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : "Nobody new to add.";
}

export default function AddToGroupDialog({
  open,
  onClose,
  candidates,
  suggestedName = "",
  fromEventId,
  startNew = false,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  candidates: GroupCandidate[];
  suggestedName?: string;
  /** The meeting they came from: a new group takes those who attended at once. */
  fromEventId?: string;
  /** Straight to "a new group", with no choice of existing ones. */
  startNew?: boolean;
  /** What happened, and the group it happened in. */
  onDone: (message: string, groupId: string) => void;
}) {
  const [groups, setGroups] = useState<MyGroup[] | null>(null);
  const [target, setTarget] = useState<string | null>(startNew ? NEW_GROUP : null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [name, setName] = useState(suggestedName);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useModal(boxRef, close, { open, busy });

  // Fresh each time it opens: who is ticked, the name, the groups you can add to.
  useEffect(() => {
    if (!open) return;
    setPicked(new Set(candidates.flatMap((c, i) => (c.selected ? [i] : []))));
    setName(suggestedName);
    setTyped("");
    setErr(null);
    setTarget(startNew ? NEW_GROUP : null);
    if (startNew) return;
    let cancelled = false;
    setGroups(null);
    fetch("/api/groups", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(await groupErrorFrom(res));
        const data = (await res.json()) as { groups: MyGroup[] };
        if (!cancelled) setGroups(data.groups.filter((g) => CAN_ADD.has(g.role)));
      })
      .catch((e) => {
        if (!cancelled) {
          setGroups([]);
          setErr(e instanceof Error ? e.message : groupErrorMessage(null));
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close() {
    if (busy) return;
    onClose();
  }

  function toggle(i: number) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  const creating = target === NEW_GROUP;
  const hasPeople = picked.size > 0 || typed.trim() !== "";
  const ready = !busy && target !== null && (creating ? name.trim() !== "" : hasPeople);

  async function post(url: string, body: unknown): Promise<unknown> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await groupErrorFrom(res));
    return res.json();
  }

  async function submit() {
    if (!ready || target === null) return;
    const chosen = Array.from(picked).map((i) => candidates[i]);
    const t = splitPeople(typed);
    const userIds = new Set(chosen.flatMap((c) => (c.userId ? [c.userId] : [])));
    const emails = new Set([...chosen.flatMap((c) => (!c.userId && c.email ? [c.email] : [])), ...t.emails]);
    const handles = new Set([
      ...chosen.flatMap((c) => (!c.userId && !c.email && c.kcHandle ? [c.kcHandle] : [])),
      ...t.handles,
    ]);
    const add = (ids: Set<string>) => ({
      ...(ids.size ? { userIds: Array.from(ids) } : {}),
      ...(emails.size ? { emails: Array.from(emails) } : {}),
      ...(handles.size ? { kcHandles: Array.from(handles) } : {}),
      pending: true,
    });

    setBusy(true);
    setErr(null);
    try {
      if (creating) {
        // People who were in the meeting go in with the group itself (the
        // server checks they attended); everyone else is added after.
        const atOnce = new Set(fromEventId ? chosen.flatMap((c) => (c.attended && c.userId ? [c.userId] : [])) : []);
        const created = (await post("/api/groups", {
          name: name.trim(),
          ...(fromEventId ? { fromEventId } : {}),
          ...(fromEventId && atOnce.size ? { memberUserIds: Array.from(atOnce) } : {}),
        })) as { group: { id: string; name: string } };
        const rest = new Set(Array.from(userIds).filter((u) => !atOnce.has(u)));
        let more: AddResult = {};
        if (rest.size || emails.size || handles.size) {
          more = (await post(`/api/groups/${encodeURIComponent(created.group.id)}/members`, add(rest))) as AddResult;
        }
        const count = atOnce.size + (more.added?.length ?? 0);
        let message = `Created “${created.group.name}” with ${people(count)}.`;
        if (more.pending?.length) message += ` ${people(more.pending.length)} without an account yet will join when they sign up.`;
        onDone(message, created.group.id);
      } else {
        const result = (await post(`/api/groups/${encodeURIComponent(target)}/members`, add(userIds))) as AddResult;
        onDone(addedText(result), target);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : groupErrorMessage(null));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  const allPicked = candidates.length > 0 && picked.size === candidates.length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-to-group-title"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm sm:p-4"
      onClick={close}
    >
      <div
        ref={boxRef}
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-lg max-h-[90vh] flex flex-col rounded-t-2xl sm:rounded-2xl border border-slate-800 bg-[#0a0b12] text-slate-100 shadow-2xl overflow-hidden"
      >
        <div className="px-6 py-5 border-b border-slate-800">
          <h2 id="add-to-group-title" className="text-lg font-semibold text-slate-100">
            {startNew ? "Create a group" : "Add to a group"}
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Anyone without a NeoConference account yet joins when they sign up with that email or KingsChat handle.
          </p>
        </div>

        <div className="px-6 py-5 space-y-5 overflow-y-auto text-sm text-slate-200">
          {!startNew ? (
            <fieldset className="space-y-1">
              <legend className="text-xs uppercase tracking-widest text-slate-400 mb-1">Group</legend>
              {groups === null ? <p className="text-slate-400">Loading your groups…</p> : null}
              {(groups ?? []).map((g) => (
                <label key={g.id} className="flex items-center gap-3 rounded-lg px-3 py-2 bg-slate-900/60 border border-slate-800 hover:border-slate-700 cursor-pointer">
                  <input
                    type="radio"
                    name="add-to-group-target"
                    checked={target === g.id}
                    onChange={() => setTarget(g.id)}
                    className="h-4 w-4 accent-cyan-400"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-slate-100">{g.name}</span>
                    <span className="block text-xs text-slate-400">{g.memberCount} members</span>
                  </span>
                </label>
              ))}
              <label className="flex items-center gap-3 rounded-lg px-3 py-2 bg-slate-900/60 border border-slate-800 hover:border-slate-700 cursor-pointer">
                <input
                  type="radio"
                  name="add-to-group-target"
                  checked={creating}
                  onChange={() => setTarget(NEW_GROUP)}
                  className="h-4 w-4 accent-cyan-400"
                />
                <span className="text-slate-100">A new group</span>
              </label>
            </fieldset>
          ) : null}

          {creating ? (
            <div className="space-y-1.5">
              <label htmlFor="add-to-group-name" className="text-xs text-slate-400">
                Group name
              </label>
              <input
                id="add-to-group-name"
                type="text"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-slate-900 text-slate-100 placeholder:text-slate-500 border border-slate-700 focus:border-cyan-400 focus:outline-none text-sm"
              />
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-widest text-slate-400">
                People ({picked.size} of {candidates.length})
              </span>
              {candidates.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setPicked(allPicked ? new Set() : new Set(candidates.map((_, i) => i)))}
                  className="text-xs text-cyan-300 hover:text-cyan-200"
                >
                  {allPicked ? "Clear all" : "Select all"}
                </button>
              ) : null}
            </div>
            <ul className="space-y-1">
              {candidates.map((c, i) => (
                <li key={`${c.userId ?? c.email ?? c.kcHandle ?? c.name}-${i}`}>
                  <label className="flex items-center gap-3 rounded-lg px-3 py-2 bg-slate-900/60 border border-slate-800 hover:border-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={picked.has(i)}
                      onChange={() => toggle(i)}
                      className="h-4 w-4 accent-cyan-400"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-slate-100">{c.name}</span>
                      {c.detail ? <span className="block truncate text-xs text-slate-400">{c.detail}</span> : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="add-to-group-typed" className="text-xs text-slate-400">
              Add by KingsChat handle or email
            </label>
            <textarea
              id="add-to-group-typed"
              rows={2}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="@handle, name@example.com"
              className="w-full px-3 py-2 rounded-lg bg-slate-900 text-slate-100 placeholder:text-slate-500 border border-slate-700 focus:border-cyan-400 focus:outline-none text-sm"
            />
          </div>

          {err ? (
            <div className="text-xs text-rose-200 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{err}</div>
          ) : null}
          <UpgradeHint error={err} />
        </div>

        <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-end gap-2 bg-slate-900/40">
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="px-4 py-2 rounded-full border border-slate-700 text-slate-300 hover:border-slate-500 transition text-sm disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!ready}
            className="px-4 py-2 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition text-sm disabled:opacity-60"
          >
            {busy ? "Saving…" : creating ? "Create group" : "Add to group"}
          </button>
        </div>
      </div>
    </div>
  );
}
