/**
 * Shared password-entry UI for the public auth screens (issue 765, extended #2035).
 *
 * The strength bar, requirements checklist, and show/hide toggle were originally
 * local to `ResetPasswordConfirmPage`; they are extracted here so the invite-accept
 * screen reuses the exact same advisory feedback rather than reinventing it. All
 * three are pure presentational components driven by the `passwordStrength` helpers
 * — the server's `AUTH_PASSWORD_VALIDATORS` remain the authority on submit.
 */

import { type StrengthScore, strengthLabel } from './passwordStrength';

/** Four-segment strength bar with a text label (Too weak … Excellent). */
export function StrengthBar({ score }: { score: StrengthScore }) {
  const segmentColor: Record<StrengthScore, string> = {
    0: 'bg-semantic-critical',
    1: 'bg-semantic-critical',
    2: 'bg-semantic-at-risk',
    3: 'bg-brand-primary',
    4: 'bg-semantic-on-track',
  };
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <div className="flex gap-1.5" aria-hidden="true">
        {[1, 2, 3, 4].map((seg) => (
          <span
            key={seg}
            className={`h-1.5 flex-1 rounded-full ${
              seg <= score ? segmentColor[score] : 'bg-neutral-border'
            }`}
          />
        ))}
      </div>
      <p className="text-xs text-neutral-text-secondary">
        Password strength: <span className="font-medium">{strengthLabel(score)}</span>
      </p>
    </div>
  );
}

/** Inline requirements checklist — two live client checks + one server-checked item. */
export function RequirementsChecklist({
  length,
  numberOrSymbol,
}: {
  length: boolean;
  numberOrSymbol: boolean;
}) {
  return (
    <ul className="flex flex-col gap-1.5 text-xs">
      <RequirementItem met={length} label="At least 10 characters" />
      <RequirementItem met={numberOrSymbol} label="One number or symbol" />
      {/* Server-checked — cannot be verified client-side, shown as informational. */}
      <RequirementItem met={null} label="Not a previously used password" />
    </ul>
  );
}

function RequirementItem({ met, label }: { met: boolean | null; label: string }) {
  // `met === null` is the server-checked, client-unverifiable item ("not a
  // previously used password"). It reads as neutral informational text — kept at
  // text-secondary (not text-disabled) so it still clears WCAG 1.4.3 contrast.
  const color = met === true ? 'text-semantic-on-track' : 'text-neutral-text-secondary';
  // State must not be conveyed by icon + color alone (rule 6 / WCAG 1.4.1): give
  // screen readers a word for it. The null (informational) item gets no prefix —
  // it is neither met nor unmet until the server checks it on submit.
  const srState = met === true ? 'Met: ' : met === false ? 'Not yet met: ' : '';
  return (
    <li className={`flex items-center gap-2 ${color}`}>
      <span aria-hidden="true">{met === true ? <CheckIcon /> : <DotIcon />}</span>
      <span>
        {srState && <span className="sr-only">{srState}</span>}
        {label}
      </span>
    </li>
  );
}

/** Absolutely-positioned show/hide button filling the right edge of a password input. */
export function PasswordVisibilityToggle({
  shown,
  onToggle,
}: {
  shown: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={shown ? 'Hide password' : 'Show password'}
      aria-pressed={shown}
      // Fill the input's right edge (h-full = 40px) for a comfortable tap target
      // rather than a tiny icon-sized hit area.
      className="absolute right-0 top-0 h-full w-10 flex items-center justify-center text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded"
    >
      {shown ? <EyeOffIcon /> : <EyeIcon />}
    </button>
  );
}

function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.5 3.7A6.7 6.7 0 018 3.5c4.5 0 7 4.5 7 4.5a12 12 0 01-2 2.5M4 4.6A11.6 11.6 0 001 8s2.5 4.5 7 4.5c.9 0 1.7-.2 2.4-.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M2 2l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 8.5l3.2 3.2L13 4.8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DotIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="8" r="2.5" />
    </svg>
  );
}
