/**
 * One definition of how a refused write is presented (#3332).
 *
 * Sits beside `apiError.ts` and reads through it, so the classification of a
 * failure (`isClientRejection`) and the reading of its body
 * (`extractValidationMessage`) stay in one place and this module only decides
 * what a *surface* needs: the sentence, an optional second line, and whether a
 * retry affordance is honest.
 *
 * Framework-free (only axios) for the same reason `apiError.ts` is — nine
 * surfaces consume it, and none of them should have to mount React to test the
 * shape of a refusal.
 */
import axios from 'axios';
import { extractValidationMessage, isClientRejection } from './apiError';

/**
 * A refused write, as a surface must present it.
 *
 * A record rather than a string because **the button label is part of the
 * answer**. A surface that collapses a refusal to a sentence has already thrown
 * away the one bit that decides whether "Retry" is advice or a dead end.
 */
export interface WriteRefusal {
  /** The server's own sentence, or `fallback` when it sent none that can be shown. */
  message: string;
  /** A second line built from the refusal's structured fields; `null` when it has none. */
  detail: string | null;
  /** Whether replaying the identical request could plausibly succeed. */
  retryable: boolean;
}

/**
 * A surface's own reading of the machine-readable fields DRF ships beside
 * `detail` — the **remedy**, not a re-narration of the prose (web-rule 372).
 *
 * Takes the already-resolved `message` so it can decline to repeat what the
 * sentence already says.
 */
export type StructuredDetail = (error: unknown, message: string) => string | null;

/**
 * The two `4xx` codes that refuse the request's *timing* rather than its
 * content. `isClientRejection` is right that a `4xx` is a decision the server
 * has already made — but these two decide about *now*, and the same bytes sent
 * later do succeed, so the bare predicate would strand them (web-rule 372a).
 */
const RETRYABLE_CLIENT_STATUSES = new Set([408, 429]);

/**
 * Whether replaying the identical request could plausibly succeed.
 *
 * Everything that is not a client rejection — a network loss, a timeout with no
 * response, a `5xx` — is retryable by default: the server either never decided
 * or decided in a way that may not repeat.
 */
export function isRetryableFailure(error: unknown): boolean {
  if (!isClientRejection(error)) return true;
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  return status !== undefined && RETRYABLE_CLIENT_STATUSES.has(status);
}

/** Longest server sentence worth showing inline before it stops being a sentence. */
const MAX_MESSAGE_LENGTH = 300;

/**
 * Guard against a body that is not a message at all.
 *
 * A genuine crash never reaches DRF's JSON renderer — Django serves an HTML 500
 * page, and axios hands that whole page over as a string, which
 * `extractValidationMessage` faithfully returns. Rendering it drops markup (or,
 * under `DEBUG`, a traceback) into a slot where a sentence belongs. Not a
 * disclosure — anyone who can reach that response can read it in devtools — but
 * it is unreadable, so fall back rather than paste it.
 *
 * **Length is a different question from readability, and it is answered
 * differently.** An over-long body is usually a legitimate sentence (a
 * multi-field validation summary, a policy explanation), so substituting the
 * fallback for it produces *exactly* the output that means "the server sent
 * nothing readable" — the reader cannot tell a reason is being withheld, which
 * is the one thing this whole helper exists to stop. Truncate with an ellipsis
 * instead: a clipped run reads as incomplete, where a silently substituted one
 * reads as absent (web-rule 328's precedent, surfaced by `ux-review` on #3332).
 * The fallback stays for the empty and HTML cases, where there is genuinely no
 * sentence to clip.
 *
 * **The markup test must not be anchored at position 0.** It used to be, and the
 * length branch happened to catch any real page anyway — so the two guards were
 * redundant and nobody noticed the weaker one. Turning length into a truncation
 * left `startsWith('<')` as the only markup test, which `locate()` in
 * `apiError.ts` can defeat by prepending `Item 1: ` to a nested body's message.
 * Match the doctype/`<html>` marker anywhere instead (surfaced by
 * `security-review` on #3332).
 */
const MARKUP_MARKER = /<!doctype\b|<html\b|<\/html>|<body\b/i;

function presentable(message: string, fallback: string): string {
  const trimmed = message.trim();
  if (trimmed === '' || trimmed.startsWith('<') || MARKUP_MARKER.test(trimmed)) return fallback;
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return `${trimmed.slice(0, MAX_MESSAGE_LENGTH).trimEnd()}…`;
  }
  return trimmed;
}

/**
 * Project a failed write onto what a surface renders.
 *
 * Pure and exported so every refusal shape can be driven through it directly —
 * passing a finished string in as a prop tests the slot, not the wiring, which
 * is how eight surfaces collapsed distinct refusals to one hardcoded sentence
 * unnoticed (#3302, #3332).
 *
 * Returns `null` for a nullish error so a caller can pass a mutation's `error`
 * straight through without a ternary.
 */
export function describeWriteRefusal(
  error: unknown,
  fallback: string,
  structuredDetail?: StructuredDetail,
): WriteRefusal | null {
  if (error === null || error === undefined) return null;
  const message = presentable(extractValidationMessage(error, fallback), fallback);
  return {
    message,
    detail: structuredDetail ? structuredDetail(error, message) : null,
    retryable: isRetryableFailure(error),
  };
}
