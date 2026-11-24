'use server';

import { redirect } from 'next/navigation';
import { clearSessionCookie, setSessionCookie } from '../auth/session';
import { fetchApi, ApiError } from '../api-client';
import { z } from 'zod';

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function loginAction(prevState: { error?: string } | undefined, formData: FormData) {
  const email = formData.get('email');
  const password = formData.get('password');

  const parsed = credentialsSchema.safeParse({ email, password });
  if (!parsed.success) {
    return { error: 'Invalid email or password' };
  }

  try {
    const data = await fetchApi<{ token: string; role: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
    });

    if (data.role === 'staff')
      return { error: 'This dashboard is for business owners. Contact your owner for access.' };

    if (data.token) {
      await setSessionCookie(data.token);
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return { error: 'Invalid email or password' };
    }
    return { error: 'Something went wrong. Please try again later.' };
  }

  // Next.js redirect must be called outside try-catch to work properly.
  redirect('/dashboard');
}

/**
 * Self-serve signup on the web.
 *
 * The backend has had `POST /auth/register` since Phase 0, but the only screen
 * in front of it was the Flutter app's Create Account — so an owner who opened
 * the site on a laptop had nowhere to sign up, and the login page offered a
 * mailto instead. That is fine for a sales-led launch and wrong for milestone
 * 5.1, which has the pilot owner onboard THEMSELVES while we watch: the
 * usability findings the thesis needs come from someone meeting this form
 * without us, and a form that does not exist cannot be met.
 *
 * Field errors are passed through rather than flattened into one banner,
 * because the API already keys them by field and the form underlines the
 * offending input.
 */
const registrationSchema = z.object({
  businessName: z.string().trim().min(1, 'What is the business called?'),
  category: z.enum(['salon', 'gym', 'clinic']),
  city: z.string().trim().min(1, 'Which city?'),
  ownerName: z.string().trim().min(1, 'Your name'),
  email: z.string().email('That does not look like an email address'),
  password: z.string().min(8, 'At least 8 characters'),
});

export interface RegisterState {
  error?: string;
  fields?: Record<string, string>;
}

export async function registerAction(
  prevState: RegisterState | undefined,
  formData: FormData,
): Promise<RegisterState> {
  const parsed = registrationSchema.safeParse(Object.fromEntries(formData));

  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !fields[key]) fields[key] = issue.message;
    }
    return { error: 'Check the highlighted fields.', fields };
  }

  try {
    const data = await fetchApi<{ token: string; role: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
    });

    if (data.token) await setSessionCookie(data.token);
  } catch (error) {
    if (error instanceof ApiError) {
      const body = error.data as { error?: string; fields?: Record<string, string> } | undefined;
      // 409 is a taken email; 429 is the signup rate limit added in 4.2.
      if (error.status === 429) {
        return { error: 'Too many signups from here. Wait a few minutes and try again.' };
      }
      return {
        error: body?.error ?? 'Could not create the account.',
        ...(body?.fields ? { fields: body.fields } : {}),
      };
    }
    return { error: 'Something went wrong. Please try again later.' };
  }

  // Straight into the dashboard — signup already returns a token, so bouncing
  // the owner back to a login screen would be asking them to type it twice.
  redirect('/dashboard');
}

/**
 * Adds a branch to the signed-in owner (3.7). A branch is its own business —
 * its own WhatsApp number, staff, hours and marketplace listing — so this is
 * registration's business half, against an account that already exists.
 *
 * The cookie swap is required, not tidy-up: the token carries the owner's
 * businessIds, and the old one would 404 on every page of the new branch.
 */
const newBusinessSchema = registrationSchema.pick({ businessName: true, category: true, city: true });

export async function addBusinessAction(
  prevState: RegisterState | undefined,
  formData: FormData,
): Promise<RegisterState> {
  const parsed = newBusinessSchema.safeParse(Object.fromEntries(formData));

  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !fields[key]) fields[key] = issue.message;
    }
    return { error: 'Check the highlighted fields.', fields };
  }

  let businessId: string;
  try {
    const data = await fetchApi<{ token: string; businessId: string }>('/auth/businesses', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
    });
    await setSessionCookie(data.token);
    businessId = data.businessId;
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) redirect('/login');
      if (error.status === 429) {
        return { error: 'Too many new branches in a short time. Try again in a while.' };
      }
      const body = error.data as { error?: string; fields?: Record<string, string> } | undefined;
      return {
        error: body?.error ?? 'Could not add the branch.',
        ...(body?.fields ? { fields: body.fields } : {}),
      };
    }
    return { error: 'Something went wrong. Please try again later.' };
  }

  // Into the new branch, where its setup (services, staff, WhatsApp) starts.
  redirect(`/dashboard/${businessId}`);
}

export async function logoutAction() {
  await clearSessionCookie();
  redirect('/login');
}
