"use client";

// src/app/admin/events/EventActions.tsx
// Kebab menu + 4 confirmation modals for per-row admin actions on the
// /admin/events table. Wired to the existing admin-gated API routes
// (PR B). No write actions here — all state lives in this component.
//
// Five actions, visibility rules:
//   - Join as host     : always
//   - End meeting      : state === 'live'
//   - Rename URL       : always
//   - Archive event    : state !== 'archived'   (mode='archive' on /delete)
//   - Delete event     : always (typed-confirm)

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive as ArchiveIcon,
  Loader2,
  LogIn,
  MoreVertical,
  Pencil,
  Square,
  Trash2,
} from "lucide-react";
import type { AdminEventView } from "@/types/event";
import type { ToastKind } from "./Toaster";

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

interface EventActionsProps {
  ev: AdminEventView;
  onActionComplete: () => void;
  pushToast: (t: { kind: ToastKind; text: string }) => void;
}

type ModalKind = null | "end" | "archive" | "delete" | "rename";

export default function EventActions({ ev, onActionComplete, pushToast }: EventActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [modal, setModal] = useState<ModalKind>(null);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close menu on outside-click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onClickOutside);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClickOutside);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const closeModal = useCallback(() => {
    if (busy) return;
    setModal(null);
  }, [busy]);

  const handleJoin = useCallback(() => {
    setMenuOpen(false);
    const url = `/room/${ev.livekitRoom}?event=${ev.slug}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }, [ev.livekitRoom, ev.slug]);

  const handleEnd = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/events/${ev.id}/end`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
      pushToast({ kind: "success", text: `Meeting ended: ${ev.name || ev.slug}` });
      setModal(null);
      onActionComplete();
    } catch (e) {
      pushToast({ kind: "error", text: `Failed to end: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }, [ev.id, ev.name, ev.slug, onActionComplete, pushToast]);

  const handleArchive = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/events/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: ev.slug, mode: "archive" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
      pushToast({ kind: "success", text: `Archived: ${ev.name || ev.slug}` });
      setModal(null);
      onActionComplete();
    } catch (e) {
      pushToast({ kind: "error", text: `Failed to archive: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }, [ev.slug, ev.name, onActionComplete, pushToast]);

  const handleDelete = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/events/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: ev.slug, confirm: ev.slug, mode: "delete" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
      pushToast({ kind: "success", text: `Deleted: ${ev.name || ev.slug}` });
      setModal(null);
      onActionComplete();
    } catch (e) {
      pushToast({ kind: "error", text: `Failed to delete: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }, [ev.slug, ev.name, onActionComplete, pushToast]);

  const handleRename = useCallback(
    async (newSlug: string) => {
      setBusy(true);
      try {
        const res = await fetch("/api/events/rename", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: ev.slug, newSlug }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
        pushToast({ kind: "success", text: `Renamed to /e/${newSlug}` });
        setModal(null);
        onActionComplete();
      } catch (e) {
        pushToast({ kind: "error", text: `Failed to rename: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        setBusy(false);
      }
    },
    [ev.slug, onActionComplete, pushToast]
  );

  const showEnd = ev.state === "live";
  const showArchive = ev.state !== "archived";

  return (
    <div ref={menuRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setMenuOpen((o) => !o)}
        aria-label="Event actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin text-cyan-300" aria-hidden="true" />
        ) : (
          <MoreVertical className="h-4 w-4" aria-hidden="true" />
        )}
      </button>

      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-xl border backdrop-blur-xl shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
          style={{
            background: "rgba(0,0,0,0.85)",
            borderColor: "rgba(255,255,255,0.1)",
            borderWidth: "0.5px",
          }}
        >
          <MenuItem icon={<LogIn className="h-3.5 w-3.5" />} label="Join as host" onClick={handleJoin} />
          {showEnd && (
            <MenuItem
              icon={<Square className="h-3.5 w-3.5" />}
              label="End meeting"
              onClick={() => {
                setMenuOpen(false);
                setModal("end");
              }}
            />
          )}
          <MenuItem
            icon={<Pencil className="h-3.5 w-3.5" />}
            label="Rename URL"
            onClick={() => {
              setMenuOpen(false);
              setModal("rename");
            }}
          />
          <div className="my-1 h-px bg-white/[0.08]" aria-hidden="true" />
          {showArchive && (
            <MenuItem
              icon={<ArchiveIcon className="h-3.5 w-3.5" />}
              label="Archive event"
              onClick={() => {
                setMenuOpen(false);
                setModal("archive");
              }}
            />
          )}
          <MenuItem
            icon={<Trash2 className="h-3.5 w-3.5" />}
            label="Delete event"
            destructive
            onClick={() => {
              setMenuOpen(false);
              setModal("delete");
            }}
          />
        </div>
      )}

      {modal === "end" && (
        <EndModal ev={ev} busy={busy} onCancel={closeModal} onConfirm={handleEnd} />
      )}
      {modal === "archive" && (
        <ArchiveModal ev={ev} busy={busy} onCancel={closeModal} onConfirm={handleArchive} />
      )}
      {modal === "delete" && (
        <DeleteModal ev={ev} busy={busy} onCancel={closeModal} onConfirm={handleDelete} />
      )}
      {modal === "rename" && (
        <RenameModal ev={ev} busy={busy} onCancel={closeModal} onConfirm={handleRename} />
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={[
        "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors",
        destructive
          ? "text-rose-300 hover:bg-rose-500/10"
          : "text-zinc-200 hover:bg-white/[0.06]",
      ].join(" ")}
    >
      <span className={destructive ? "text-rose-400" : "text-zinc-400"} aria-hidden="true">
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

/* ------------------------------ Modal shell ------------------------------ */

function ModalShell({
  children,
  onClose,
  busy,
  ariaLabelledBy,
}: {
  children: React.ReactNode;
  onClose: () => void;
  busy: boolean;
  ariaLabelledBy: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={ariaLabelledBy}
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={() => !busy && onClose()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-2xl border shadow-2xl"
        style={{
          background: "#0a0b12",
          borderColor: "rgba(255,255,255,0.1)",
          borderWidth: "0.5px",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/* ----------------------------- End meeting modal ----------------------------- */

function EndModal({
  ev,
  busy,
  onCancel,
  onConfirm,
}: {
  ev: AdminEventView;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <ModalShell onClose={onCancel} busy={busy} ariaLabelledBy="end-modal-title">
      <div className="px-6 py-5 border-b border-white/[0.08]">
        <h2 id="end-modal-title" className="text-lg font-semibold text-zinc-100">
          End this meeting?
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          <code className="font-mono text-zinc-400">{ev.slug}</code>
        </p>
      </div>
      <div className="px-6 py-5 space-y-3 text-sm text-zinc-300">
        <p>
          The event <span className="font-semibold text-zinc-100">{ev.name || ev.slug}</span> will be
          marked as ended.
        </p>
        <ul className="list-disc pl-5 space-y-1 text-xs text-zinc-400">
          <li>The LiveKit room will be deleted — all current participants are disconnected.</li>
          <li>The event state flips to &quot;ended&quot;.</li>
          <li>A background AI summary + chapter derivation is triggered.</li>
          <li>Cannot be undone via this UI.</li>
        </ul>
      </div>
      <div className="px-6 py-4 border-t border-white/[0.08] flex items-center justify-end gap-2">
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-full border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition hover:border-zinc-500 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="rounded-full bg-rose-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-rose-400 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {busy ? "Ending..." : "End meeting"}
        </button>
      </div>
    </ModalShell>
  );
}

/* ----------------------------- Archive modal ----------------------------- */

function ArchiveModal({
  ev,
  busy,
  onCancel,
  onConfirm,
}: {
  ev: AdminEventView;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <ModalShell onClose={onCancel} busy={busy} ariaLabelledBy="archive-modal-title">
      <div className="px-6 py-5 border-b border-white/[0.08]">
        <h2 id="archive-modal-title" className="text-lg font-semibold text-zinc-100">
          Archive this event?
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          <code className="font-mono text-zinc-400">{ev.slug}</code>
        </p>
      </div>
      <div className="px-6 py-5 space-y-3 text-sm text-zinc-300">
        <p>
          The event <span className="font-semibold text-zinc-100">{ev.name || ev.slug}</span> will
          be moved to archived state.
        </p>
        <ul className="list-disc pl-5 space-y-1 text-xs text-zinc-400">
          <li>Hidden from the public explore page and dashboards.</li>
          <li>Recordings are preserved.</li>
          <li>An admin can revive it later by flipping state back.</li>
        </ul>
      </div>
      <div className="px-6 py-4 border-t border-white/[0.08] flex items-center justify-end gap-2">
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-full border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition hover:border-zinc-500 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="rounded-full bg-amber-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-amber-400 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {busy ? "Archiving..." : "Archive"}
        </button>
      </div>
    </ModalShell>
  );
}

/* ------------------------ Delete (typed-confirm) modal ------------------------ */

function DeleteModal({
  ev,
  busy,
  onCancel,
  onConfirm,
}: {
  ev: AdminEventView;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [confirmText, setConfirmText] = useState("");
  const canDelete = confirmText.trim().toLowerCase() === ev.slug.toLowerCase() && !busy;
  return (
    <ModalShell onClose={onCancel} busy={busy} ariaLabelledBy="delete-modal-title">
      <div className="px-6 py-5 border-b border-rose-500/20 bg-rose-500/5">
        <h2 id="delete-modal-title" className="text-lg font-semibold text-rose-100">
          Permanently delete event?
        </h2>
        <p className="mt-1 text-xs text-rose-200/70">This action cannot be undone.</p>
      </div>
      <div className="px-6 py-5 space-y-4 text-sm text-zinc-300">
        <p>
          You are about to permanently delete{" "}
          <span className="font-semibold text-zinc-100">{ev.name || ev.slug}</span>.
        </p>
        <ul className="list-disc pl-5 space-y-1 text-xs text-zinc-400">
          <li>The event record and all slug aliases will be removed.</li>
          <li>It disappears from the admin events list and the public explore page.</li>
          <li>Existing share links (/e/{ev.slug}) will stop resolving.</li>
          <li>Recordings remain in storage but become orphaned.</li>
        </ul>
        <div className="space-y-1.5">
          <label htmlFor="delete-confirm-input" className="text-xs text-zinc-400">
            Type{" "}
            <code className="font-mono text-rose-200 bg-rose-500/10 px-1.5 py-0.5 rounded">
              {ev.slug}
            </code>{" "}
            to confirm:
          </label>
          <input
            id="delete-confirm-input"
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-mono text-zinc-100 outline-none transition focus:border-rose-400"
            placeholder={ev.slug}
          />
        </div>
      </div>
      <div className="px-6 py-4 border-t border-white/[0.08] flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-full border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition hover:border-zinc-500 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!canDelete}
          className="rounded-full bg-rose-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-rose-400 disabled:bg-rose-500/40 disabled:text-rose-100/60 disabled:cursor-not-allowed"
        >
          {busy ? "Deleting..." : "Delete event"}
        </button>
      </div>
    </ModalShell>
  );
}

/* ----------------------------- Rename URL modal ----------------------------- */

function RenameModal({
  ev,
  busy,
  onCancel,
  onConfirm,
}: {
  ev: AdminEventView;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (newSlug: string) => void;
}) {
  const [newSlug, setNewSlug] = useState(ev.slug);
  const trimmed = newSlug.trim().toLowerCase();
  const changed = trimmed !== ev.slug.toLowerCase();
  const valid = SLUG_REGEX.test(trimmed);
  const canSave = changed && valid && !busy;
  const validationMessage = !trimmed
    ? "Slug is required."
    : !valid
      ? "Use 1-64 chars: lowercase letters, numbers, hyphens. Cannot start/end with a hyphen."
      : !changed
        ? "New slug matches the current one."
        : "";

  return (
    <ModalShell onClose={onCancel} busy={busy} ariaLabelledBy="rename-modal-title">
      <div className="px-6 py-5 border-b border-white/[0.08]">
        <h2 id="rename-modal-title" className="text-lg font-semibold text-zinc-100">
          Rename URL
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          Current: <code className="font-mono text-zinc-400">/e/{ev.slug}</code>
        </p>
      </div>
      <div className="px-6 py-5 space-y-3 text-sm text-zinc-300">
        <p className="text-xs text-zinc-400">
          The old URL keeps working as an alias, so existing share links don&apos;t break.
        </p>
        <div className="space-y-1.5">
          <label htmlFor="rename-slug-input" className="text-xs text-zinc-400">
            New slug:
          </label>
          <input
            id="rename-slug-input"
            type="text"
            value={newSlug}
            onChange={(e) => setNewSlug(e.target.value)}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-mono text-zinc-100 outline-none transition focus:border-cyan-400"
            placeholder="new-slug"
          />
        </div>
        {trimmed && valid && (
          <p className="text-xs text-zinc-500">
            Preview: <code className="font-mono text-cyan-300">/e/{trimmed}</code>
          </p>
        )}
        {validationMessage && (
          <p className="text-xs text-amber-400/80">{validationMessage}</p>
        )}
      </div>
      <div className="px-6 py-4 border-t border-white/[0.08] flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-full border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition hover:border-zinc-500 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onConfirm(trimmed)}
          disabled={!canSave}
          className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-400 disabled:bg-cyan-500/40 disabled:text-cyan-100/60 disabled:cursor-not-allowed"
        >
          {busy ? "Saving..." : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}
