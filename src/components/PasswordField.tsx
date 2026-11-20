'use client';

// A password box with a Show / Hide button, for sign-in, sign-up and reset.
//
// The box used to sit inside a <label> together with its Show button, so a
// screen reader named the box "Password Show" and the button just "Show".
// Here the label names only the box, and the button says what it does
// ("Show password" / "Hide password") and whether it is on.

import { useId, useState } from 'react';

export default function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
  minLength,
  invalid = false,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  placeholder?: string;
  minLength?: number;
  /** Shown red, with `hint` under it (for "Passwords do not match"). */
  invalid?: boolean;
  hint?: string | null;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [show, setShow] = useState(false);
  const name = label.toLowerCase();
  return (
    <div className='flex flex-col gap-1 text-sm'>
      <label htmlFor={id} className='font-medium'>
        {label}
      </label>
      <div className='relative'>
        <input
          id={id}
          type={show ? 'text' : 'password'}
          required
          minLength={minLength}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={hint ? hintId : undefined}
          className={
            'w-full border rounded px-3 py-2 pr-16 focus:outline-none focus:ring-2 ' +
            (invalid ? 'border-red-400 focus:ring-red-500' : 'focus:ring-blue-500')
          }
          placeholder={placeholder}
        />
        <button
          type='button'
          onClick={() => setShow((s) => !s)}
          aria-label={show ? `Hide ${name}` : `Show ${name}`}
          aria-pressed={show}
          aria-controls={id}
          className='absolute right-2 top-1/2 -translate-y-1/2 text-xs text-blue-600 hover:underline'
        >
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
      {hint ? (
        <span id={hintId} className='text-xs text-red-600'>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
