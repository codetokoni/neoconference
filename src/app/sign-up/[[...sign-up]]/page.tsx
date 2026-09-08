import Link from 'next/link';
import EmailPasswordSignUp from './EmailPasswordSignUp';

type SP = {
  kc_error?: string;
  kc_debug?: string;
  /** Set by the Neoemail callback when that flow fails, mirroring kc_error. */
  ne_error?: string;
  ne_debug?: string;
  /** Preserved across the KingsChat / Neoemail round trip so a new user who
   *  signed up from a meeting invite lands back in the room, not on the
   *  home page. */
  redirect_url?: string;
};

export default function Page({ searchParams }: { searchParams: SP }) {
  const kcError = searchParams?.kc_error;
  const kcDebug = searchParams?.kc_debug;
  const neError = searchParams?.ne_error;
  const neDebug = searchParams?.ne_debug;
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

      <div className='text-sm text-gray-500'>or</div>

      <EmailPasswordSignUp />
    </div>
  );
}
