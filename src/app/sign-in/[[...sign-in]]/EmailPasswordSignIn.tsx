'use client';

import { firstClerkError } from "@/lib/errorMessage";
import { maskEmail, signInErrorText } from "@/lib/signInMessages";
import { useSignIn } from '@clerk/nextjs';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { BRAND } from "@/lib/brand";

type SignInResource = NonNullable<ReturnType<typeof useSignIn>['signIn']>;

/**
 * A code to finish signing in: Clerk asks for one (an email to the account's
 * address, a text, or an authenticator app) when the password is not enough,
 * for example on a device this account has not used before. This form used
 * to stop there with "Additional verification required. Please check your
 * email." and no box to type the code into, and no code sent (2026-11-20).
 */
type CodeStep = {
  factor: 'first' | 'second';
  strategy: 'email_code' | 'phone_code' | 'totp';
  /** Where the code went, as the person will recognise it; null for an authenticator app. */
  sentTo: string | null;
  emailAddressId?: string;
  phoneNumberId?: string;
};

type Factor = { strategy: string; emailAddressId?: string; phoneNumberId?: string; safeIdentifier?: string };

/** Which code to ask for, from what Clerk supports for this sign-in; null if none we can take. */
function pickCodeStep(factor: 'first' | 'second', factors: Factor[] | null | undefined, typedEmail: string): CodeStep | null {
  const list = factors ?? [];
  const email = list.find((f) => f.strategy === 'email_code' && f.emailAddressId);
  if (email) return { factor, strategy: 'email_code', sentTo: maskEmail(email.safeIdentifier || typedEmail), emailAddressId: email.emailAddressId };
  if (factor === 'second' && list.some((f) => f.strategy === 'totp')) return { factor, strategy: 'totp', sentTo: null };
  const phone = list.find((f) => f.strategy === 'phone_code' && f.phoneNumberId);
  if (phone) return { factor, strategy: 'phone_code', sentTo: phone.safeIdentifier ?? 'your phone', phoneNumberId: phone.phoneNumberId };
  return null;
}

/** Send the code (an authenticator app needs nothing sent). */
async function sendCode(signIn: SignInResource, step: CodeStep): Promise<void> {
  if (step.strategy === 'totp') return;
  const params =
    step.strategy === 'email_code'
      ? { strategy: 'email_code' as const, emailAddressId: step.emailAddressId! }
      : { strategy: 'phone_code' as const, phoneNumberId: step.phoneNumberId! };
  if (step.factor === 'first') await signIn.prepareFirstFactor(params);
  else await signIn.prepareSecondFactor(params);
}

