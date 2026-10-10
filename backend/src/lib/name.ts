/** A recipient name needs letters and must not contain control characters or links. */
export function isUsableName(value: string): boolean {
  return /\p{L}/u.test(value) && !/\p{Cc}|https?:\/\//iu.test(value);
}
