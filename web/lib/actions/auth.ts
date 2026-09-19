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

export async function logoutAction() {
  await clearSessionCookie();
  redirect('/login');
}
