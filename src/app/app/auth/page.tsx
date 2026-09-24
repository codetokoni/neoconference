// src/app/app/auth/page.tsx
//
// Where a sign-in started in the mobile app comes back to.
//
// Normally nobody sees this page. Android verifies this domain against
// /.well-known/assetlinks.json and hands the URL straight to the app, which
// redeems the ticket itself. This renders only when that did not happen:
// the app is not installed, verification has not completed, or someone
// opened the link on a desktop.
//
// In that case the kindest thing is to finish the sign-in here rather than
// strand a valid, about-to-expire ticket on a dead end — /sign-in already
// knows what to do with __clerk_ticket.

import { redirect } from 'next/navigation';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function AppAuthPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;

  const ticket = first(params.__clerk_ticket);
  if (ticket) {
    // Clerk sign-in tokens last 60 seconds, so there is no point offering a
    // button to try the app again — it would expire while being read.
    redirect(`/sign-in?__clerk_ticket=${encodeURIComponent(ticket)}`);
  }

  const failed = first(params.kc_error) || first(params.ne_error);

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="neo-card max-w-md w-full p-8 text-center">
        <h1 className="text-xl font-semibold mb-3">
          {failed ? 'Sign-in did not complete' : 'Open the NeoConference app'}
        </h1>
        <p className="text-sm opacity-80 mb-6">
          {failed
            ? 'Something went wrong on the way back from your sign-in provider. Please try again from the app.'
            : 'This link is meant to open in the NeoConference app on your phone. If you are on a computer, sign in here instead.'}
        </p>
        <Link href="/sign-in" className="neo-btn inline-block">
          Sign in on the web
        </Link>
      </div>
    </main>
  );
}
