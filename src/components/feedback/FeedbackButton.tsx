'use client';

// "Send feedback" in the meeting's toolbar (src/lib/meetingFeedback.ts). It
// folds into More like the other `data-in-more` actions, and opens a dialog
// portalled to <body>: the toolbar is transformed, and a fixed overlay inside
// it would be trapped there.

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquareWarning } from 'lucide-react';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import FeedbackForm from '@/components/feedback/FeedbackForm';

export default function FeedbackButton({ eventSlug, className }: { eventSlug?: string; className: string }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);
  if (!eventSlug) return null;
  const close = () => {
    setOpen(false);
    setDone(false);
  };
  return (
    <>
      <button
        type='button'
        data-room-chrome='true'
        data-toolbar-item='true'
        data-in-more='true'
        onClick={() => setOpen(true)}
        className={className}
        title='Tell the organiser about a problem'
      >
        <MessageSquareWarning size={16} aria-hidden />
        Send feedback
      </button>
      {open &&
        createPortal(
          <div
            ref={dialogRef}
            tabIndex={-1}
            role='dialog'
            aria-modal='true'
            aria-label='Send feedback'
            onClick={close}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
            }}
            className='fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm outline-none'
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className='relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-white/15 bg-zinc-900 p-5 shadow-2xl'
            >
              <div className='mb-1 text-base font-semibold text-white'>Send feedback</div>
              <p className='mb-4 text-[12px] text-white/60'>
                Sound, video, dropping out? Tell the organiser. You stay in the meeting.
              </p>
              <FeedbackForm slug={eventSlug} where='room' autoFocus onDone={() => setDone(true)} />
              <div className='mt-4 flex justify-end'>
                <button
                  type='button'
                  onClick={close}
                  className='rounded-lg px-3 py-1.5 text-[13px] text-white/70 hover:bg-white/5 hover:text-white'
                >
                  {done ? 'Close' : 'Cancel'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
