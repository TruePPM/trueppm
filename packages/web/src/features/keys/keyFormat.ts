import type { RefKind } from '@/lib/refPath';

/**
 * Client-side key **format** check (ADR-1237 §2, UX §1).
 *
 * This validates the shape of a value the user is typing — it never parses a
 * reference. It is instant, and when it fails it suppresses the network check,
 * because the server would only say "invalid" after a round trip. Reserved words
 * and availability stay server answers.
 *
 * The copy matches the server's 400 messages (minus the trailing period), so the
 * status line reads the same whichever side caught it.
 */
export const KEY_FORMAT_MESSAGE: Record<RefKind, string> = {
  project: 'Letters and digits only, starting with a letter, 2–10 characters',
  program: 'Lowercase letters, digits and hyphens, up to 40 characters',
};

const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
const PROGRAM_KEY_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const PROGRAM_KEY_MAX = 40;

/** Case the way the server stores it: project keys upper, program keys lower. */
export function normalizeKeyInput(kind: RefKind, raw: string): string {
  const trimmed = raw.replace(/\s+/g, '');
  return kind === 'project' ? trimmed.toUpperCase() : trimmed.toLowerCase();
}

/**
 * The format message for a **new** key that does not match, or `null`.
 * An empty value is not an error here — blank means "let the server derive it".
 */
export function keyFormatError(kind: RefKind, key: string): string | null {
  if (key === '') return null;
  const ok =
    kind === 'project'
      ? PROJECT_KEY_RE.test(key)
      : key.length <= PROGRAM_KEY_MAX && PROGRAM_KEY_RE.test(key);
  return ok ? null : KEY_FORMAT_MESSAGE[kind];
}

/** The longest value the input accepts — the new-key maximum for each kind. */
export const KEY_MAX_LENGTH: Record<RefKind, number> = { project: 10, program: PROGRAM_KEY_MAX };
