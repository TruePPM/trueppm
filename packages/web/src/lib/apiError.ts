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
 * DRF renders validation errors as `{ field: ["msg", …] }`,
 * `{ non_field_errors: ["msg"] }`, `{ detail: "msg" }`, or one of the nested
 * per-item / per-subfield shapes (see {@link findFirstMessage}). We surface the
 * first message we find, without a field prefix — the message is shown next to
 * the offending cell, so the field is already obvious from context. A *position
 * within* the field is not obvious, so a nested message keeps its `Item 3: …`
 * prefix.
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
 * A nested rejection collapses to its **top-level** field: forms key the
 * highlight off the field name they rendered an input for, so `hidden_views.0`
 * would match no input and highlight nothing. The item index is not discarded —
 * it rides in the message as `Item 1: …` (#3325).
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

/**
 * How deep {@link findFirstMessage} will descend before giving up. DRF nests at
 * most a few levels in practice (`field → index → subfield → messages`); the cap
 * exists so an unexpected body can never make error *reporting* the expensive
 * part of a failed write.
 */
const MAX_ERROR_DEPTH = 8;

/** A message found in an error body, with its position relative to the field it was found under. */
interface LocatedMessage {
  /**
   * Path segments *below* the top-level field — `['0']` for the first item of a
   * `ListField`, `['overlays']` for a nested serializer's subfield. Empty for the
   * flat `{ field: ["msg"] }` shape, where the field alone locates the error.
   */
  path: string[];
  message: string;
}

/**
 * First non-empty message inside a DRF error value, descending through the
 * nested shapes DRF actually produces (#3325).
 *
 * DRF does not stop at `string[]`: a `ListField` keys its per-item errors by
 * **item index** (`{"hidden_views": {"0": ["Not a valid string."]}}`), a nested
 * serializer by **subfield name** (`{"calendar": {"overlays": ["Unknown role."]}}`),
 * and a `many=True` serializer by **list position** with an empty object per
 * valid item (`{"tasks": [{}, {"name": ["This field is required."]}]}`). A
 * non-recursive read returns `null` for all three, so the reason the server
 * *did* send is discarded and the form falls through to a generic banner.
 *
 * A plain `["msg", …]` list is deliberately **not** treated as positional: its
 * index is an artifact of DRF listing several messages about one value, not a
 * position the user can act on. Only a non-string element contributes its index
 * to the path — which is what keeps the flat shapes byte-for-byte unchanged.
 */
function findFirstMessage(value: unknown, depth = 0): LocatedMessage | null {
  if (typeof value === 'string') {
    return value.trim() !== '' ? { path: [], message: value } : null;
  }
  if (depth >= MAX_ERROR_DEPTH) return null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findFirstMessage(item, depth + 1);
      if (!found) continue;
      return typeof item === 'string'
        ? found
        : { path: [String(index), ...found.path], message: found.message };
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const found = findFirstMessage(item, depth + 1);
      if (found) return { path: [key, ...found.path], message: found.message };
    }
    return null;
  }
  return null;
}

/**
 * Render a {@link LocatedMessage} for display, prefixing *where inside the field*
 * the error is when that is not the field itself.
 *
 * The offending field is already obvious to the user — the message is shown next
 * to it, and {@link extractFieldErrors} highlights it. What they cannot see is
 * which of twelve list items the server rejected, so the position is the part
 * worth spending words on. A numeric segment is rendered 1-based (`Item 3`)
 * because a user counts rows from one, not from zero.
 */
function locate({ path, message }: LocatedMessage): string {
  if (path.length === 0) return message;
  const where = path
    .map((segment) => (/^\d+$/.test(segment) ? `Item ${Number(segment) + 1}` : segment))
    .join(' → ');
  return `${where}: ${message}`;
}

/**
 * First non-empty message string in `value`, unwrapping the flat `["msg", …]`
 * DRF list and descending into the nested shapes — see {@link findFirstMessage}.
 */
function firstString(value: unknown): string | null {
  const found = findFirstMessage(value);
  return found ? locate(found) : null;
}
