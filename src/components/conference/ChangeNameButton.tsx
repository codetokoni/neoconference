'use client';

// "Change my name" in the meeting's toolbar (and so in its More menus): the
// name everyone in the meeting sees (src/lib/attendeeName.ts
// chosenMeetingName). Saved on the account through /api/me/display-name,
// which also renames this person in the room at once, for everyone. Empty
// goes back to the default (a KingsChat handle, for instance). The name for
// attendance is separate and unchanged.

import { useId, useRef, useState } from 'react';
import { UserPen } from 'lucide-react';
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { MEETING_NAME_MAX, meetingNameProblem } from '@/lib/attendeeName';

export default function ChangeNameButton({ className }: { className: string }) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  const start = () => {
    setNext(localParticipant?.name || '');
    setErr(null);
    setOpen(true);
  };
  const close = () => {
    if (busy) return;
    setOpen(false);
    setErr(null);
  };
  const submit = async () => {
    const typed = next.trim();
    const problem = typed ? meetingNameProblem(typed) : '';
    if (problem) {
      setErr(problem);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/me/display-name', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: typed, room: room.name }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!res.ok || !j.ok) {
        setErr(j.message || 'Your name could not be changed. Try again.');
        setBusy(false);
        return;
      }
      setBusy(false);
      setOpen(false);
    } catch {
      setErr('Your name could not be changed. Check your connection and try again.');
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        data-room-chrome="true"
        data-toolbar-item="true"
        data-in-more="true"
        onClick={start}
        className={className}
        title="Change the name others see in the meeting"
      >
        <UserPen size={16} aria-hidden />
        Change my name
      </button>
      {open && (
        <div
          ref={dialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="Change my name"
          onClick={close}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
          }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 80,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            padding: 16,
            outline: 'none',
          }}
        >
          <div onClick={(e) => e.stopPropagation()} className="rounded-2xl border border-white/15 bg-zinc-900/98 backdrop-blur p-5 w-full max-w-sm shadow-2xl">
            <div className="text-base font-semibold text-white mb-1">Change my name</div>
            <div className="text-[12px] text-white/60 mb-3">
              What everyone in the meeting sees, now and in later meetings. Leave it empty to go back to your usual name.
            </div>
            <label htmlFor={inputId} className="block text-[11px] uppercase tracking-wider text-white/60 mb-1">
              Name
            </label>
            <input
              id={inputId}
              type="text"
              value={next}
              maxLength={MEETING_NAME_MAX + 20}
              onChange={(e) => setNext(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
              placeholder="e.g. Pst Grace Okon"
              className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white outline-none focus:border-cyan-300 focus:ring-2 focus:ring-cyan-300/70"
            />
            {err && (
              <div role="alert" className="text-[12px] text-rose-300 mt-2">
                {err}
              </div>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <button type="button" onClick={close} className="px-3 py-1.5 rounded-lg text-[13px] text-white/70 hover:text-white hover:bg-white/5" disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                className="px-3.5 py-1.5 rounded-lg bg-cyan-500/85 hover:bg-cyan-500 text-[13px] font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={busy}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
