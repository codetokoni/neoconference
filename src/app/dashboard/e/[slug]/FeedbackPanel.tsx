'use client';

// The meeting's feedback, for its owner (src/lib/meetingFeedback.ts): the
// link to share, where feedback is sent (a KingsChat handle and an email, on
// a paid plan), how people rated it, and what they wrote.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Star } from 'lucide-react';

type Entry = {
  id: string;
  ts: number;
  where: 'link' | 'room' | 'after';
  kind?: string;
  rating?: number;
  message: string;
  name: string;
  email?: string;
  device?: string;
};
type Contact = { kcHandle?: string; email?: string };
type Reach = { kcHandleKnown: boolean | null; ownerKcLinked: boolean | null };
type Manage = {
  feedback: Entry[];
  tally: { stars: number[]; rated: number; average: number | null; kinds: Record<string, number>; written: number };
  contact: Contact | null;
  contactAllowed: boolean;
  reach: Reach;
};
type Kind = { key: string; label: string };

const field =
  'w-full rounded-lg border border-white/12 bg-black/40 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-cyan-400/70';
const WHERE: Record<Entry['where'], string> = { link: 'Feedback link', room: 'In the meeting', after: 'After leaving' };

function ReachNote({ reach, handle }: { reach: Reach; handle?: string }) {
  if (!handle) return null;
  const notes: string[] = [];
  if (reach.ownerKcLinked === false) {
    notes.push('KingsChat messages are sent from your own KingsChat account. Sign in with KingsChat once so they can be sent.');
  }
  if (reach.kcHandleKnown === false) {
    notes.push(`Nobody has signed in here with @${handle} yet, so a KingsChat message cannot find them. They need to sign in with KingsChat once.`);
  }
  if (!notes.length) return <p className='text-xs text-emerald-200/80'>KingsChat messages will reach @{handle}.</p>;
  return (
    <div className='space-y-1'>
      {notes.map((n) => (
        <p key={n} className='text-xs text-amber-200/90'>
          {n}
        </p>
      ))}
    </div>
  );
}

