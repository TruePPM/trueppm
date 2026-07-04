import { useId, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { AuthShell } from './AuthShell';
import { confirmPasswordReset } from './resetApi';
import {
  checkRequirements,
  passwordScore,
  strengthLabel,
  type StrengthScore,
} from './passwordStrength';

/**
 * Screen 3 — set a new password (issue 765, ADR-0209).
 *
 * uid + token come from the route (the emailed link). Client-side strength meter
 * and requirements checklist are advisory; the server has final say. The confirm
 * endpoint returns distinct codes: success → done screen, `invalid_token` →
 * expired screen, `weak_password` → inline messages.
 */
export function ResetPasswordConfirmPage() {
  const { uid = '', token = '' } = useParams<{ uid: string; token: string }>();
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const passwordId = useId();
  const confirmId = useId();

  const score = useMemo(() => passwordScore(password), [password]);
  const requirements = useMemo(() => checkRequirements(password), [password]);
  const passwordsMatch = confirm.length > 0 && password === confirm;
  const canSubmit =
    requirements.length && requirements.numberOrSymbol && passwordsMatch && !isSubmitting;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setServerErrors([]);
    setFormError(null);
    setIsSubmitting(true);

    const outcome = await confirmPasswordReset(uid, token, password);
    switch (outcome.kind) {
      case 'success':
        void navigate('/reset-password/done', { replace: true });
        return;
      case 'invalid_token':
        void navigate('/reset-password/expired', { replace: true });
        return;
      case 'weak_password':
        setServerErrors(
          outcome.messages.length > 0
            ? outcome.messages
            : ['Password does not meet the requirements.'],
        );
        break;
      case 'rate_limited':
        setFormError('Too many attempts. Please wait a minute and try again.');
        break;
      default:
        setFormError('Something went wrong. Please try again.');
    }
    setIsSubmitting(false);
  }

  return (
    <AuthShell
      step={3}
      title="Choose a new password"
      subtitle="Pick a strong password you don't use anywhere else."
      backToSignIn={false}
    >
      <form
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        noValidate
        className="flex flex-col gap-4"
      >
        {/* New password */}
        <div className="flex flex-col gap-1">
          <label htmlFor={passwordId} className="text-sm font-medium text-neutral-text-primary">
            New password
          </label>
          <div className="relative">
            <input
              id={passwordId}
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              required
              // eslint-disable-next-line jsx-a11y/no-autofocus -- single-purpose recovery screen: focus the first password field on open
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isSubmitting}
              className="
                h-10 w-full pl-3 pr-10 rounded border border-neutral-border
                bg-neutral-surface text-neutral-text-primary text-sm font-mono
                focus-visible:outline-none focus-visible:border-brand-primary
                focus-visible:ring-[3px] focus-visible:ring-brand-primary/20
                disabled:opacity-50 disabled:cursor-not-allowed
              "
            />
            <ShowHideToggle
              shown={showPassword}
              onToggle={() => setShowPassword((v) => !v)}
            />
          </div>
        </div>

        {/* Strength bar */}
        {password.length > 0 && <StrengthBar score={score} />}

        {/* Confirm password */}
        <div className="flex flex-col gap-1">
          <label htmlFor={confirmId} className="text-sm font-medium text-neutral-text-primary">
            Confirm new password
          </label>
          <input
            id={confirmId}
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={isSubmitting}
            className="
              h-10 w-full px-3 rounded border border-neutral-border
              bg-neutral-surface text-neutral-text-primary text-sm font-mono
              focus-visible:outline-none focus-visible:border-brand-primary
              focus-visible:ring-[3px] focus-visible:ring-brand-primary/20
              disabled:opacity-50 disabled:cursor-not-allowed
            "
          />
          {confirm.length > 0 && !passwordsMatch && (
            <p className="text-xs text-semantic-critical">Passwords don’t match.</p>
          )}
        </div>

        {/* Requirements checklist */}
        <RequirementsChecklist
          length={requirements.length}
          numberOrSymbol={requirements.numberOrSymbol}
        />

        {/* Server-side policy errors */}
        {serverErrors.length > 0 && (
          <ul role="alert" className="flex flex-col gap-1 text-sm text-semantic-critical">
            {serverErrors.map((msg) => (
              <li key={msg}>{msg}</li>
            ))}
          </ul>
        )}

        {formError !== null && (
          <p role="alert" className="text-sm text-semantic-critical">
            {formError}
          </p>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className="
            h-11 w-full rounded bg-brand-primary text-white
            text-sm font-semibold
            hover:bg-brand-primary-dark
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
            disabled:opacity-50 disabled:cursor-not-allowed
            transition-colors
          "
        >
          {isSubmitting ? 'Updating…' : 'Update password'}
        </button>
      </form>
    </AuthShell>
  );
}

/** Four-segment strength bar with a text label (Too weak … Excellent). */
function StrengthBar({ score }: { score: StrengthScore }) {
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
function RequirementsChecklist({
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

function ShowHideToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
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
