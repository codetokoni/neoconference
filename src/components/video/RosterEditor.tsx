"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface Participant {
  slot: number;
  name: string;
  code: string;
  streamId: string;
  live: boolean;
  claimed: boolean;
  meta?: Record<string, string>;
}

interface Draft {
  name: string;
  condition: string;
  country: string;
  contact: string;
}

interface RowState {
  draft: Draft;
  saving: boolean;
  saved: boolean;
  deleting: boolean;
  error: string | null;
}

const EDITABLE_META = ["condition", "country", "contact"] as const;

function toDraft(p: Participant): Draft {
  return {
    name: p.name,
    condition: p.meta?.condition ?? "",
    country: p.meta?.country ?? "",
    contact: p.meta?.contact ?? "",
  };
}

function dirty(a: Draft, b: Draft): boolean {
  return a.name !== b.name || a.condition !== b.condition || a.country !== b.country || a.contact !== b.contact;
}

/**
 * Per-slot editor for the participant roster.
 *
 * Loads every participant from /api/video/room?screen=all, renders them
 * as an editable table (Name, Condition, Country, Contact), and saves
 * one row at a time via PATCH /api/video/room/roster/participant. The
 * Save button per row lights up when the row is dirty and fades to a
 * green tick when the PATCH lands — no autosave, so a mid-edit tab
 * refresh loses the draft but never publishes half a change.
 *
 * Code and streamId are read-only. A code that has already been handed
 * to a participant must not silently change under them.
 */
