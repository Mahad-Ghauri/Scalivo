'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { registerAction } from '@/lib/actions/auth';
import { SiteHeader } from '@/components/SiteHeader';
import { GrainOverlay } from '@/components/GrainOverlay';
import { BAD, FormField as Field, INPUT, OK } from '@/components/FormField';

/**
 * Create a business account.
 *
 * Six fields, which is the whole point: everything else a business needs —
 * services, staff, hours, WhatsApp — is set up afterwards from the dashboard,
 * where there is room to do it properly. An owner signing up has not decided to
 * configure a booking system yet; they have decided to look at one.
 *
 * The category list is fixed rather than free text because availability,
 * marketplace facets and the agent's copy all branch on it. A business that is
 * none of the three is a product question, not an input to widen.
 */

const CATEGORIES = [
  { value: 'salon', label: 'Salon' },
  { value: 'clinic', label: 'Clinic' },
  { value: 'gym', label: 'Gym or studio' },
] as const;

export default function RegisterPage() {
  const [state, formAction, isPending] = useActionState(registerAction, undefined);
  const bad = (field: string) => Boolean(state?.fields?.[field]);

  return (
    <div className="min-h-screen bg-white hero-wash">
      <GrainOverlay />
      <SiteHeader transparent />

      <main className="flex min-h-[calc(100vh-80px)] items-center justify-center px-5 py-12">
        <div className="relative z-10 w-full max-w-[480px] rounded-3xl border border-line bg-white p-8 shadow-sm md:p-10">
          <div className="mb-8 text-center">
            <h1 className="text-[32px] font-bold leading-none tracking-[-0.03em] text-ink">
              Create your account
            </h1>
            <p className="mt-3 text-[15px] text-muted">
              Take bookings over WhatsApp. Set up takes a few minutes.
            </p>
          </div>

          <form action={formAction} className="space-y-5">
            <Field
              id="businessName"
              label="Business name"
              autoComplete="organization"
              error={state?.fields?.businessName}
            />

            <div>
              <label htmlFor="category" className="block text-[14px] font-semibold text-ink">
                What kind of business?
              </label>
              <select
                id="category"
                name="category"
                defaultValue="salon"
                className={`${INPUT} ${bad('category') ? BAD : OK}`}
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            <Field id="city" label="City" autoComplete="address-level2" error={state?.fields?.city} />
            <Field id="ownerName" label="Your name" autoComplete="name" error={state?.fields?.ownerName} />
            <Field
              id="email"
              label="Email address"
              type="email"
              autoComplete="email"
              error={state?.fields?.email}
            />
            <Field
              id="password"
              label="Password"
              type="password"
              autoComplete="new-password"
              hint="At least 8 characters."
              error={state?.fields?.password}
            />

            {state?.error && (
              <div
                role="alert"
                className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[14px] font-medium text-red-700"
              >
                {state.error}
              </div>
            )}

            <button
              type="submit"
              disabled={isPending}
              className="mt-2 inline-flex h-12 w-full items-center justify-center rounded-full bg-ink px-6 text-[16px] font-semibold text-white transition-colors hover:bg-black/80 disabled:opacity-50"
            >
              {isPending ? 'Creating your account…' : 'Create account'}
            </button>
          </form>

          <p className="mt-8 text-center text-[15px] font-medium text-muted">
            Already have an account?{' '}
            <Link href="/login" className="text-ink underline-offset-4 hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
