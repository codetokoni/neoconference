"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Roster upload / download for one room.
 *
 * Upload takes an xlsx or csv shaped like: S/N, NAME, plus whatever
 * extra columns the operator uses (COUNTRY, CONDITION, CONTACT, …).
 * NAME becomes the tile label; extras are stored as meta and the raw
 * xlsx bytes are stashed so the download re-emits the operator's own
 * layout (title rows, column order, header case, sheet name) with the
 * current NAME / meta values overlaid and a PASSCODE column appended.
 */
export default function RosterPanel({ room }: { room: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [append, setAppend] = useState(true);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const runDelete = useCallback(
    async (scope: "wipe" | "names", confirmPhrase: string, onOk: string) => {
      const typed = window.prompt(
        scope === "wipe"
          ? `This wipes every code, every name, every layout, and every claim for ${room}. Type "${confirmPhrase}" to confirm.`
          : `This resets every tile's name back to "Child N" and clears meta for ${room}. Codes stay valid. Type "${confirmPhrase}" to confirm.`,
      );
      if (typed?.trim().toLowerCase() !== confirmPhrase) {
        setMsg({ kind: "err", text: "Cancelled." });
        return;
      }
      setBusy(true);
      setMsg(null);
      try {
        const r = await fetch(
          `/api/video/room/roster?room=${encodeURIComponent(room)}&scope=${scope}`,
          { method: "DELETE" },
        );
        const j = await r.json();
        if (!j.ok) {
          setMsg({ kind: "err", text: j.error ?? "Delete failed." });
          return;
        }
        setMsg({
          kind: "ok",
          text: scope === "names" && typeof j.reset === "number" ? `${onOk} (${j.reset} slot${j.reset === 1 ? "" : "s"} reset)` : onOk,
        });
      } catch {
        setMsg({ kind: "err", text: "Delete failed. Check your connection." });
      } finally {
        setBusy(false);
      }
    },
    [room],
  );

  const onUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setBusy(true);
      setMsg(null);
      try {
        const form = new FormData();
        form.append("file", file);
        if (append) form.append("append", "1");
        const r = await fetch(
          `/api/video/room/roster?room=${encodeURIComponent(room)}`,
          { method: "POST", body: form },
        );
        const j = await r.json();
        if (!j.ok) {
          setMsg({ kind: "err", text: j.error ?? "Could not upload." });
          return;
        }
        const parts: string[] = [];
        if (j.updated) parts.push(`${j.updated} renamed`);
        if (j.created) parts.push(`${j.created} new slot${j.created === 1 ? "" : "s"} minted`);
        setMsg({
          kind: "ok",
          text: parts.length ? parts.join(" · ") : "No changes applied.",
        });
      } catch {
        setMsg({ kind: "err", text: "Upload failed. Check your connection." });
      } finally {
        setBusy(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [room, append],
  );

  const downloadHref = `/api/video/room/roster?room=${encodeURIComponent(room)}`;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
        Participants
      </h2>
      <div className="grid gap-3 rounded-xl border border-white/12 bg-[#141C22] p-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
            Upload roster
          </span>
          <label
            className={
              "inline-flex cursor-pointer items-center justify-center rounded-md border border-white/12 bg-[#0B1319] px-4 py-2 text-sm text-white transition hover:bg-white/10" +
              (busy ? " opacity-40" : "")
            }
          >
            {busy ? "Uploading…" : "Choose .xlsx / .csv file"}
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
              className="hidden"
              onChange={onUpload}
              disabled={busy}
            />
          </label>
          <label className="mt-1 inline-flex cursor-pointer items-center gap-2 text-xs text-white/70">
            <input
              type="checkbox"
              checked={append}
              onChange={(e) => setAppend(e.target.checked)}
              className="h-3.5 w-3.5 accent-emerald-500"
            />
            <span>
              Append after existing rows
              <span className="ml-1 text-white/45">(ignores S/N)</span>
            </span>
          </label>
          <p className="text-xs text-white/60">
            Needs a <b>NAME</b> column. Extras (COUNTRY, CONDITION, …) are preserved.
            <br />
            <b>Append on</b> — the default — places the file's rows immediately after
            the last named slot, so a second xlsx doesn't overwrite the first.
            <br />
            <b>Append off</b> — the file's <b>S/N</b> becomes the target slot, and
            rows without S/N fall in by order starting at slot 1 (overwrites).
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
            Download roster
          </span>
          <a
            href={downloadHref}
            className="inline-flex items-center justify-center rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500"
          >
            Download .xlsx with codes
          </a>
          <p className="text-xs text-white/60">
            The exact file you uploaded, with a <b>PASSCODE</b> column added and any
            name/condition edits reflected. Slots not touched by upload keep their
            auto-generated names.
          </p>
        </div>
      </div>

      {msg && (
        <p className={"text-sm " + (msg.kind === "ok" ? "text-emerald-300" : "text-red-400")}>
          {msg.text}
        </p>
      )}

      <p className="text-xs text-white/60">
        Typo in a name or condition after upload?{" "}
        <a
          href={`/video/room/roster/edit?room=${encodeURIComponent(room)}`}
          className="text-emerald-300 underline decoration-dotted underline-offset-2 hover:text-emerald-200"
        >
          Fix one row at a time
        </a>{" "}
        without re-uploading the whole spreadsheet.
      </p>

      <div className="mt-2 flex flex-col gap-3 rounded-xl border border-red-500/25 bg-red-950/20 p-4">
        <div>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-red-300/80">
            Danger zone
          </span>
          <p className="mt-1 text-xs text-white/60">
            Two destructive actions. Both ask you to type a confirm phrase before
            running — no undo.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => runDelete("names", "clear", "Names cleared.")}
              disabled={busy}
              className={
                "inline-flex items-center justify-center rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/20" +
                (busy ? " opacity-40" : "")
              }
            >
              Clear names only
            </button>
            <p className="text-xs text-white/60">
              Tiles go back to <b>Child 1</b>, <b>Child 2</b>… and meta is cleared.
              Codes stay valid — participants already holding a code still join.
              Confirm phrase: <code className="text-white/80">clear</code>.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => runDelete("wipe", "wipe", "Room wiped.")}
              disabled={busy}
              className={
                "inline-flex items-center justify-center rounded-md border border-red-500/50 bg-red-500/15 px-4 py-2 text-sm font-semibold text-red-200 transition hover:bg-red-500/25" +
                (busy ? " opacity-40" : "")
              }
            >
              Wipe room completely
            </button>
            <p className="text-xs text-white/60">
              Deletes every code, prefix, layout, and claim. Old codes stop
              working. Next upload starts fresh on a new prefix. Confirm phrase:{" "}
              <code className="text-white/80">wipe</code>.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
