"use client";

// src/app/admin/events/EventActions.tsx
// The per-row actions menu on the Meetings list, and the confirmation for
// each action. Calls the meeting routes the owners' own pages use.
//
// Five actions, visibility rules:
//   - Join as host     : always
//   - End meeting      : state === 'live'
//   - Rename URL       : always
//   - Archive event    : state !== 'archived'   (mode='archive' on /delete)
//   - Delete event     : always (type the address to confirm)
// The four that change something need events:write.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Archive as ArchiveIcon, LogIn, MoreVertical, Pencil, Square, Trash2 } from "lucide-react";
import type { AdminEventView } from "@/types/event";
import { errorText, useAdmin } from "../AdminApi";
import { Confirm, Dialog, Notice, btn, field } from "../ui";

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type ActionResult = { kind: "ok" | "err"; text: string };

interface EventActionsProps {
  ev: AdminEventView;
  canWrite: boolean;
  /** An action is starting: clear the last result. */
  onStart: () => void;
  /** An action finished; "ok" reloads the list. */
  onDone: (r: ActionResult) => void;
}

type ModalKind = null | "end" | "archive" | "delete" | "rename";

export default function EventActions({ ev, canWrite, onStart, onDone }: EventActionsProps) {
  const { adminFetch } = useAdmin();
  const [menuOpen, setMenuOpen] = useState(false);
  const [modal, setModal] = useState<ModalKind>(null);
  const [place, setPlace] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const label = ev.name || ev.slug;

  const closeMenu = useCallback((refocus: boolean) => {
    setMenuOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // The table scrolls sideways inside its panel, so the menu is placed on the
  // page (fixed) beside its button rather than inside the table, where it
  // would be cut off; it opens upwards near the bottom of the window.
  const openMenu = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) {
      const right = Math.max(8, window.innerWidth - r.right);
      setPlace(window.innerHeight - r.bottom < 240 ? { bottom: window.innerHeight - r.top + 4, right } : { top: r.bottom + 4, right });
    }
    setMenuOpen(true);
  };

  // Close on outside click, scroll or resize; focus the first item on open.
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const onClickOutside = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onMove = () => setMenuOpen(false);
    window.addEventListener("mousedown", onClickOutside);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("mousedown", onClickOutside);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [menuOpen]);

  // ↑/↓/Home/End move between items, Escape closes and returns to the button, Tab leaves.
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => items[(n + items.length) % items.length]?.focus();
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Escape") closeMenu(true);
    else if (e.key === "Tab") return closeMenu(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const pick = (kind: Exclude<ModalKind, null>) => {
    setMenuOpen(false);
    onStart();
    setModal(kind);
  };

  const handleJoin = () => {
    closeMenu(true);
    window.open(`/room/${ev.livekitRoom}?event=${ev.slug}`, "_blank", "noopener,noreferrer");
  };

  // Each action reports to the page and closes its dialog whatever the answer.
  const run = async (call: () => Promise<{ ok: boolean; status: number; data: { message?: string; error?: string } }>, done: string, failed: string) => {
    const r = await call();
    setModal(null);
    onDone(r.ok ? { kind: "ok", text: done } : { kind: "err", text: `${failed}: ${errorText(r)}` });
  };

  const handleEnd = () => run(() => adminFetch(`/api/events/${ev.id}/end`, { method: "POST" }), `Meeting ended: ${label}`, `Could not end ${label}`);

  const handleArchive = () =>
    run(() => adminFetch("/api/events/delete", { method: "POST", json: { slug: ev.slug, mode: "archive" } }), `Archived: ${label}`, `Could not archive ${label}`);

  const handleDelete = () =>
    run(() => adminFetch("/api/events/delete", { method: "POST", json: { slug: ev.slug, confirm: ev.slug, mode: "delete" } }), `Deleted: ${label}`, `Could not delete ${label}`);

  const showEnd = canWrite && ev.state === "live";
  const showArchive = canWrite && ev.state !== "archived";

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (menuOpen ? closeMenu(false) : openMenu())}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !menuOpen) {
            e.preventDefault();
            openMenu();
          }
        }}
        aria-label={`Actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
      >
        <MoreVertical className="h-4 w-4" aria-hidden="true" />
      </button>

      {menuOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Actions for ${label}`}
          onKeyDown={onMenuKey}
          style={{ position: "fixed", top: place?.top, bottom: place?.bottom, right: place?.right ?? 8 }}
          className="z-50 w-56 overflow-hidden rounded-xl border border-white/10 bg-[#0B1220] py-1 text-left shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
        >
          <MenuItem icon={<LogIn className="h-3.5 w-3.5" />} label="Join as host" onClick={handleJoin} />
          {showEnd && <MenuItem icon={<Square className="h-3.5 w-3.5" />} label="End meeting" onClick={() => pick("end")} />}
          {canWrite && <MenuItem icon={<Pencil className="h-3.5 w-3.5" />} label="Rename URL" onClick={() => pick("rename")} />}
          {canWrite && <div className="my-1 h-px bg-white/[0.08]" role="separator" />}
          {showArchive && <MenuItem icon={<ArchiveIcon className="h-3.5 w-3.5" />} label="Archive event" onClick={() => pick("archive")} />}
          {canWrite && <MenuItem icon={<Trash2 className="h-3.5 w-3.5" />} label="Delete event" destructive onClick={() => pick("delete")} />}
        </div>
      )}

      {modal === "end" && (
        <Confirm
          title="End this meeting?"
          danger
          confirmLabel="End meeting"
          body={
            <>
              <p>
                <b className="text-zinc-100">{label}</b> (<code className="font-mono">{ev.slug}</code>) will be marked as ended.
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                <li>The LiveKit room is deleted — everyone in it is disconnected.</li>
                <li>The state becomes &quot;ended&quot;.</li>
                <li>A background AI summary and chapters are started.</li>
                <li>This cannot be undone here.</li>
              </ul>
            </>
          }
          onConfirm={handleEnd}
          onCancel={() => setModal(null)}
        />
      )}
      {modal === "archive" && (
        <Confirm
          title="Archive this event?"
          confirmLabel="Archive"
          body={
            <>
              <p>
                <b className="text-zinc-100">{label}</b> (<code className="font-mono">{ev.slug}</code>) will be moved to the archived state.
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                <li>Hidden from the public explore page and dashboards.</li>
                <li>Recordings are kept.</li>
                <li>An administrator can bring it back later by changing its state.</li>
              </ul>
            </>
          }
          onConfirm={handleArchive}
          onCancel={() => setModal(null)}
        />
      )}
      {modal === "delete" && (
        <Confirm
          title="Permanently delete this event?"
          danger
          confirmLabel="Delete event"
          typeToConfirm={ev.slug}
          body={
            <>
              <p>
                You are about to permanently delete <b className="text-zinc-100">{label}</b>. This cannot be undone.
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                <li>The event record and all its address aliases are removed.</li>
                <li>It disappears from this list and from the public explore page.</li>
                <li>Existing share links (/e/{ev.slug}) stop working.</li>
                <li>Recordings stay in storage but are no longer attached to anything.</li>
              </ul>
            </>
          }
          onConfirm={handleDelete}
          onCancel={() => setModal(null)}
        />
      )}
      {modal === "rename" && (
        <RenameDialog
          ev={ev}
          onCancel={() => setModal(null)}
          onDone={(r) => {
            setModal(null);
            onDone(r);
          }}
        />
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick, destructive }: { icon: ReactNode; label: string; onClick: () => void; destructive?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm outline-none transition-colors ${
        destructive ? "text-rose-300 hover:bg-rose-500/10 focus:bg-rose-500/10" : "text-zinc-200 hover:bg-white/[0.06] focus:bg-white/[0.08]"
      }`}
    >
      <span className={destructive ? "text-rose-400" : "text-zinc-400"} aria-hidden="true">
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

/* ----------------------------- Rename URL dialog ----------------------------- */

function RenameDialog({ ev, onCancel, onDone }: { ev: AdminEventView; onCancel: () => void; onDone: (r: ActionResult) => void }) {
  const { adminFetch } = useAdmin();
  const [newSlug, setNewSlug] = useState(ev.slug);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const trimmed = newSlug.trim().toLowerCase();
  const changed = trimmed !== ev.slug.toLowerCase();
  const valid = SLUG_REGEX.test(trimmed);
  const canSave = changed && valid && !busy;
  const validationMessage = !trimmed
    ? "An address is required."
    : !valid
      ? "Use 1–64 characters: lowercase letters, numbers and hyphens, not starting or ending with a hyphen."
      : !changed
        ? "The new address is the same as the current one."
        : "";

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    const r = await adminFetch("/api/events/rename", { method: "POST", json: { slug: ev.slug, newSlug: trimmed } });
    setBusy(false);
    // A refusal (address taken, not allowed) keeps the dialog open so it can be corrected.
    if (r.ok) onDone({ kind: "ok", text: `Renamed to /e/${trimmed}` });
    else setErr(`Could not rename: ${errorText(r)}`);
  };

  return (
    <Dialog title="Rename URL" onClose={() => !busy && onCancel()}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="mt-1 space-y-3 text-sm"
      >
        <p className="text-xs text-zinc-400">
          Current: <code className="font-mono text-zinc-300">/e/{ev.slug}</code>. The old address keeps working as an alias, so existing share links don&apos;t break.
        </p>
        {err && <Notice kind="err">{err}</Notice>}
        <label className="block text-xs text-zinc-400">
          New address
          <input
            type="text"
            value={newSlug}
            onChange={(e) => setNewSlug(e.target.value)}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            aria-invalid={!!validationMessage && changed}
            aria-describedby={`rename-help-${ev.id}`}
            className={`${field} mt-1 font-mono`}
            placeholder="new-address"
          />
        </label>
        <p id={`rename-help-${ev.id}`} className="text-xs">
          {trimmed && valid && (
            <span className="block text-zinc-400">
              Preview: <code className="font-mono text-cyan-300">/e/{trimmed}</code>
            </span>
          )}
          {validationMessage && <span className="block text-amber-400/80">{validationMessage}</span>}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className={btn.ghost}>
            Cancel
          </button>
          <button type="submit" disabled={!canSave} aria-busy={busy} className={btn.primary}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
