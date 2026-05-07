import { SignIn } from '@clerk/nextjs';
import Link from 'next/link';

type SP = { kc_error?: string; kc_debug?: string };

export default function Page({ searchParams }: { searchParams: SP }) {
  const kcError = searchParams?.kc_error;
  const kcDebug = searchParams?.kc_debug;
  return (
    <div className='flex flex-col items-center py-16 gap-4'>
      {kcError && (
        <div className='bg-red-100 text-red-800 px-4 py-2 rounded text-sm max-w-md text-center'>
          KingsChat sign-in failed: <strong>{kcError}</strong>. Please try again or use another method.
          {kcDebug && (
            <div className='mt-2 break-all font-mono text-[11px] text-red-700 text-left'>debug: {kcDebug}</div>
          )}
        </div>
      )}
      <SignIn />
      <Link
        href='/api/auth/kingschat/start'
        className='inline-flex items-center justify-center w-72 px-4 py-2 rounded bg-[#1f8feb] hover:bg-[#1976c4] text-white font-medium transition-colors'
      >
        Continue with KingsChat
      </Link>
    </div>
  );
}
