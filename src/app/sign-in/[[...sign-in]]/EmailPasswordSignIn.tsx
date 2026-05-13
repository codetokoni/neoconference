'use client';

import { useSignIn } from '@clerk/nextjs';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';

export default function EmailPasswordSignIn() {
  const { signIn, isLoaded, setActive } = useSignIn();
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectUrl = searchParams.get('redirect_url') || '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signIn) return;
    setError(null);
    setLoading(true);
    try {
      const result = await signIn.create({
        identifier: email,
        password,
      });

      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        router.push(redirectUrl);
      } else {
        setError('Additional verification required. Please check your email.');
      }
    } catch (err: any) {
      const msg =
        err?.errors?.[0]?.longMessage ||
        err?.errors?.[0]?.message ||
        'Sign-in failed. Please check your credentials.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className='w-full max-w-sm bg-white text-black rounded-xl shadow-lg p-6 flex flex-col gap-4'
    >
      <div className='text-center'>
        <h1 className='text-xl font-semibold'>Sign in to NeoConference</h1>
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
        <div className='bg-red-100 text-red-800 text-sm px-3 py-2 rounded'>{error}</div>
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
        <Link href='/sign-up' className='text-blue-600 hover:underline'>
          Create account
        </Link>
      </div>
    </form>
  );
}
