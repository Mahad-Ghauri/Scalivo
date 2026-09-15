import type express from 'express';
import type { z } from 'zod';

/** Small shared pieces every tenant-scoped router needs. */

/**
 * Express 5 types a route param as `string | string[]` because a wildcard can
 * repeat. Ours never do, but the narrowing has to happen somewhere — and
 * requireTenant has already refused anything that is not a plain string.
 */
export function param(req: express.Request, name: string): string {
  const value = req.params[name];
  return typeof value === 'string' ? value : '';
}

/**
 * Flatten a zod failure into `{ field: message }` for the client.
 *
 * The full dotted path, not just its first segment: a nested failure like
 * `workingHours.0.opensAt` is the one the owner most needs pointed at, and
 * keying on `path[0]` alone collapses every hours error onto "workingHours"
 * and drops a root-level refine (empty path) entirely.
 *
 * First message per field wins — later issues on the same field are usually
 * consequences of the first, and a form shows one message per input anyway.
 */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}
