import { useId, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { AuthShell } from '@/features/auth/passwordReset/AuthShell';
import {
  PasswordVisibilityToggle,
  RequirementsChecklist,
  StrengthBar,
} from '@/features/auth/passwordReset/passwordFields';
import { checkRequirements, passwordScore } from '@/features/auth/passwordReset/passwordStrength';
import { WarningIcon } from '@/components/Icons';
import { acceptInvite } from './inviteApi';

/**
 * Public invite-accept page — no authentication required (#2035).
 *
 * The first screen an invited teammate sees. It reads the one-time `?token=` from
 * the URL and lets a new invitee create their account (username + password) with
 * the same brand shell, strength meter, and requirements checklist as the rest of
 * the auth flow (web rule 218 — reuse `AuthShell`, don't hand-roll a brand mark).
 *
 * The accept endpoint mints no session, so we cannot auto-login. On success we
 * hand off to `/login` with the just-set username pre-filled and a one-shot
 * `welcome` flag, so the user lands on a sign-in form that already knows who they
 * are — never a dead-end "please sign in" screen with blank fields.
 *
 * The destination is a fixed relative path we build ourselves; we never forward a
 * client-controlled `next` from this page's URL, so there is no open-redirect
 * surface here.
 */
export function InviteAcceptPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  /** Terminal "this link is invalid or expired" state (no token, or server said so). */
  const [linkInvalid, setLinkInvalid] = useState(!token);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const usernameId = useId();
  const passwordId = useId();

  const score = useMemo(() => passwordScore(password), [password]);
  const requirements = useMemo(() => checkRequirements(password), [password]);
  const canSubmit =
    username.trim().length > 0 &&
    requirements.length &&
    requirements.numberOrSymbol &&
    !isSubmitting;

  /** Send the user to a sign-in form that already knows their username. */
  function goToLoginPrefilled(acceptedUsername: string) {
    const dest = `/login?welcome=1&u=${encodeURIComponent(acceptedUsername)}`;
    void navigate(dest, { replace: true });
  }

  /**
   * Handle the discriminated accept outcome. Shared by the new-account form submit
   * and the "I already have an account" token-only path so error placement is
   * consistent across both.
   */
  function applyOutcome(outcome: Awaited<ReturnType<typeof acceptInvite>>) {
    switch (outcome.kind) {
      case 'success':
        goToLoginPrefilled(outcome.username);
        return;
      case 'invalid_token':
        setLinkInvalid(true);
        return;
      case 'weak_password':
        setPasswordError(outcome.message);
        return;
      case 'username_taken':
        setUsernameError('That username is already taken. Try another.');
        return;
      case 'account_required':
        setFormError(
          'No TruePPM account exists for this invitation yet. Create one with the form above.',
        );
        return;
      case 'deactivated':
        setFormError(outcome.message);
        return;
      case 'rate_limited':
        setFormError('Too many attempts. Please wait a minute and try again.');
        return;
      default:
        setFormError('Something went wrong. Please try again.');
    }
  }

  function clearErrors() {
    setUsernameError(null);
    setPasswordError(null);
    setFormError(null);
  }

  async function handleCreateAccount(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    clearErrors();
    setIsSubmitting(true);
    const outcome = await acceptInvite({ token, username, password });
    applyOutcome(outcome);
    setIsSubmitting(false);
  }

  /** Existing-account path: link the account matched by the invite email (token only). */
  async function handleExistingAccount() {
    clearErrors();
    setIsSubmitting(true);
    const outcome = await acceptInvite({ token });
    applyOutcome(outcome);
    setIsSubmitting(false);
  }

  if (linkInvalid) {
    return (
      <AuthShell
        icon={<WarningIcon className="w-8 h-8 text-semantic-at-risk" />}
        title="This invitation link isn't valid"
        subtitle="The link may have expired or already been used. Ask your workspace admin to send a fresh invitation."
      />
    );
  }

  return (
    <AuthShell
      title="Accept your invitation"
      subtitle="Create your account to join the workspace."
      backToSignIn={false}
    >
      <form
        onSubmit={(e) => {
          void handleCreateAccount(e);
        }}
        noValidate
        className="flex flex-col gap-4"
      >
        {/* Username */}
        <div className="flex flex-col gap-1">
          <label htmlFor={usernameId} className="text-sm font-medium text-neutral-text-primary">
            Username
          </label>
          <input
            id={usernameId}
            type="text"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setUsernameError(null);
            }}
            disabled={isSubmitting}
            placeholder="anna_khoury"
            className="
              h-10 px-3 rounded border border-neutral-border
              bg-neutral-surface text-neutral-text-primary text-sm
              placeholder:text-neutral-text-secondary
              focus-visible:outline-none focus-visible:border-brand-primary
              focus-visible:ring-[3px] focus-visible:ring-brand-primary/20
              disabled:opacity-50 disabled:cursor-not-allowed
            "
          />
          {usernameError !== null && (
            <p role="alert" className="text-xs text-semantic-critical">
              {usernameError}
            </p>
          )}
        </div>

        {/* Password */}
        <div className="flex flex-col gap-1">
          <label htmlFor={passwordId} className="text-sm font-medium text-neutral-text-primary">
            Password
          </label>
          <div className="relative">
            <input
              id={passwordId}
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setPasswordError(null);
              }}
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

        {/* Requirements checklist */}
        <RequirementsChecklist
          length={requirements.length}
          numberOrSymbol={requirements.numberOrSymbol}
        />

        {passwordError !== null && (
          <p role="alert" className="text-sm text-semantic-critical">
            {passwordError}
          </p>
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
          {isSubmitting ? 'Creating your account…' : 'Create account & join'}
        </button>
      </form>

      {/* Secondary affordance: an already-registered user links their existing
          account by the invite email — no new username/password needed. Kept as a
          quiet secondary path so it never confuses the common new-account case. */}
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-xs text-neutral-text-secondary">Already have a TruePPM account?</p>
        <button
          type="button"
          onClick={() => void handleExistingAccount()}
          disabled={isSubmitting}
          className="text-sm font-medium text-brand-primary hover:text-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Accept with your existing account
        </button>
      </div>
    </AuthShell>
  );
}
