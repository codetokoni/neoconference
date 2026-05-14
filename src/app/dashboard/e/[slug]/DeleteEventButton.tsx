"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function DeleteEventButton({
  slug,
  name,
}: {
  slug: string;
  name: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canDelete =
    confirmText.trim().toLowerCase() === slug.toLowerCase() && !submitting;

  function close() {
    if (submitting) return;
    setOpen(false);
    setConfirmText("");
    setErr(null);
  }

  async function handleDelete() {
    if (!canDelete) return;
    setErr(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/events/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, confirm: confirmText.trim().toLowerCase() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "delete_failed");
      }
      // Event is gone — go back to dashboard.
      router.push("/dashboard");
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "delete_failed");
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 rounded-full border border-rose-500/50 text-rose-200 hover:bg-rose-500/15 transition text-sm font-medium"
      >
        Delete meeting...
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={close}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-rose-500/30 bg-[#0a0b12] shadow-2xl overflow-hidden"
          >
            <div className="px-6 py-5 border-b border-rose-500/20 bg-rose-500/5">
              <h2 className="text-lg font-semibold text-rose-100">Delete meeting</h2>
              <p className="text-xs text-rose-200/70 mt-1">
                This action cannot be undone.
              </p>
            </div>

            <div className="px-6 py-5 space-y-4 text-sm text-slate-200">
              <p>
                You are about to permanently delete{" "}
                <span className="font-semibold text-white">{name}</span>.
              </p>
              <ul className="text-xs text-slate-400 list-disc pl-5 space-y-1">
                <li>The event record and all slug aliases will be removed.</li>
                <li>It will disappear from your dashboard.</li>
                <li>Existing share links (/e/{slug}) will stop resolving.</li>
                <li>S3 recording files are NOT touched.</li>
              </ul>

              <div className="space-y-1.5">
                <label className="text-xs text-slate-400">
                  Type{" "}
                  <code className="font-mono text-rose-200 bg-rose-500/10 px-1.5 py-0.5 rounded">
                    {slug}
                  </code>{" "}
                  to confirm:
                </label>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 focus:border-rose-400 focus:outline-none text-sm font-mono"
                  placeholder={slug}
                />
              </div>

              {err ? (
                <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">
                  {err}
                </div>
              ) : null}
            </div>

            <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-end gap-2 bg-slate-900/40">
              <button
                onClick={close}
                disabled={submitting}
                className="px-4 py-2 rounded-full border border-slate-700 text-slate-300 hover:border-slate-500 transition text-sm disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={!canDelete}
                className="px-4 py-2 rounded-full bg-rose-500 text-slate-950 font-medium hover:bg-rose-400 transition text-sm disabled:bg-rose-500/40 disabled:text-rose-100/60 disabled:cursor-not-allowed"
              >
                {submitting ? "Deleting..." : "Delete meeting"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
