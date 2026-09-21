/**
 * Telling a deployment-mode refusal apart from every other 403 (ADR-1197 D3, #3926).
 *
 * The read-only demo's middleware refuses every unsafe method under `/api/` with a
 * `403` carrying a stable `code`. That refusal is a **designed product surface**, not
 * an error: a visitor who meets a red "Forbidden" concludes the product is broken,
 * which is the exact impression the demo exists to prevent. So it has to be routed
 * somewhere else than the generic error path — and routing it there depends on
 * recognizing it without ever mistaking an ordinary permission refusal for it.
 *
 * Framework-free (only axios), like its `writeRefusal` / `apiError` neighbours, so a
 * non-React module (the response interceptor, the mutation hooks) can read it.
 */
import axios from 'axios';
import type { AxiosError } from 'axios';

/** The middleware's stable machine-readable refusal code (`api/errors.md`). */
export const DEMO_READ_ONLY_CODE = 'demo_read_only';

/** The global toast raised for any refused write with no anchored surface of its own. */
export const DEMO_REFUSAL_TOAST = "Read-only demo — that change wasn't saved.";

/** Shown on a control the demo disables up front, rather than refusing after the fact. */
export const DEMO_DISABLED_NOTE = 'Not available in the read-only demo.';

/**
 * Is this failure the read-only demo's own refusal?
 *
 * **Both halves are load-bearing.** Status alone mislabels an ordinary RBAC 403 as a
 * demo notice — telling a user with genuinely insufficient rights that "nothing here
 * is saved", which is D3's failure mode inverted. Code alone would match a `400` whose
 * body happens to carry the same string.
 *
 * `error.response.data` is `unknown`: a Django HTML 500 page arrives as a `string`, and
 * `typeof 'x' === 'object'` is false, so the guard is closed against it.
 *
 * Narrows to `AxiosError` on the true branch so a caller that then reads `error.config`
 * (the interceptor's suppression check) does not have to re-test what this just proved.
 */
export function isDemoReadOnlyRefusal(error: unknown): error is AxiosError {
  if (!axios.isAxiosError(error)) return false;
  if (error.response?.status !== 403) return false;
  const data: unknown = error.response.data;
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { code?: unknown }).code === DEMO_READ_ONLY_CODE
  );
}
