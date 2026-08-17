import Link from 'next/link';
import EmailPasswordSignIn from './EmailPasswordSignIn';

type SP = {
  kc_error?: string;
  kc_debug?: string;
  /** Set by SessionManager after a deliberate sign-out. */
  signed_out?: string;
  /** Set by middleware when a persistent session was revoked or expired. */
  session_ended?: string;
};

/**
 * A deliberate sign-out and an unexpected bounce look identical on this page
 * otherwise, and they mean very different things — the second one can be the
 * first sign that someone else revoked your sessions.
 */
function sessionNotice(sp: SP): string | null {
  if (sp?.signed_out === 'all') return "You've been signed out on all your devices.";
  if (sp?.signed_out === 'device') return "You've been signed out on this device.";
  if (sp?.session_ended) {
    return 'Your session ended on this device. This happens if you signed out everywhere, or if it expired. Sign in to continue.';
  }
  return null;
}

export default function Page({ searchParams }: { searchParams: SP }) {
  const kcError = searchParams?.kc_error;
  const kcDebug = searchParams?.kc_debug;
  const notice = sessionNotice(searchParams);

  return (
    <div className='flex flex-col items-center py-16 gap-4'>
      {notice && (
        <div
          role='status'
          className='bg-cyan-400/10 border border-cyan-300/30 text-cyan-100 px-4 py-2 rounded text-sm max-w-md text-center'
        >
          {notice}
        </div>
      )}

      {kcError && (
        <div className='bg-red-100 text-red-800 px-4 py-2 rounded text-sm max-w-md text-center'>
          KingsChat sign-in failed: <strong>{kcError}</strong>. Please try again or use another method.
          {kcDebug && (
            <div className='mt-2 break-all font-mono text-[11px] text-red-700 text-left'>
              debug: {kcDebug}
            </div>
          )}
        </div>
      )}

      <EmailPasswordSignIn />

      <div className='text-sm text-gray-500'>or</div>

      <Link
        href='/api/auth/kingschat/start'
        className='inline-flex items-center justify-center w-72 px-4 py-2 rounded bg-[#1f8feb] hover:bg-[#1976c4] text-white font-medium transition-colors'
      >
        Continue with KingsChat
      </Link>
    </div>
  );
}