export default function FeedbackPanel({ eventId, slug }: { eventId: string; slug: string }) {
  const [data, setData] = useState<Manage | null>(null);
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kcHandle, setKcHandle] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [link, setLink] = useState(`/feedback/${slug}`);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/events/${encodeURIComponent(eventId)}/feedback`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.manage) throw new Error(j.message || 'Feedback did not load. Reload the page to try again.');
      setData(j.manage as Manage);
      setKinds(j.kinds ?? []);
      setKcHandle(j.manage.contact?.kcHandle ? `@${j.manage.contact.kcHandle}` : '');
      setEmail(j.manage.contact?.email ?? '');
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [eventId]);

  useEffect(() => {
    const origin = window.location.origin;
    if (origin && origin !== 'null') setLink(`${origin}/feedback/${encodeURIComponent(slug)}`);
    void load();
  }, [load, slug]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the link is on screen to copy by hand */
    }
  };

  const save = async (clear = false) => {
    setSaving(true);
    setSaveNote(null);
    const contact = clear || (!kcHandle.trim() && !email.trim()) ? null : { kcHandle: kcHandle.trim(), email: email.trim() };
    try {
      const r = await fetch(`/api/events/${encodeURIComponent(eventId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feedbackContact: contact }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const text =
          j.error === 'invalid_feedback_contact'
            ? 'Check the KingsChat handle (like @name) and the email address.'
            : j.error === 'plan_required'
              ? 'Sending feedback to a KingsChat handle or email needs a paid plan.'
              : 'Not saved. Try again.';
        setSaveNote({ ok: false, text });
        return;
      }
      const saved = (j.event?.feedbackContact ?? null) as Contact | null;
      setKcHandle(saved?.kcHandle ? `@${saved.kcHandle}` : '');
      setEmail(saved?.email ?? '');
      setData((d) => (d ? { ...d, contact: saved, reach: j.feedbackReach ?? d.reach } : d));
      setSaveNote({ ok: true, text: saved ? 'Saved. New feedback will be sent there too.' : 'Removed. Feedback goes to your notifications and our support team.' });
    } catch {
      setSaveNote({ ok: false, text: 'Not saved. Check your connection and try again.' });
    } finally {
      setSaving(false);
    }
  };

  if (loadError) return <p className='text-sm text-red-300'>{loadError}</p>;
  if (!data) return <p className='text-sm text-slate-400'>Loading feedback…</p>;
  const { tally } = data;
  const kindLabel = (k?: string) => kinds.find((x) => x.key === k)?.label ?? '';

  return (
    <div className='space-y-5'>
      <div className='rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-2'>
        <p className='text-sm text-slate-300'>
          Share this link so people can tell you what went wrong, even if they could not get in. People can also send feedback from inside
          the meeting, and are asked how it went when they leave.
        </p>
        <div className='flex flex-wrap items-center gap-2'>
          <code className='min-w-0 flex-1 truncate rounded-lg bg-black/40 px-3 py-2 text-xs text-cyan-100'>{link}</code>
          <button
            type='button'
            onClick={copy}
            className='rounded-lg border border-cyan-400/40 px-3 py-2 text-xs font-medium text-cyan-100 hover:bg-cyan-400/10'
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      </div>

      <div className='rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3'>
        <h3 className='text-sm font-medium text-slate-100'>Where feedback goes</h3>
        <p className='text-xs text-slate-400'>Always to your notifications and to our support team.</p>
        {data.contactAllowed ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className='space-y-3'
          >
            <div className='grid gap-3 sm:grid-cols-2'>
              <label className='block text-sm text-slate-300'>
                KingsChat handle
                <input value={kcHandle} onChange={(e) => setKcHandle(e.target.value)} placeholder='@yourhandle' maxLength={65} className={`${field} mt-1`} />
              </label>
              <label className='block text-sm text-slate-300'>
                Email
                <input type='email' value={email} onChange={(e) => setEmail(e.target.value)} placeholder='team@example.org' maxLength={200} className={`${field} mt-1`} />
              </label>
            </div>
            <ReachNote reach={data.reach} handle={data.contact?.kcHandle} />
            <div className='flex flex-wrap items-center gap-3'>
              <button
                type='submit'
                disabled={saving}
                className='rounded-lg bg-cyan-500/85 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-50'
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              {data.contact && (
                <button type='button' onClick={() => save(true)} disabled={saving} className='text-sm text-slate-400 hover:text-slate-200'>
                  Remove
                </button>
              )}
              {saveNote && (
                <span role='status' className={'text-sm ' + (saveNote.ok ? 'text-emerald-200' : 'text-red-300')}>
                  {saveNote.text}
                </span>
              )}
            </div>
            <p className='text-xs text-slate-500'>At most one message every 10 minutes, saying how many came in since.</p>
          </form>
        ) : (
          <p className='text-sm text-slate-300'>
            On a paid plan, feedback can also go straight to a KingsChat handle or an email.{' '}
            <Link href='/pricing' className='text-cyan-300 hover:text-cyan-200'>
              See plans
            </Link>
          </p>
        )}
      </div>

      <div className='space-y-3'>
        <div className='flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm'>
          <span className='text-slate-100'>
            {tally.average != null ? (
              <>
                <Star size={14} aria-hidden className='inline -mt-0.5 text-amber-300' fill='currentColor' /> {tally.average.toFixed(1)} from{' '}
                {tally.rated} rating{tally.rated === 1 ? '' : 's'}
              </>
            ) : (
              'No ratings yet'
            )}
          </span>
          <span className='text-slate-400'>
            {tally.written} written message{tally.written === 1 ? '' : 's'}
          </span>
          {Object.entries(tally.kinds).map(([k, n]) => (
            <span key={k} className='text-slate-400'>
              {kindLabel(k) || k}: {n}
            </span>
          ))}
        </div>
        {data.feedback.length === 0 ? (
          <p className='text-sm text-slate-400'>No feedback yet.</p>
        ) : (
          <ul className='divide-y divide-white/5 rounded-xl border border-white/10'>
            {data.feedback.map((e) => (
              <li key={e.id} className='p-3 text-sm'>
                <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400'>
                  {e.kind && <span className='rounded-full border border-white/15 px-2 py-0.5 text-slate-200'>{kindLabel(e.kind)}</span>}
                  {e.rating && (
                    <span className='text-amber-300' aria-label={`${e.rating} of 5 stars`}>
                      {'★'.repeat(e.rating)}
                      <span className='text-slate-600'>{'★'.repeat(5 - e.rating)}</span>
                    </span>
                  )}
                  <span>{WHERE[e.where]}</span>
                  <span>{new Date(e.ts).toLocaleString()}</span>
                </div>
                {e.message && <p className='mt-1.5 whitespace-pre-wrap break-words text-slate-100'>{e.message}</p>}
                <p className='mt-1 text-xs text-slate-500 [overflow-wrap:anywhere]'>
                  {[e.name || 'Someone', e.email, e.device].filter(Boolean).join(' · ')}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
