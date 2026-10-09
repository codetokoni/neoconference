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
  /** One value per column, keyed by the lowercased column name. */
  meta: Record<string, string>;
}

interface RowState {
  draft: Draft;
  saving: boolean;
  saved: boolean;
  deleting: boolean;
  error: string | null;
}

/** Columns that hold long notes get a growing textarea, not a one-line input. */
const LONG_TEXT = new Set(["condition"]);

/** A column name as the roster stores it: lowercased, single-spaced. */
function columnKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 60);
}

function toDraft(p: Participant, columns: string[]): Draft {
  const meta: Record<string, string> = {};
  for (const c of columns) meta[c] = p.meta?.[c] ?? "";
  return { name: p.name, meta };
}

function dirty(a: Draft, b: Draft, columns: string[]): boolean {
  return a.name !== b.name || columns.some((c) => (a.meta[c] ?? "") !== (b.meta[c] ?? ""));
}

/**
 * Per-slot editor for the participant roster.
 *
 * Loads every participant from /api/video/room?screen=all and renders them
 * as an editable table: Name, then one column per roster field — whatever
 * the uploaded spreadsheet had (Region, Country, Center…; Condition and
 * Contact for the children's rosters) plus any added here with "Add
 * column". Rows save one at a time via PATCH
 * /api/video/room/roster/participant; "Add person" makes a new
 * participant, and their code, with POST to the same route. No autosave,
 * so a mid-edit tab refresh loses the draft but never publishes half a
 * change.
 *
 * Code and streamId are read-only. A code that has already been handed
 * to a participant must not silently change under them.
 */