export default function RosterEditor({ room }: { room: string }) {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [rows, setRows] = useState<Record<number, RowState>>({});
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(
        `/api/video/room?room=${encodeURIComponent(room)}&screen=all`,
        { cache: "no-store" },
      );
      const j = await r.json();
      if (!j.ok) {
        setErr(
          j.error === "forbidden"
            ? "You do not have control-room access."
            : "Could not load.",
        );
        return;
      }
      setErr(null);
      const parts = j.participants as Participant[];
      setParticipants(parts);
      setRows((prev) => {
        const next: Record<number, RowState> = { ...prev };
        for (const p of parts) {
          // Preserve in-progress drafts across a reload; seed only fresh rows.
          if (!next[p.slot]) {
            next[p.slot] = {
              draft: toDraft(p),
              saving: false,
              saved: false,
              deleting: false,
              error: null,
            };
          }
        }
        return next;
      });
    } catch {
      /* transient */
    }
  }, [room]);

  useEffect(() => {
    load();
  }, [load]);

  const setDraftField = useCallback(
    (slot: number, field: keyof Draft, value: string) => {
      setRows((prev) => {
        const cur = prev[slot];
        if (!cur) return prev;
        return {
          ...prev,
          [slot]: {
            ...cur,
            draft: { ...cur.draft, [field]: value },
            saved: false,
            error: null,
          },
        };
      });
    },
    [],
  );

  const save = useCallback(
    async (p: Participant) => {
      const row = rows[p.slot];
      if (!row) return;
      const draft = row.draft;

      setRows((prev) => ({
        ...prev,
        [p.slot]: { ...row, saving: true, saved: false, error: null },
      }));

      try {
        const r = await fetch(
          `/api/video/room/roster/participant?room=${encodeURIComponent(room)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              slot: p.slot,
              name: draft.name,
              meta: {
                condition: draft.condition,
                country: draft.country,
                contact: draft.contact,
              },
            }),
          },
        );
        const j = await r.json();
        if (!j.ok) {
          setRows((prev) => ({
            ...prev,
            [p.slot]: {
              ...(prev[p.slot] ?? row),
              saving: false,
              error: j.error ?? "Save failed.",
            },
          }));
          return;
        }

        const updated: Participant = { ...p, name: draft.name, meta: j.participant.meta };
        setParticipants((prev) => prev.map((x) => (x.slot === p.slot ? updated : x)));
        setRows((prev) => ({
          ...prev,
          [p.slot]: {
            draft: toDraft(updated),
            saving: false,
            saved: true,
            deleting: false,
            error: null,
          },
        }));
        window.setTimeout(() => {
          setRows((prev) => {
            const cur = prev[p.slot];
            if (!cur || !cur.saved) return prev;
            return { ...prev, [p.slot]: { ...cur, saved: false } };
          });
        }, 1500);
      } catch {
        setRows((prev) => ({
          ...prev,
          [p.slot]: {
            ...(prev[p.slot] ?? row),
            saving: false,
            error: "Save failed. Check your connection.",
          },
        }));
      }
    },
    [rows, room],
  );

  const remove = useCallback(
    async (p: Participant) => {
      // Confirmation is intentional — this deletes the slot's code, and
      // anyone holding that code loses their invite immediately.
      const ok = window.confirm(
        `Remove slot ${p.slot} (${p.name || "unnamed"}, code ${p.code})? The code stops working immediately.`,
      );
      if (!ok) return;
      setRows((prev) => {
        const cur = prev[p.slot];
        if (!cur) return prev;
        return { ...prev, [p.slot]: { ...cur, deleting: true, error: null } };
      });
      try {
        const r = await fetch(
          `/api/video/room/roster/participant?room=${encodeURIComponent(room)}&slot=${p.slot}`,
          { method: "DELETE" },
        );
        const j = await r.json();
        if (!j.ok) {
          setRows((prev) => {
            const cur = prev[p.slot];
            if (!cur) return prev;
            return {
              ...prev,
              [p.slot]: { ...cur, deleting: false, error: j.error ?? "Delete failed." },
            };
          });
          return;
        }
        // Drop the participant + row state in one pass so the table
        // doesn't flash a "deleting…" cell before it disappears.
        setParticipants((prev) => prev.filter((x) => x.slot !== p.slot));
        setRows((prev) => {
          const next = { ...prev };
          delete next[p.slot];
          return next;
        });
      } catch {
        setRows((prev) => {
          const cur = prev[p.slot];
          if (!cur) return prev;
          return {
            ...prev,
            [p.slot]: { ...cur, deleting: false, error: "Delete failed. Check your connection." },
          };
        });
      }
    },
    [room],
  );

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return participants;
    return participants.filter((p) => {
      if (String(p.slot).includes(q)) return true;
      if (p.name.toLowerCase().includes(q)) return true;
      if (p.code.toLowerCase().includes(q)) return true;
      const m = p.meta ?? {};
      for (const k of EDITABLE_META) {
        if ((m[k] ?? "").toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [participants, filter]);

  if (err && participants.length === 0) {
    return <p className="text-sm text-red-400">{err}</p>;
  }
  if (participants.length === 0) {
    return (
      <p className="font-mono text-xs uppercase tracking-[0.14em] text-white/45">
        Loading…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {err && <p className="text-sm text-red-400">{err}</p>}

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/12 bg-[#141C22] p-3">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by slot, name, code, or any field"
          className="min-w-[240px] flex-1 rounded-md border border-white/12 bg-[#0B1319] px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:ring-2 focus:ring-emerald-500"
        />
        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-white/45">
          {visible.length} of {participants.length} shown
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-white/12 bg-[#101820]">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left">
              <Th>#</Th>
              <Th>Code</Th>
              <Th className="min-w-[180px]">Name</Th>
              <Th className="min-w-[240px]">Condition</Th>
              <Th className="min-w-[140px]">Country</Th>
              <Th className="min-w-[140px]">Contact</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => {
              const row = rows[p.slot];
              if (!row) return null;
              const original = toDraft(p);
              const isDirty = dirty(row.draft, original);
              return (
                <tr
                  key={p.streamId}
                  className="border-b border-white/5 last:border-b-0 hover:bg-white/[0.02]"
                >
                  <Td className="font-mono text-[11px] text-white/45">
                    {String(p.slot).padStart(2, "0")}
                  </Td>
                  <Td>
                    <CodeChip code={p.code} />
                  </Td>
                  <Td>
                    <RowInput
                      value={row.draft.name}
                      onChange={(v) => setDraftField(p.slot, "name", v)}
                    />
                  </Td>
                  <Td>
                    <RowTextarea
                      value={row.draft.condition}
                      onChange={(v) => setDraftField(p.slot, "condition", v)}
                    />
                  </Td>
                  <Td>
                    <RowInput
                      value={row.draft.country}
                      onChange={(v) => setDraftField(p.slot, "country", v)}
                    />
                  </Td>
                  <Td>
                    <RowInput
                      value={row.draft.contact}
                      onChange={(v) => setDraftField(p.slot, "contact", v)}
                    />
                  </Td>
                  <Td className="whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={!isDirty || row.saving || row.deleting}
                        onClick={() => save(p)}
                        className={
                          "rounded-md px-3 py-1.5 text-xs font-semibold transition disabled:opacity-40 " +
                          (isDirty
                            ? "bg-emerald-600 text-white hover:bg-emerald-500"
                            : "border border-white/12 text-white/45")
                        }
                      >
                        {row.saving ? "Saving…" : isDirty ? "Save" : "Saved"}
                      </button>
                      <button
                        type="button"
                        disabled={row.saving || row.deleting}
                        onClick={() => remove(p)}
                        className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-200 transition hover:bg-red-500/20 disabled:opacity-40"
                        title="Delete this slot — the code stops working immediately"
                      >
                        {row.deleting ? "Deleting…" : "Delete"}
                      </button>
                      {row.saved && (
                        <span className="font-mono text-[10px] text-emerald-300">✓</span>
                      )}
                      {row.error && (
                        <span className="font-mono text-[10px] text-red-400">{row.error}</span>
                      )}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={
        "px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-white/45 " +
        (className ?? "")
      }
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={"px-3 py-1.5 " + (className ?? "")}>{children}</td>;
}

/**
 * The participant's passcode as a clickable chip. Bigger and brighter
 * than the plain text it replaces so an admin scanning the roster can
 * read codes at a glance, and one click copies the code to the
 * clipboard for pasting into a mailer / DM. Tick feedback lasts a
 * beat so a quick multi-copy pass is comfortable.
 */
function CodeChip({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — the code is still visible for manual copy */
    }
  }, [code]);
  return (
    <button
      type="button"
      onClick={onCopy}
      title="Click to copy"
      className={
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-sm font-semibold transition " +
        (copied
          ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-200"
          : "border-emerald-500/25 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20")
      }
    >
      <span>{code}</span>
      <span className="text-[10px] font-normal text-emerald-300/70">
        {copied ? "copied" : "copy"}
      </span>
    </button>
  );
}

function RowInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-white/10 bg-[#0B1319] px-2 py-1.5 text-sm text-white outline-none focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/60"
    />
  );
}

/**
 * Multi-line variant for Condition. Roster conditions are comma-separated
 * clinical notes — SOFT TISSUE CARCINOMA, ANEMIA / CHRONIC HEADACHE,
 * PHOTOBIA, HEART DISEASE — and single-line inputs clip them so the
 * operator can't see what they're editing. Wraps to fit the column, grows
 * with the content.
 */
function RowTextarea({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={2}
      className="min-h-[38px] w-full resize-y rounded-md border border-white/10 bg-[#0B1319] px-2 py-1.5 text-sm leading-snug text-white outline-none focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/60"
    />
  );
}
