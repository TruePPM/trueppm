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

/**
 * Read DRF *field-level* validation errors out of a 400 body as a
 * `{ field: message }` map (first message per field), so a form can highlight
 * the offending inputs (`aria-invalid` + an inline `role="alert"` message,
 * matching `RiskForm`). Form-level keys (`detail`, `non_field_errors`) are
 * excluded — surface those in a banner via {@link extractValidationMessage}.
 *
 * Returns an empty object for non-axios errors, network / `5xx` failures, or an
 * unrecognized body shape, so the caller can fall back to a banner-only message
 * without promising per-field highlighting that will not appear.
 */
export function extractFieldErrors(error: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!axios.isAxiosError(error)) return out;
  const data: unknown = error.response?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (key === 'detail' || key === 'non_field_errors') continue;
    const message = firstString(value);
    if (message) out[key] = message;
  }
  return out;
}

/**
 * Read only the *form-level* DRF message (`detail` or `non_field_errors`) — the
 * error that belongs to no single field — for a banner shown above a form whose
 * individual fields are highlighted separately via {@link extractFieldErrors}.
 * Returns `null` when the failure is field-only, opaque, or not a DRF body, so
 * the caller can choose its own lead-in ("correct the highlighted fields") or
 * generic fallback instead.
 */
export function extractFormLevelMessage(error: unknown): string | null {
  if (!axios.isAxiosError(error)) return null;
  const data: unknown = error.response?.data;
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  return firstString(record.detail) ?? firstString(record.non_field_errors);
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
