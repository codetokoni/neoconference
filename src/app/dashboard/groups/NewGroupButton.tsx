"use client";

import { useRef, useState } from "react";
import { useModal } from "@/components/ui/useModal";
import { useRouter } from "next/navigation";
import { groupErrorFrom, groupErrorMessage } from "@/lib/groupMessages";

/** "New group": a name and an optional description; you become the Owner. */
export default function NewGroupButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const nameError = touched && !name.trim() ? "Give the group a name." : null;
  const boxRef = useRef<HTMLFormElement>(null);
  useModal(boxRef, close, { open, busy: submitting });

  function close() {
    if (submitting) return;
    setOpen(false);
    setName("");
    setDescription("");
    setTouched(false);
    setErr(null);
  }

  async function create() {
    setTouched(true);
    if (!name.trim()) return;
    setErr(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() }),
      });
      if (!res.ok) {
        setErr(await groupErrorFrom(res));
        setSubmitting(false);
        return;
      }
      const data = (await res.json()) as { group: { id: string } };
      router.push(`/dashboard/groups/${encodeURIComponent(data.group.id)}`);
    } catch {
      setErr(groupErrorMessage(null));
      setSubmitting(false);
    }
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="neo-btn text-sm px-4 py-2.5">
        + New group
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-group-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={close}
        >
          <form
            ref={boxRef}
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
            className="w-full max-w-md rounded-2xl border border-slate-800 bg-[#0a0b12] text-slate-100 shadow-2xl overflow-hidden"
          >
            <div className="px-6 py-5 border-b border-slate-800">
              <h2 id="new-group-title" className="text-lg font-semibold text-slate-100">
                New group
              </h2>
              <p className="text-xs text-slate-400 mt-1">You will be the group&apos;s Owner.</p>
            </div>
            <div className="px-6 py-5 space-y-4 text-sm">
              <div className="space-y-1.5">
                <label htmlFor="new-group-name" className="text-xs text-slate-400">
                  Name
                </label>
                <input
                  id="new-group-name"
                  type="text"
                  value={name}
                  maxLength={80}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setTouched(true)}
                  aria-invalid={nameError ? true : undefined}
                  aria-describedby={nameError ? "new-group-name-error" : undefined}
                  className={
                    "w-full px-3 py-2 rounded-lg bg-slate-900 text-slate-100 placeholder:text-slate-500 border focus:outline-none " +
                    (nameError ? "border-rose-500 focus:border-rose-400" : "border-slate-700 focus:border-cyan-400")
                  }
                  placeholder="Sunday workers"
                />
                {nameError ? (
                  <p id="new-group-name-error" className="text-xs text-rose-300">
                    {nameError}
                  </p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <label htmlFor="new-group-description" className="text-xs text-slate-400">
                  Description (optional)
                </label>
                <textarea
                  id="new-group-description"
                  value={description}
                  maxLength={500}
                  rows={3}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 text-slate-100 placeholder:text-slate-500 border border-slate-700 focus:border-cyan-400 focus:outline-none resize-none"
                />
              </div>
              {err ? (
                <div className="text-xs text-rose-200 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">
                  {err}
                </div>
              ) : null}
            </div>
            <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-end gap-2 bg-slate-900/40">
              <button
                type="button"
                onClick={close}
                disabled={submitting}
                className="px-4 py-2 rounded-full border border-slate-700 text-slate-300 hover:border-slate-500 transition text-sm disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition text-sm disabled:opacity-60"
              >
                {submitting ? "Creating…" : "Create group"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
