/**
 * User-id comparison across the two wire encodings of the same integer PK (#2633).
 *
 * The auth model is `django.contrib.auth.models.User`, whose PK is an integer
 * `AutoField`. Most serializers emit a user FK as a JSON number (`Risk.owner`,
 * `Program.lead`, `AgentAction.principal`, membership `user`, …). A few emit
 * the same PK as a decimal *string*: `/auth/me/`'s `id` (so `CurrentUser.id`),
 * and the comment/mention author payloads. That split is a settled, documented
 * API contract, not an accident this helper papers over — changing `/auth/me/`
 * to a number would break every client that already keys on the string.
 *
 * So whenever one side of an equality is `CurrentUser.id` and the other is a
 * numeric FK, `===` is always false at runtime. Compare through this instead of
 * reaching for an ad-hoc `String(a) === String(b)` at each call site.
 *
 * @param a - A user id in either encoding, or null/undefined.
 * @param b - A user id in either encoding, or null/undefined.
 * @returns true only when both are present and name the same user.
 */
export function isSameUser(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): boolean {
  if (a == null || b == null || a === '' || b === '') return false;
  return String(a) === String(b);
}
