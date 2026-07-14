/**
 * Small, pure helpers for classifying and reading API write errors (#1945).
 *
 * Framework-free (only axios) so both the sync-status projection and the
 * feature surfaces that write can share one definition, and so the logic is
 * unit-testable without React.
 */
import axios from 'axios';

/**
 * A *client rejection* is a write the server received and refused with a `4xx`
 * — a validation error (400), a permission denial (403), a missing target
 * (404), a conflict (409). It is fundamentally different from an offline /
 * network / `5xx` failure: the server has already made a definitive decision,
 * so **replaying the identical request will be rejected again**.
 *
 * The offline sync machinery must therefore ignore it (#1945): a client
 * rejection is not a "pending change" waiting to drain, it must not drive the
 * global sync-status badge, and the badge's "Retry now" must not blindly
 * replay it. The offending surface shows the reason inline instead, and a real
 * retry is the user editing the value and re-submitting.
 *
 * `5xx` (server error) is deliberately *not* a client rejection: it may be
 * transient and replaying it can succeed, so it stays in the sync badge.
 */
export function isClientRejection(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  return status !== undefined && status >= 400 && status < 500;
}

/**
 * Read a human-readable reason out of a DRF error response body, falling back
 * to `fallback` when the shape is unrecognized or the error is not an axios
 * error (e.g. a network failure).
 *
 * DRF renders validation errors as either `{ field: ["msg", …] }`,
 * `{ non_field_errors: ["msg"] }`, or `{ detail: "msg" }`. We surface the first
 * message we find, without a field prefix — the message is shown next to the
 * offending cell, so the field is already obvious from context.
 */
export function extractValidationMessage(error: unknown, fallback: string): string {
  if (!axios.isAxiosError(error)) return fallback;
  const data: unknown = error.response?.data;
  if (typeof data === 'string' && data.trim() !== '') return data;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    // Prefer `detail`, then `non_field_errors`, then the first field's error.
    const ordered = [
      record.detail,
      record.non_field_errors,
      ...Object.keys(record)
        .filter((k) => k !== 'detail' && k !== 'non_field_errors')
        .map((k) => record[k]),
    ];
    for (const value of ordered) {
      const message = firstString(value);
      if (message) return message;
    }
  }
  return fallback;
}

/** First non-empty string in `value`, unwrapping a `["msg", …]` DRF list. */
function firstString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.trim() !== '') return item;
    }
  }
  return null;
}