export default function RosterEditor({ room }: { room: string }) {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [rows, setRows] = useState<Record<number, RowState>>({});
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // Columns added in this visit, before any row has a value in them.
  const [addedColumns, setAddedColumns] = useState<string[]>([]);
  const [newColumn, setNewColumn] = useState("");
  const [newPerson, setNewPerson] = useState<Draft>({ name: "", meta: {} });
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<number | null>(null);

  // Every roster field in use, in the order it first appears, then the
  // ones added here.
  const columns = useMemo(() => {
    const seen: string[] = [];
    for (const p of participants) {
      for (const k of Object.keys(p.meta ?? {})) if (!seen.includes(k)) seen.push(k);
    }
    for (const k of addedColumns) if (!seen.includes(k)) seen.push(k);
    return seen;
  }, [participants, addedColumns]);

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
      setParticipants(j.participants as Participant[]);
      setLoaded(true);
    } catch {
      /* transient */
    }
  }, [room]);

  useEffect(() => {
    load();
  }, [load]);

  // Seed row state for participants that don't have one yet, keeping
  // in-progress drafts across a reload; a column added later shows up as
  // an empty field in every draft.
  useEffect(() => {
    setRows((prev) => {
      const next: Record<number, RowState> = { ...prev };
      for (const p of participants) {
        const cur = next[p.slot];
        if (!cur) {
          next[p.slot] = { draft: toDraft(p, columns), saving: false, saved: false, deleting: false, error: null };
        } else if (columns.some((c) => !(c in cur.draft.meta))) {
          const meta = { ...cur.draft.meta };
          for (const c of columns) if (!(c in meta)) meta[c] = p.meta?.[c] ?? "";
          next[p.slot] = { ...cur, draft: { ...cur.draft, meta } };
        }
      }
      return next;
    });
  }, [participants, columns]);

  const setDraftName = useCallback((slot: number, value: string) => {
    setRows((prev) => {
      const cur = prev[slot];
      if (!cur) return prev;
      return { ...prev, [slot]: { ...cur, draft: { ...cur.draft, name: value }, saved: false, error: null } };
    });
  }, []);

  const setDraftMeta = useCallback((slot: number, column: string, value: string) => {
    setRows((prev) => {
      const cur = prev[slot];
      if (!cur) return prev;
      return {
        ...prev,
        [slot]: { ...cur, draft: { ...cur.draft, meta: { ...cur.draft.meta, [column]: value } }, saved: false, error: null },
      };
    });
  }, []);

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
            // Every column is sent: an emptied field clears that value.
            body: JSON.stringify({ slot: p.slot, name: draft.name, meta: draft.meta }),
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

        const updated: Participant = { ...p, name: j.participant.name, meta: j.participant.meta };
        setParticipants((prev) => prev.map((x) => (x.slot === p.slot ? updated : x)));
        setRows((prev) => ({
          ...prev,
          [p.slot]: {
            draft: toDraft(updated, columns),
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
    [rows, room, columns],
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

  const addColumn = useCallback(() => {
    const key = columnKey(newColumn);
    if (!key || key === "name" || key === "passcode" || key === "code") return;
    setAddedColumns((prev) => (prev.includes(key) ? prev : [...prev, key]));
    setNewColumn("");
  }, [newColumn]);

  const addPerson = useCallback(async () => {
    const name = newPerson.name.trim();
    if (!name || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      const r = await fetch(
        `/api/video/room/roster/participant?room=${encodeURIComponent(room)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, meta: newPerson.meta }),
        },
      );
      const j = await r.json();
      if (!j.ok) {
        setAddError(j.error ?? "Could not add them.");
        return;
      }
      const added = j.participant as Participant;
      // Taking over an unused "Child N" slot replaces that row; otherwise
      // the new slot joins the end.
      setParticipants((prev) =>
        [...prev.filter((x) => x.slot !== added.slot), { ...added, live: false, claimed: false }].sort(
          (a, b) => a.slot - b.slot,
        ),
      );
      setRows((prev) => {
        const next = { ...prev };
        delete next[added.slot]; // re-seeded from the saved record
        return next;
      });
      setNewPerson({ name: "", meta: {} });
      setJustAdded(added.slot);
    } catch {
      setAddError("Could not add them. Check your connection.");
    } finally {
      setAdding(false);
    }
  }, [newPerson, adding, room]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return participants;
    return participants.filter((p) => {
      if (String(p.slot).includes(q)) return true;
      if (p.name.toLowerCase().includes(q)) return true;
      if (p.code.toLowerCase().includes(q)) return true;
      return Object.values(p.meta ?? {}).some((v) => v.toLowerCase().includes(q));
    });
  }, [participants, filter]);

  if (err && participants.length === 0) {
    return <p className="text-sm text-red-400">{err}</p>;
  }
  if (!loaded) {
    return (
      <p className="font-mono text-xs uppercase tracking-[0.14em] text-white/45">
        Loading…
      </p>
    );
  }

  const added = justAdded != null ? participants.find((p) => p.slot === justAdded) : undefined;

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
        <form
          onSubmit={(e) => {
            e.preventDefault();
            addColumn();
          }}
          className="flex items-center gap-2"
        >
          <input
            value={newColumn}
            onChange={(e) => setNewColumn(e.target.value)}
            placeholder="New column, e.g. Region"
            aria-label="New column name"
            className="w-[190px] rounded-md border border-white/12 bg-[#0B1319] px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:ring-2 focus:ring-emerald-500"
          />
          <button
            type="submit"
            disabled={!columnKey(newColumn)}
            className="rounded-md border border-white/15 px-3 py-2 text-xs font-semibold text-white/80 transition hover:bg-white/10 disabled:opacity-40"
          >
            Add column
          </button>
        </form>
        <a
          href={`/api/video/room/roster?room=${encodeURIComponent(room)}`}
          className="rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500"
        >
          Download Excel
        </a>
      </div>

      {addedColumns.some((c) => !participants.some((p) => p.meta?.[c])) && (
        <p className="text-xs text-white/50">
          A new column is kept once a row has a value in it: fill it in and press Save on that row.
        </p>
      )}

      {added && (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
          Added <b>{added.name}</b> in slot {added.slot}. Their code is{" "}
          <span className="font-mono font-semibold">{added.code}</span>.
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-white/12 bg-[#101820]">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left">
              <Th>#</Th>
              <Th>Code</Th>
              <Th className="min-w-[180px]">Name</Th>
              {columns.map((c) => (
                <Th key={c} className={LONG_TEXT.has(c) ? "min-w-[240px]" : "min-w-[140px]"}>
                  {c}
                </Th>
              ))}
              <Th />
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-white/10 bg-emerald-500/[0.04]">
              <Td className="font-mono text-[11px] text-white/45">new</Td>
              <Td className="font-mono text-[11px] text-white/45">made on add</Td>
              <Td>
                <RowInput
                  value={newPerson.name}
                  placeholder="Name (required)"
                  label="New person's name"
                  onChange={(v) => setNewPerson((d) => ({ ...d, name: v }))}
                  onEnter={addPerson}
                />
              </Td>
              {columns.map((c) => (
                <Td key={c}>
                  <RowInput
                    value={newPerson.meta[c] ?? ""}
                    label={`New person's ${c}`}
                    onChange={(v) => setNewPerson((d) => ({ ...d, meta: { ...d.meta, [c]: v } }))}
                    onEnter={addPerson}
                  />
                </Td>
              ))}
              <Td className="whitespace-nowrap">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={!newPerson.name.trim() || adding}
                    onClick={addPerson}
                    className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
                  >
                    {adding ? "Adding…" : "Add person"}
                  </button>
                  {addError && <span className="font-mono text-[10px] text-red-400">{addError}</span>}
                </div>
              </Td>
            </tr>
            {visible.map((p) => {
              const row = rows[p.slot];
              if (!row) return null;
              const isDirty = dirty(row.draft, toDraft(p, columns), columns);
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
                    <RowInput value={row.draft.name} onChange={(v) => setDraftName(p.slot, v)} />
                  </Td>
                  {columns.map((c) => (
                    <Td key={c}>
                      {LONG_TEXT.has(c) ? (
                        <RowTextarea
                          value={row.draft.meta[c] ?? ""}
                          onChange={(v) => setDraftMeta(p.slot, c, v)}
                        />
                      ) : (
                        <RowInput
                          value={row.draft.meta[c] ?? ""}
                          onChange={(v) => setDraftMeta(p.slot, c, v)}
                        />
                      )}
                    </Td>
                  ))}
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
  placeholder,
  label,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
  onEnter?: () => void;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onEnter ? (e) => e.key === "Enter" && onEnter() : undefined}
      placeholder={placeholder}
      aria-label={label}
      className="w-full rounded-md border border-white/10 bg-[#0B1319] px-2 py-1.5 text-sm text-white outline-none placeholder:text-white/30 focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/60"
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
