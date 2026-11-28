'use client';

import { useState, type InputHTMLAttributes } from 'react';

/** A password input with a Show/Hide toggle, so people can check what they typed. */
export function PasswordInput({ className = '', ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input {...props} type={visible ? 'text' : 'password'} className={`${className} pr-20`} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        className="absolute right-3 top-1/2 mt-1 -translate-y-1/2 rounded-lg px-2 py-1 text-[13px] font-semibold text-muted hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
      >
        {visible ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
