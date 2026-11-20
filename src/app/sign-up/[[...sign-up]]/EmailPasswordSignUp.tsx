'use client';

import { firstClerkError } from "@/lib/errorMessage";
import { missingFieldsText, signUpErrorText } from "@/lib/signInMessages";
import { useSignUp } from '@clerk/nextjs';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import PasswordField from '@/components/PasswordField';
import { BRAND } from "@/lib/brand";

export default function EmailPasswordSignUp() {
  const { signUp, isLoaded, setActive } = useSignUp();
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectUrl = searchParams.get('redirect_url') || '/';

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [pendingVerification, setPendingVerification] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signUp) return;
    setError(null);

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      await signUp.create({
        emailAddress: email.trim(),
        password,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
      });
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      setCode('');
      setPendingVerification(true);
    } catch (err) {
      // Clerk's own words said "That email address is taken. Please try
      // another." to people who already had an account (2026-11-20).
      setError(signUpErrorText(firstClerkError(err)));
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signUp) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const result = await signUp.attemptEmailAddressVerification({ code: code.trim() });
      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        router.push(redirectUrl);
      } else {
        // It used to say "Verification incomplete. Please try again." and
        // nothing more: say what the account still needs.
        setError(missingFieldsText(result.missingFields as string[] | undefined));
      }
    } catch (err) {
      setError(signUpErrorText(firstClerkError(err)));
    } finally {
      setLoading(false);
    }
  }

  async function resend() {
    if (!isLoaded || !signUp) return;
    setError(null);
    try {
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      setNotice('A new code is on its way. It can take a minute; check spam too.');
    } catch (err) {
      setError(signUpErrorText(firstClerkError(err)));
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
            We sent a 6-digit code to <strong>{email}</strong>. It can take a minute; check spam too.
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
          <div role='alert' className='bg-red-100 text-red-800 text-sm px-3 py-2 rounded'>{error}</div>
        )}
        {notice && (
          <div role='status' className='bg-green-100 text-green-800 text-sm px-3 py-2 rounded'>{notice}</div>
        )}

        <button
          type='submit'
          disabled={loading}
          className='bg-black text-white rounded py-2 font-medium hover:bg-gray-800 disabled:opacity-60'
        >
          {loading ? 'Verifying…' : 'Verify and continue'}
        </button>

        <div className='flex justify-between text-sm'>
          <button type='button' onClick={resend} className='text-blue-600 hover:underline'>
            Send a new code
          </button>
          <button
            type='button'
            onClick={() => {
              setPendingVerification(false);
              setError(null);
              setNotice(null);
            }}
            className='text-blue-600 hover:underline'
          >
            ← Use a different email
          </button>
        </div>
      </form>
    );
  }

  return (
    <form
      onSubmit={handleSignUp}
      className='w-full max-w-sm bg-white text-black rounded-xl shadow-lg p-6 flex flex-col gap-4'
    >
      <div className='text-center'>
        <h1 className='text-xl font-semibold'>Create your {BRAND.name} account</h1>
        <p className='text-sm text-gray-500'>Start hosting premium HD meetings.</p>
      </div>

      <div className='grid grid-cols-2 gap-3'>
        <label className='flex flex-col gap-1 text-sm'>
          <span className='font-medium'>First name</span>
          <input
            type='text'
            autoComplete='given-name'
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className='border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500'
            placeholder='Jane'
          />
        </label>
        <label className='flex flex-col gap-1 text-sm'>
          <span className='font-medium'>Last name</span>
          <input
            type='text'
            autoComplete='family-name'
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className='border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500'
            placeholder='Doe'
          />
        </label>
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

      <PasswordField
        label='Password'
        value={password}
        onChange={setPassword}
        autoComplete='new-password'
        minLength={8}
        placeholder='At least 8 characters'
      />

      <PasswordField
        label='Confirm password'
        value={confirmPassword}
        onChange={setConfirmPassword}
        autoComplete='new-password'
        minLength={8}
        placeholder='Re-enter your password'
        invalid={!!confirmPassword && password !== confirmPassword}
        hint={confirmPassword && password !== confirmPassword ? 'Passwords do not match.' : null}
      />

      {error && (
        <div role='alert' className='bg-red-100 text-red-800 text-sm px-3 py-2 rounded'>{error}</div>
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
        <Link
          href={
            redirectUrl && redirectUrl !== '/'
              ? `/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`
              : '/sign-in'
          }
          className='text-blue-600 hover:underline'
        >
          Sign in
        </Link>
      </div>
    </form>
  );
}
