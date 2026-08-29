import Link from 'next/link';
import EmailPasswordSignIn from './EmailPasswordSignIn';

type SP = {
  kc_error?: string;
  kc_debug?: string;
  /** Set by the Neoemail callback when that flow fails, mirroring kc_error. */
  ne_error?: string;
  ne_debug?: string;
  /** Set by SessionManager after a deliberate sign-out. */
  signed_out?: string;
  /** Set by middleware when a persistent session was revoked or expired. */
  session_ended?: string;
  /** Meeting URL the caller was headed for before hitting sign-in — must
   *  survive across the KingsChat round trip too, or the user lands on
   *  the home page after auth instead of the room they clicked. */
  redirect_url?: string;
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
  const neError = searchParams?.ne_error;
  const neDebug = searchParams?.ne_debug;
  const kcDebug = searchParams?.kc_debug;
  const notice = sessionNotice(searchParams);
  const redirectUrl = searchParams?.redirect_url;
  const kcHref =
    redirectUrl && redirectUrl !== '/'
      ? `/api/auth/kingschat/start?redirect_url=${encodeURIComponent(redirectUrl)}`
      : '/api/auth/kingschat/start';
  const neHref =
    redirectUrl && redirectUrl !== '/'
      ? `/api/auth/neoemail/start?redirect_url=${encodeURIComponent(redirectUrl)}`
      : '/api/auth/neoemail/start';

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

      {neError && (
        <div className='bg-red-100 text-red-800 px-4 py-2 rounded text-sm max-w-md text-center'>
          Neoemail sign-in failed: <strong>{neError}</strong>. Please try again or use another method.
          {neDebug && (
            <div className='mt-2 break-all font-mono text-[11px] text-red-700 text-left'>
              debug: {neDebug}
            </div>
          )}
        </div>
      )}

      <EmailPasswordSignIn />

      <div className='text-sm text-gray-500'>or</div>

      <Link
        href={kcHref}
        className='inline-flex items-center justify-center w-72 px-4 py-2 rounded bg-[#1f8feb] hover:bg-[#1976c4] text-white font-medium transition-colors'
      >
        Continue with KingsChat
      </Link>

      <Link
        href={neHref}
        className='inline-flex items-center justify-center w-72 px-4 py-2 rounded border border-cyan-300/40 bg-cyan-400/10 hover:bg-cyan-400/20 text-cyan-100 font-medium transition-colors'
      >
        Continue with Neoemail
      </Link>
    </div>
  );
}
