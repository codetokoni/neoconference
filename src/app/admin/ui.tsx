"use client";

// src/app/admin/ui.tsx — the admin area's small shared pieces: page header,
// panels, buttons, notices and a confirmation dialog for sensitive actions.

import { useEffect, useState, type ReactNode } from "react";

export const btn = {
  primary: "inline-flex items-center justify-center rounded-lg bg-cyan-500 px-3.5 py-2 text-sm font-semibold text-black transition hover:bg-cyan-400 disabled:opacity-40",
  ghost: "inline-flex items-center justify-center rounded-lg border border-white/12 px-3 py-1.5 text-sm text-zinc-200 transition hover:bg-white/5 disabled:opacity-40",
  danger: "inline-flex items-center justify-center rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-200 transition hover:bg-red-500/20 disabled:opacity-40",
  warn: "inline-flex items-center justify-center rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm font-medium text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-40",
};

export const field =
  "w-full rounded-lg border border-white/12 bg-black/40 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-cyan-400/70";

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-cyan-50">{title}</h1>
        {sub && <p className="mt-1 max-w-2xl text-sm text-zinc-400">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-white/10 bg-white/[0.03] p-4 ${className}`}>{children}</section>;
}

export function Badge({ tone = "zinc", children }: { tone?: "zinc" | "cyan" | "amber" | "red" | "green"; children: ReactNode }) {
  const tones = {
    zinc: "bg-white/5 text-zinc-300",
    cyan: "bg-cyan-400/10 text-cyan-300",
    amber: "bg-amber-400/15 text-amber-300",
    red: "bg-red-500/15 text-red-300",
    green: "bg-emerald-500/15 text-emerald-300",
  };
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

export function Notice({ kind, children, onClose }: { kind: "ok" | "err"; children: ReactNode; onClose?: () => void }) {
  return (
    <div
      role={kind === "err" ? "alert" : "status"}
      className={`mb-4 flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${
        kind === "ok" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200"
      }`}
    >
      <span>{children}</span>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Dismiss" className="text-xs opacity-70 hover:opacity-100">
          ✕
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-white/10 px-4 py-8 text-center text-sm text-zinc-500">{children}</p>;
}

export function Loading() {
  return <p className="px-1 py-6 text-sm text-zinc-500">Loading…</p>;
}

/**
 * A confirmation step for actions that are hard to undo. With `typeToConfirm`
 * the button stays disabled until that word is typed.
 */
export function Confirm({
  title,
  body,
  confirmLabel,
  danger,
  typeToConfirm,
  withReason,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  typeToConfirm?: string;
  withReason?: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onCancel]);
  const ready = !typeToConfirm || typed.trim().toLowerCase() === typeToConfirm.toLowerCase();
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="confirm-title" className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onConfirm(reason.trim());
        }}
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0B1220] p-5 shadow-2xl"
      >
        <h2 id="confirm-title" className="text-base font-semibold text-white">
          {title}
        </h2>
        <div className="mt-1 text-sm text-zinc-400">{body}</div>
        {withReason && (
          <label className="mt-3 block text-sm text-zinc-300">
            {withReason}
            <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} className={`${field} mt-1`} maxLength={300} />
          </label>
        )}
        {typeToConfirm && (
          <label className="mt-3 block text-sm text-zinc-300">
            Type <b className="font-mono text-white">{typeToConfirm}</b> to confirm
            <input autoFocus={!withReason} value={typed} onChange={(e) => setTyped(e.target.value)} className={`${field} mt-1`} />
          </label>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={btn.ghost}>
            Cancel
          </button>
          <button type="submit" disabled={!ready} className={danger ? btn.danger : btn.primary}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
