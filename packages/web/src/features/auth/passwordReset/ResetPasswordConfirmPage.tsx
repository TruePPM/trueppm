import { useId, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { AuthShell } from './AuthShell';
import { confirmPasswordReset } from './resetApi';
import { checkRequirements, passwordScore } from './passwordStrength';
import { PasswordVisibilityToggle, RequirementsChecklist, StrengthBar } from './passwordFields';

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
            <PasswordVisibilityToggle
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
            h-11 w-full rounded bg-brand-primary text-neutral-text-inverse
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
