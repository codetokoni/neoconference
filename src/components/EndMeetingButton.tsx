'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { X, LogOut } from 'lucide-react';

/**
 * EndMeetingButton
 *
 * FRS §6 in-room "End Meeting for Everyone" control. Renders only for
 * roomRole === 'host' (owner+host after toLegacyRole; moderators and
 * participants only see the ordinary LiveKit "Leave" button).
 *
 * Clicking opens a centered confirmation modal with the spec-required copy.
 * Confirming POSTs /api/events/[slug]/end — the route accepts slug via the
 * same byId/bySlug fallthrough used by /roles. On success the client
 * navigates to "/" while LiveKit's onDisconnected handler in page.tsx will
 * race the redirect anyway once deleteRoom lands.
 */
export default function EndMeetingButton({
  slug,
  roomRole,
}: {
  slug: string;
  roomRole?: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (roomRole !== 'host') return null;

  const closeUnlessPending = () => {
    if (pending) return;
    setConfirming(false);
    setError(null);
  };

  async function handleEnd() {
    setError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(slug)}/end`, {
        method: 'POST',
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error || 'failed_to_end');
        return;
      }
      router.replace('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-room-chrome="true"
        onClick={() => setConfirming(true)}
        title="End this meeting for everyone"
        className="inline-flex items-center gap-1.5 rounded-lg border border-red-600 bg-red-600/10 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-600/25 transition active:scale-[0.98]"
      >
        <LogOut size={16} aria-hidden />
        End meeting
      </button>

      {confirming && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          onClick={closeUnlessPending}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="end-meeting-title"
            className="w-full max-w-md rounded-3xl border border-red-500/30 bg-[#0b1020]/95 p-6 md:p-8 backdrop-blur-xl shadow-[0_0_80px_-20px_rgba(244,63,94,0.5)]"
          >
            <div className="flex items-center justify-between">
              <h3 id="end-meeting-title" className="text-lg font-semibold text-white">
                End meeting for everyone
              </h3>
              <button
                type="button"
                onClick={closeUnlessPending}
                aria-label="Close dialog"
                disabled={pending}
                className="rounded-full p-1.5 text-white/50 hover:text-white hover:bg-white/10 transition disabled:opacity-40"
              >
                <X size={18} aria-hidden />
              </button>
            </div>
            <p className="mt-4 text-sm text-white/70">
              Are you sure you want to end this meeting for everyone? This action will disconnect all attendees.
            </p>
            {error && (
              <div className="mt-4 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-xs text-red-200">
                {error}
              </div>
            )}
            <div className="mt-6 flex gap-3">
              <button
                onClick={closeUnlessPending}
                disabled={pending}
                className="flex-1 rounded-2xl border border-white/15 bg-transparent px-5 py-2.5 text-sm font-medium text-white hover:bg-white/10 transition disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleEnd}
                disabled={pending}
                className="flex-1 rounded-2xl bg-red-600 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_0_30px_-10px_rgba(220,38,38,0.8)] hover:brightness-110 transition disabled:opacity-60"
              >
                {pending ? 'Ending…' : 'End meeting'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
