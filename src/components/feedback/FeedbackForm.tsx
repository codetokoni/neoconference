'use client';

// Feedback on a meeting (src/lib/meetingFeedback.ts), in three places:
//
//   where="link"   /feedback/<slug>: works for someone who could not get in
//   where="room"   "Send feedback" inside the meeting
//   where="after"  after leaving: "How was the meeting?" stars first, a tap
//                  each, then words if they want to say more
//
// Signed out, the server wants the form token from GET and an empty
// honeypot; the name and email are optional (an email lets the organiser
// reply). Words go to the meeting's organiser and to our support team.

import { useEffect, useId, useRef, useState } from 'react';
import { Star } from 'lucide-react';

type Kind = { key: string; label: string };
type FormInfo = { meeting: { name: string; slug: string }; kinds: Kind[]; token: string | null; signedIn: boolean };

const field =
  'w-full rounded-lg border border-white/12 bg-black/40 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-cyan-400/70';

export default function FeedbackForm({
  slug,
  where,
  onDone,
  autoFocus = false,
}: {
  slug: string;
  where: 'link' | 'room' | 'after';
  /** Called after words were sent (the room closes its dialog). */
  onDone?: () => void;
  autoFocus?: boolean;
}) {
  const [info, setInfo] = useState<FormInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [ratingSent, setRatingSent] = useState(false);
  const [kind, setKind] = useState<string>('');
  const [message, setMessage] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const honeypot = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const ids = useId();

  useEffect(() => {
    let live = true;
    fetch(`/api/events/${encodeURIComponent(slug)}/feedback`, { cache: 'no-store' })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.message || 'This feedback form did not load. Reload the page to try again.');
        return j as FormInfo;
      })
      .then((j) => live && setInfo(j))
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, [slug]);

  useEffect(() => {
    if (info && autoFocus && where !== 'after') messageRef.current?.focus();
  }, [info, autoFocus, where]);

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch(`/api/events/${encodeURIComponent(slug)}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        where,
        token: info?.token ?? undefined,
        website: honeypot.current?.value ?? '',
        ...(info?.signedIn ? {} : { name, email }),
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.message || 'Your feedback could not be sent. Try again.');
  };

  const rate = async (n: number) => {
    if (busy || ratingSent) return;
    setRating(n);
    setBusy(true);
    setError(null);
    try {
      await post({ rating: n });
      setRatingSent(true);
    } catch (e) {
      setRating(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) {
      setError('Write what happened first.');
      messageRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post({ message: message.trim(), ...(kind ? { kind } : {}) });
      setSent(true);
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <p className='text-sm text-red-300'>{loadError}</p>;
  if (!info) return <p className='text-sm text-cyan-100/60'>Loading…</p>;

  if (sent) {
    return (
      <div role='status' className='rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-left'>
        <p className='text-base font-semibold text-emerald-100'>Thank you. Your feedback was sent.</p>
        <p className='mt-1 text-sm text-emerald-100/80'>
          The meeting&apos;s organiser and our support team will see it.
          {!info.signedIn && email ? ' They can reply to the email you gave.' : ''}
        </p>
      </div>
    );
  }

  return (
    <div className='space-y-4 text-left'>
      {where === 'after' && (
        <fieldset>
          <legend className='text-sm text-cyan-100/80'>How was {info.meeting.name}?</legend>
          <div role='radiogroup' aria-label='Stars' className='mt-2 flex gap-1'>
            {[1, 2, 3, 4, 5].map((n) => {
              const on = rating != null && n <= rating;
              return (
                <button
                  key={n}
                  type='button'
                  role='radio'
                  aria-checked={rating === n}
                  aria-label={`${n} star${n === 1 ? '' : 's'}`}
                  disabled={busy || ratingSent}
                  onClick={() => rate(n)}
                  className='rounded-lg p-1.5 text-amber-300 hover:bg-white/5 disabled:cursor-default'
                >
                  <Star size={30} aria-hidden fill={on ? 'currentColor' : 'none'} strokeWidth={1.5} />
                </button>
              );
            })}
          </div>
          {ratingSent && (
            <p role='status' className='mt-2 text-sm text-emerald-200'>
              Thanks, {rating} star{rating === 1 ? '' : 's'} sent. Anything else to tell the organiser? Write it below.
            </p>
          )}
        </fieldset>
      )}

      <form onSubmit={send} className='space-y-4' noValidate>
        <fieldset>
          <legend className='text-sm text-cyan-100/80'>What is it about?</legend>
          <div className='mt-2 flex flex-wrap gap-2'>
            {info.kinds.map((k) => (
              <label
                key={k.key}
                className={
                  'cursor-pointer rounded-full border px-3 py-1.5 text-sm focus-within:ring-2 focus-within:ring-cyan-300/70 ' +
                  (kind === k.key ? 'border-cyan-300 bg-cyan-400/15 text-cyan-50' : 'border-white/15 text-cyan-100/80 hover:bg-white/5')
                }
              >
                <input
                  type='radio'
                  name={`${ids}-kind`}
                  value={k.key}
                  checked={kind === k.key}
                  onChange={() => setKind(k.key)}
                  className='sr-only'
                />
                {k.label}
              </label>
            ))}
          </div>
        </fieldset>

        <label className='block text-sm text-cyan-100/80'>
          {where === 'after' ? 'Tell the organiser more' : 'What happened?'}
          <textarea
            ref={messageRef}
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              if (error) setError(null);
            }}
            maxLength={2000}
            rows={4}
            placeholder={where === 'link' ? 'For example: the link would not open, or there was no sound.' : 'For example: the sound kept cutting out.'}
            className={`${field} mt-1`}
          />
        </label>

        {!info.signedIn && (
          <div className='grid gap-3 sm:grid-cols-2'>
            <label className='block text-sm text-cyan-100/80'>
              Your name <span className='text-cyan-100/40'>(optional)</span>
              <input autoComplete='name' value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className={`${field} mt-1`} />
            </label>
            <label className='block text-sm text-cyan-100/80'>
              Email <span className='text-cyan-100/40'>(optional, for a reply)</span>
              <input type='email' autoComplete='email' value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} className={`${field} mt-1`} />
            </label>
          </div>
        )}

        {/* Hidden from people; form-filling bots fill it in. */}
        <div aria-hidden='true' className='absolute -left-[10000px] h-0 w-0 overflow-hidden'>
          <label>
            Website
            <input ref={honeypot} name='website' tabIndex={-1} autoComplete='off' defaultValue='' />
          </label>
        </div>

        {error && (
          <p role='alert' className='text-sm text-red-300'>
            {error}
          </p>
        )}

        <div className='flex flex-wrap items-center gap-3'>
          <button
            type='submit'
            disabled={busy}
            className='rounded-lg bg-cyan-500/85 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-50'
          >
            {busy ? 'Sending…' : 'Send feedback'}
          </button>
          <span className='text-xs text-cyan-100/50'>Goes to the organiser and our support team.</span>
        </div>
      </form>
    </div>
  );
}
