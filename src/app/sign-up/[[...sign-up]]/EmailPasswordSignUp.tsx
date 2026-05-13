'use client';

import { useSignUp } from '@clerk/nextjs';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';

export default function EmailPasswordSignUp() {
  const { signUp, isLoaded, setActive } = useSignUp();
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectUrl = searchParams.get('redirect_url') || '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState('');
  const [pendingVerification, setPendingVerification] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signUp) return;
    setError(null);
    setLoading(true);
    try {
      await signUp.create({ emailAddress: email, password });
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      setPendingVerification(true);
    } catch (err: any) {
      setError(
        err?.errors?.[0]?.longMessage ||
          err?.errors?.[0]?.message ||
          'Sign-up failed. Please try again.'
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signUp) return;
    setError(null);
    setLoading(true);
    try {
      const result = await signUp.attemptEmailAddressVerification({ code });
      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        router.push(redirectUrl);
      } else {
        setError('Verification incomplete. Please try again.');
      }
    } catch (err: any) {
      setError(
        err?.errors?.[0]?.longMessage ||
          err?.errors?.[0]?.message ||
          'Invalid code. Please check your email.'
      );
    } finally {
      setLoading(false);
    }
  }

  if (pendingVerification) {
    return (
      <form
        onSubmit={handleVerify}
        className='w-full max-w-sm bg-white text-black rounded-xl shadow-lg p-6 flex flex-col gap-4'
      >
        <div className='text-center'>
          <h1 className='text-xl font-semibold'>Verify your email</h1>
          <p className='text-sm text-gray-500'>
            We sent a 6-digit code to <strong>{email}</strong>.
          </p>
        </div>

        <label className='flex flex-col gap-1 text-sm'>
          <span className='font-medium'>Verification code</span>
          <input
            type='text'
            inputMode='numeric'
            required
            autoComplete='one-time-code'
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className='border rounded px-3 py-2 tracking-widest text-center text-lg focus:outline-none focus:ring-2 focus:ring-blue-500'
            placeholder='123456'
          />
        </label>

        {error && (
          <div className='bg-red-100 text-red-800 text-sm px-3 py-2 rounded'>{error}</div>
        )}

        <button
          type='submit'
          disabled={loading}
          className='bg-black text-white rounded py-2 font-medium hover:bg-gray-800 disabled:opacity-60'
        >
          {loading ? 'Verifying…' : 'Verify and continue'}
        </button>

        <button
          type='button'
          onClick={() => setPendingVerification(false)}
          className='text-sm text-blue-600 hover:underline'
        >
          ← Use a different email
        </button>
      </form>
    );
  }

  return (
    <form
      onSubmit={handleSignUp}
      className='w-full max-w-sm bg-white text-black rounded-xl shadow-lg p-6 flex flex-col gap-4'
    >
      <div className='text-center'>
        <h1 className='text-xl font-semibold'>Create your NeoConference account</h1>
        <p className='text-sm text-gray-500'>Start hosting premium HD meetings.</p>
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
            minLength={8}
            autoComplete='new-password'
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className='w-full border rounded px-3 py-2 pr-16 focus:outline-none focus:ring-2 focus:ring-blue-500'
            placeholder='At least 8 characters'
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
        <div className='bg-red-100 text-red-800 text-sm px-3 py-2 rounded'>{error}</div>
      )}

      <div id='clerk-captcha' />

      <button
        type='submit'
        disabled={loading || !isLoaded}
        className='bg-black text-white rounded py-2 font-medium hover:bg-gray-800 disabled:opacity-60'
      >
        {loading ? 'Creating account…' : 'Create account'}
      </button>

      <div className='text-sm text-center'>
        Already have an account?{' '}
        <Link href='/sign-in' className='text-blue-600 hover:underline'>
          Sign in
        </Link>
      </div>
    </form>
  );
}
