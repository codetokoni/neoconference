'use client';

import { useSignIn } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';

export default function ResetPasswordForm() {
  const { signIn, isLoaded, setActive } = useSignIn();
  const router = useRouter();

  const [step, setStep] = useState<'request' | 'reset'>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signIn) return;
    setError(null);
    setLoading(true);
    try {
      await signIn.create({
        strategy: 'reset_password_email_code',
        identifier: email,
      });
      setStep('reset');
    } catch (err: any) {
      setError(
        err?.errors?.[0]?.longMessage ||
          err?.errors?.[0]?.message ||
          'Could not send reset code. Check the email address.'
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signIn) return;
    setError(null);
    setLoading(true);
    try {
      const result = await signIn.attemptFirstFactor({
        strategy: 'reset_password_email_code',
        code,
        password: newPassword,
      });
      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        router.push('/');
      } else {
        setError('Reset incomplete. Please try again.');
      }
    } catch (err: any) {
      setError(
        err?.errors?.[0]?.longMessage ||
          err?.errors?.[0]?.message ||
          'Invalid code or password.'
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={step === 'request' ? handleRequestCode : handleReset}
      className='w-full max-w-sm bg-white text-black rounded-xl shadow-lg p-6 flex flex-col gap-4'
    >
      <div className='text-center'>
        <h1 className='text-xl font-semibold'>
          {step === 'request' ? 'Reset your password' : 'Enter code and new password'}
        </h1>
        <p className='text-sm text-gray-500'>
          {step === 'request'
            ? "We'll email you a code to reset your password."
            : `We sent a 6-digit code to ${email}.`}
        </p>
      </div>

      {step === 'request' && (
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
      )}

      {step === 'reset' && (
        <>
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

          <label className='flex flex-col gap-1 text-sm'>
            <span className='font-medium'>New password</span>
            <div className='relative'>
              <input
                type={showPassword ? 'text' : 'password'}
                required
                minLength={8}
                autoComplete='new-password'
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
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
        </>
      )}

      {error && (
        <div className='bg-red-100 text-red-800 text-sm px-3 py-2 rounded'>{error}</div>
      )}

      <button
        type='submit'
        disabled={loading || !isLoaded}
        className='bg-black text-white rounded py-2 font-medium hover:bg-gray-800 disabled:opacity-60'
      >
        {loading
          ? step === 'request'
            ? 'Sending code…'
            : 'Resetting…'
          : step === 'request'
          ? 'Send reset code'
          : 'Reset password'}
      </button>

      <div className='text-sm text-center'>
        <Link href='/sign-in' className='text-blue-600 hover:underline'>
          ← Back to sign in
        </Link>
      </div>
    </form>
  );
}
