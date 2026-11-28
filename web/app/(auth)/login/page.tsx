'use client';

import { useActionState } from 'react';
import { PasswordInput } from '@/components/PasswordInput';
import Link from 'next/link';
import { loginAction } from '@/lib/actions/auth';
import { SiteHeader } from '@/components/SiteHeader';
import { GrainOverlay } from '@/components/GrainOverlay';

export default function LoginPage() {
  const [state, formAction, isPending] = useActionState(loginAction, undefined);

  return (
    <div className="min-h-screen bg-white hero-wash">
      <GrainOverlay />
      <SiteHeader transparent />
      
      <main className="flex min-h-[calc(100vh-80px)] items-center justify-center px-5 py-12">
        <div className="w-full max-w-[440px] bg-white p-8 md:p-10 border border-line rounded-3xl shadow-sm relative z-10">
          <div className="text-center mb-8">
            <img src="/brand/scalivo-logo.svg" alt="" width={64} height={64} className="mx-auto mb-5" />
            <h1 className="text-[32px] leading-none font-bold tracking-[-0.03em] text-ink">Sign in to scalivo</h1>
            <p className="text-muted mt-3 text-[15px]">Welcome back to your business dashboard</p>
          </div>

          <form action={formAction} className="space-y-5">
            <div>
              <label htmlFor="email" className="block text-[14px] font-semibold text-ink">
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                className="mt-2 block w-full rounded-xl border border-line px-4 py-3 text-[15px] outline-none focus:border-ink focus:ring-1 focus:ring-ink transition-all bg-surface/50 focus:bg-white"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-[14px] font-semibold text-ink">
                Password
              </label>
              <PasswordInput
                id="password"
                name="password"
                autoComplete="current-password"
                required
                className="mt-2 block w-full rounded-xl border border-line px-4 py-3 text-[15px] outline-none focus:border-ink focus:ring-1 focus:ring-ink transition-all bg-surface/50 focus:bg-white"
              />
            </div>

            {state?.error && (
              <div className="text-[14px] font-medium text-red-700 bg-red-50 rounded-xl px-4 py-3 border border-red-100">
                {state.error}
              </div>
            )}

            <button
              type="submit"
              disabled={isPending}
              className="mt-2 w-full inline-flex h-12 items-center justify-center rounded-full bg-ink px-6 text-[16px] font-semibold text-white transition-colors hover:bg-black/80 disabled:opacity-50"
            >
              {isPending ? 'Signing in...' : 'Sign in'}
            </button>
          </form>

          <p className="mt-8 text-center text-[15px] font-medium text-muted">
            Don&apos;t have an account?{' '}
            <Link href="/register" className="text-ink hover:underline underline-offset-4 decoration-line">
              Create one
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