export default function EmailPasswordSignIn() {
  const { signIn, isLoaded, setActive } = useSignIn();
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectUrl = searchParams.get('redirect_url') || '/';
  const ticket = searchParams.get('__clerk_ticket');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ticketProcessing, setTicketProcessing] = useState<boolean>(!!ticket);
  const ticketTriedRef = useRef(false);
  const [codeStep, setCodeStep] = useState<CodeStep | null>(null);
  const [code, setCode] = useState('');

  // Handle KingsChat (or any external) sign-in ticket from /api/auth/kingschat/callback.
  // The callback redirects here with ?__clerk_ticket=... and we exchange it for a session.
  useEffect(() => {
    if (!ticket) return;
    if (!isLoaded || !signIn) return;
    if (ticketTriedRef.current) return;
    ticketTriedRef.current = true;

    (async () => {
      try {
        const result = await signIn.create({
          strategy: 'ticket',
          ticket,
        });

        if (result.status === 'complete' && result.createdSessionId) {
          await setActive({ session: result.createdSessionId });
          router.replace(redirectUrl);
        } else {
          setError('KingsChat sign-in could not be completed. Please try again.');
          setTicketProcessing(false);
        }
      } catch (err) {
        const msg =
          firstClerkError(err)?.longMessage ||
          firstClerkError(err)?.message ||
          'KingsChat sign-in failed. Please try again.';
        setError(msg);
        setTicketProcessing(false);
      }
    })();
  }, [ticket, isLoaded, signIn, setActive, router, redirectUrl]);

  /** Where a sign-in goes next: in, to a code, or to setting a new password. */
  async function next(result: Awaited<ReturnType<SignInResource['create']>>) {
    if (result.status === 'complete') {
      await setActive!({ session: result.createdSessionId });
      router.push(redirectUrl);
      return;
    }
    if (result.status === 'needs_new_password') {
      router.push('/sign-in/reset');
      return;
    }
    const factor = result.status === 'needs_second_factor' ? 'second' : 'first';
    const step = pickCodeStep(
      factor,
      (factor === 'second' ? result.supportedSecondFactors : result.supportedFirstFactors) as Factor[] | null,
      email,
    );
    if (!step) {
      setError('This account needs a sign-in step we can’t show here. Use “Continue with KingsChat” above, or tap “Forgot password?”.');
      return;
    }
    await sendCode(signIn!, step);
    setCode('');
    setCodeStep(step);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signIn) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      await next(await signIn.create({ identifier: email.trim(), password }));
    } catch (err) {
      setError(signInErrorText(firstClerkError(err)));
    } finally {
      setLoading(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signIn || !codeStep) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const params = { strategy: codeStep.strategy, code: code.trim() } as Parameters<SignInResource['attemptSecondFactor']>[0];
      const result =
        codeStep.factor === 'first'
          ? await signIn.attemptFirstFactor(params as Parameters<SignInResource['attemptFirstFactor']>[0])
          : await signIn.attemptSecondFactor(params);
      await next(result);
    } catch (err) {
      setError(signInErrorText(firstClerkError(err)));
    } finally {
      setLoading(false);
    }
  }

  async function resend() {
    if (!signIn || !codeStep) return;
    setError(null);
    try {
      await sendCode(signIn, codeStep);
      setNotice('A new code is on its way.');
    } catch (err) {
      setError(signInErrorText(firstClerkError(err)));
    }
  }

  if (ticketProcessing) {
    return (
      <div className='w-full max-w-sm bg-white text-black rounded-xl shadow-lg p-6 flex flex-col items-center gap-3'>
        <div className='animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent' />
        <p className='text-sm text-gray-700'>Completing KingsChat sign-in…</p>
      </div>
    );
  }

  if (codeStep) {
    return (
      <form onSubmit={submitCode} className='w-full max-w-sm bg-white text-black rounded-xl shadow-lg p-6 flex flex-col gap-4'>
        <div className='text-center'>
          <h1 className='text-xl font-semibold'>Enter your sign-in code</h1>
          <p className='text-sm text-gray-600'>
            {codeStep.strategy === 'totp'
              ? 'Open your authenticator app and enter the code it shows for ' + BRAND.name + '.'
              : `We sent a code to ${codeStep.sentTo}. Enter it to finish signing in on this device.`}
          </p>
        </div>

        <label className='flex flex-col gap-1 text-sm'>
          <span className='font-medium'>Code</span>
          <input
            inputMode='numeric'
            autoComplete='one-time-code'
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className='border rounded px-3 py-2 tracking-widest text-center text-lg focus:outline-none focus:ring-2 focus:ring-blue-500'
            placeholder='123456'
          />
        </label>

        {error && <div role='alert' className='bg-red-100 text-red-800 text-sm px-3 py-2 rounded'>{error}</div>}
        {notice && <div role='status' className='bg-green-100 text-green-800 text-sm px-3 py-2 rounded'>{notice}</div>}

        <button
          type='submit'
          disabled={loading || code.trim().length === 0}
          className='bg-black text-white rounded py-2 font-medium hover:bg-gray-800 disabled:opacity-60'
        >
          {loading ? 'Checking…' : 'Continue'}
        </button>

        <div className='flex justify-between text-sm'>
          {codeStep.strategy !== 'totp' ? (
            <button type='button' onClick={resend} className='text-blue-600 hover:underline'>
              Send a new code
            </button>
          ) : (
            <span />
          )}
          <button
            type='button'
            onClick={() => {
              setCodeStep(null);
              setError(null);
              setNotice(null);
            }}
            className='text-blue-600 hover:underline'
          >
            Back
          </button>
        </div>
      </form>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className='w-full max-w-sm bg-white text-black rounded-xl shadow-lg p-6 flex flex-col gap-4'
    >
      <div className='text-center'>
        <h1 className='text-xl font-semibold'>Sign in to {BRAND.name}</h1>
        <p className='text-sm text-gray-500'>Welcome back! Please sign in to continue.</p>
      </div>

      <label className='flex flex-col gap-1 text-sm'>
        <span className='font-medium'>Email address</span>
        <input
          type='email'
          required
          autoComplete='email'
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className='border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500'
          placeholder='you@example.com'
        />
      </label>

      <label className='flex flex-col gap-1 text-sm'>
        <span className='font-medium'>Password</span>
        <div className='relative'>
          <input
            type={showPassword ? 'text' : 'password'}
            required
            autoComplete='current-password'
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className='w-full border rounded px-3 py-2 pr-16 focus:outline-none focus:ring-2 focus:ring-blue-500'
            placeholder='Enter your password'
          />
          <button
            type='button'
            onClick={() => setShowPassword((s) => !s)}
            className='absolute right-2 top-1/2 -translate-y-1/2 text-xs text-blue-600 hover:underline'
          >
            {showPassword ? 'Hide' : 'Show'}
          </button>
        </div>
      </label>

      {error && (
        <div role='alert' className='bg-red-100 text-red-800 text-sm px-3 py-2 rounded'>{error}</div>
      )}

      <div id='clerk-captcha' />

      <button
        type='submit'
        disabled={loading || !isLoaded}
        className='bg-black text-white rounded py-2 font-medium hover:bg-gray-800 disabled:opacity-60'
      >
        {loading ? 'Signing in…' : 'Sign in'}
      </button>

      <div className='flex justify-between text-sm'>
        <Link href='/sign-in/reset' className='text-blue-600 hover:underline'>
          Forgot password?
        </Link>
        <Link
          href={
            redirectUrl && redirectUrl !== '/'
              ? `/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`
              : '/sign-up'
          }
          className='text-blue-600 hover:underline'
        >
          Create account
        </Link>
      </div>
    </form>
  );
}
