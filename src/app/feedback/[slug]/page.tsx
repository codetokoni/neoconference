// /feedback/<slug>: feedback on a meeting, signed in or not
// (src/lib/meetingFeedback.ts). The link an organiser shares; also where the
// meeting sends people when they leave (?after=1: stars first).

import Link from 'next/link';
import type { Metadata } from 'next';
import FeedbackForm from '@/components/feedback/FeedbackForm';

export const metadata: Metadata = { title: 'Meeting feedback', robots: { index: false, follow: false } };

export default async function FeedbackPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const after = (await searchParams).after === '1';
  return (
    <section className='mx-auto max-w-xl px-4 py-12 sm:px-6 sm:py-16'>
      <h1 className='text-2xl font-semibold tracking-tight text-white sm:text-3xl'>
        {after ? 'You left the meeting' : 'Send feedback'}
      </h1>
      <p className='mt-3 text-cyan-100/70 leading-relaxed'>
        {after
          ? 'Tap the stars to say how it went. If something did not work, tell the organiser below.'
          : 'Tell the organiser of this meeting what went wrong, or what went well. It works even if you could not get in.'}
      </p>
      <div className='mt-8 rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-6'>
        <FeedbackForm slug={slug} where={after ? 'after' : 'link'} />
      </div>
      <div className='mt-6 flex flex-wrap gap-4 text-sm'>
        {after && (
          <Link href={`/${encodeURIComponent(slug)}`} className='text-cyan-300 hover:text-cyan-200'>
            Rejoin the meeting
          </Link>
        )}
        <Link href='/' className='text-cyan-100/70 hover:text-cyan-100'>
          {after ? 'Skip, go home' : 'Back to home'}
        </Link>
      </div>
    </section>
  );
}
