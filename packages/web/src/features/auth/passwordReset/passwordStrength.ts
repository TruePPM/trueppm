/**
 * Client-side password strength + requirements helpers for the reset flow (issue 765).
 *
 * These are advisory UX only — the server's `AUTH_PASSWORD_VALIDATORS` plus the
 * reset-confirm policy (ADR-0209) are the authority. The strength meter and the
 * live requirements checklist give the user immediate feedback while typing; the
 * server has the final say on submit. Kept dependency-free (no zxcvbn) and pure so
 * they are trivially unit-testable.
 */

/** Minimum length enforced server-side (mirrors `_MIN_PASSWORD_LENGTH` in the API). */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Strength labels, indexed by score 0–4. Five labels across four filled bar
 * segments: an empty/failing password reads "Too weak" (0 segments), a strong
 * password "Excellent" (4 segments).
 */
export const STRENGTH_LABELS = ['Too weak', 'Weak', 'Fair', 'Strong', 'Excellent'] as const;

export type StrengthScore = 0 | 1 | 2 | 3 | 4;

/** Count how many distinct character classes (lower, upper, digit, symbol) appear. */
function countCharacterClasses(pw: string): number {
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/[0-9]/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  return classes;
}

/**
 * Score a password 0–4 for the strength bar.
 *
 * Deterministic heuristic: length tiers (≥8, ≥12) each add a point, and character
 * diversity (≥2 classes, ≥3 classes) each add a point, capped at 4. A password that
 * fails the hard minimum-length requirement (<10) can never read above "Weak" (1),
 * so the meter never encourages a password the server will reject on length. An
 * empty string scores 0.
 */
export function passwordScore(pw: string): StrengthScore {
  if (pw.length === 0) return 0;

  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;

  const classes = countCharacterClasses(pw);
  if (classes >= 2) score++;
  if (classes >= 3) score++;

  if (pw.length < MIN_PASSWORD_LENGTH) score = Math.min(score, 1);

  return Math.min(score, 4) as StrengthScore;
}

/** Human label for a score. */
export function strengthLabel(score: StrengthScore): string {
  return STRENGTH_LABELS[score];
}

/**
 * The two client-verifiable password requirements. The third UI requirement
 * ("Not a previously used password") can only be checked server-side, so it is not
 * represented here — the confirm page renders it as an informational item.
 */
export interface PasswordRequirements {
  /** At least MIN_PASSWORD_LENGTH characters. */
  length: boolean;
  /** Contains at least one number or one symbol (non-alphanumeric). */
  numberOrSymbol: boolean;
}

/** Evaluate the live, client-checkable requirements for a candidate password. */
export function checkRequirements(pw: string): PasswordRequirements {
  return {
    length: pw.length >= MIN_PASSWORD_LENGTH,
    numberOrSymbol: /[0-9]/.test(pw) || /[^A-Za-z0-9]/.test(pw),
  };
}

/** True when every client-checkable requirement is satisfied. */
export function allRequirementsMet(pw: string): boolean {
  const r = checkRequirements(pw);
  return r.length && r.numberOrSymbol;
}
