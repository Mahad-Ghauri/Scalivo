'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { loginAction } from '@/lib/actions/auth';
import { SiteHeader } from '@/components/SiteHeader';
import { GrainOverlay } from '@/components/GrainOverlay';

export default function LoginPage() {
  const [state, formAction, isPending] = useActionState(loginAction, undefined);

  return (
    <>
      <GrainOverlay />
      <SiteHeader />
      <main className="flex min-h-[calc(100vh-80px)] items-center justify-center px-5 py-12">
        <div className="w-full max-w-md bg-white p-8 border border-rule shadow-sm">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-display font-semibold text-ink">Sign in to Scalivo</h1>
            <p className="text-muted mt-2 text-sm">Welcome back to your business dashboard</p>
          </div>

          <form action={formAction} className="space-y-6">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-ink">
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                className="mt-2 block w-full border border-rule px-3 py-2 outline-none focus:border-ink transition-colors"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-ink">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                className="mt-2 block w-full border border-rule px-3 py-2 outline-none focus:border-ink transition-colors"
              />
            </div>

            {state?.error && (
              <div className="text-sm text-signal-deep bg-signal/10 px-3 py-2 border border-signal-deep/20">
                {state.error}
              </div>
            )}

            <button
              type="submit"
              disabled={isPending}
              className="w-full bg-ink text-paper py-2.5 font-medium hover:bg-ink/90 disabled:opacity-50 transition-colors"
            >
              {isPending ? 'Signing in...' : 'Sign in'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-muted">
            Don&apos;t have an account?{' '}
            <Link href="mailto:hello@scalivo.app" className="text-ink underline underline-offset-4">
              Contact us
            </Link>
          </p>
        </div>
      </main>
    </>
  );
}
