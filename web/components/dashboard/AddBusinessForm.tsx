'use client';

import { useActionState } from 'react';
import { addBusinessAction } from '@/lib/actions/auth';
import { BAD, FormField, INPUT, OK } from '@/components/FormField';

const CATEGORIES = [
  { value: 'salon', label: 'Salon' },
  { value: 'clinic', label: 'Clinic' },
  { value: 'gym', label: 'Gym or studio' },
] as const;

interface Props {
  defaultCategory: string;
}

export function AddBusinessForm({ defaultCategory }: Props) {
  const [state, formAction, isPending] = useActionState(addBusinessAction, undefined);

  return (
    <form action={formAction} className="space-y-5">
      <FormField
        id="businessName"
        label="Branch name"
        autoComplete="organization"
        hint="How customers will see it, e.g. “CrossFit — DHA”."
        error={state?.fields?.businessName}
      />

      <div>
        <label htmlFor="category" className="block text-[14px] font-semibold text-ink">
          What kind of business?
        </label>
        <select
          id="category"
          name="category"
          defaultValue={defaultCategory}
          className={`${INPUT} ${state?.fields?.category ? BAD : OK}`}
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <FormField
        id="city"
        label="City"
        autoComplete="address-level2"
        error={state?.fields?.city}
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
        {isPending ? 'Adding the branch…' : 'Add branch'}
      </button>
    </form>
  );
}
