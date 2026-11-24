/**
 * The labelled text input the account forms share — Create Account and Add a
 * branch — so the two read as one product and underline errors the same way.
 */

export const INPUT =
  'mt-2 block w-full rounded-xl border px-4 py-3 text-[15px] outline-none transition-all bg-surface/50 focus:bg-white focus:ring-1';
export const OK = 'border-line focus:border-ink focus:ring-ink';
export const BAD = 'border-red-300 focus:border-red-500 focus:ring-red-500';

export function FormField({
  id,
  label,
  type = 'text',
  autoComplete,
  hint,
  error,
  defaultValue,
}: {
  id: string;
  label: string;
  // `| undefined` spelled out because tsconfig sets exactOptionalPropertyTypes:
  // "absent" and "present but undefined" are different types under it, and the
  // caller passes the second.
  type?: string | undefined;
  autoComplete?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  defaultValue?: string | undefined;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-[14px] font-semibold text-ink">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        required
        autoComplete={autoComplete}
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={`${INPUT} ${error ? BAD : OK}`}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-[13px] font-medium text-red-700">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-[13px] text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
