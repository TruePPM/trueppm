import { useId, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import axios from 'axios';

interface AcceptResponse {
  detail: string;
  username: string;
}

/**
 * Public invite-accept page — no authentication required.
 *
 * Reads the `?token=` query param from the URL, allows a new user to set a
 * username + password, and POSTs to POST /workspace/invites/accept/. On
 * success the user is prompted to sign in.
 */
export function InviteAcceptPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const usernameId = useId();
  const passwordId = useId();

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token) {
      setError('No invite token found in the URL.');
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      const body: Record<string, string> = { token };
      if (username.trim()) body.username = username.trim();
      if (password) body.password = password;

      const res = await axios.post<AcceptResponse>('/api/v1/workspace/invites/accept/', body);
      setSuccess(`Welcome, ${res.data.username}! Your account is ready — please sign in.`);
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.data) {
        const data = err.response.data as Record<string, unknown>;
        const msg = (data.detail as string) ?? Object.values(data).flat().join(' ');
        setError(msg || 'Failed to accept the invite. The token may be expired or already used.');
      } else {
        setError('An unexpected error occurred. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-surface px-4">
      <div className="w-full max-w-sm flex flex-col gap-6">
        {/* Brand */}
        <div className="flex items-center gap-2">
          <div
            className="w-9 h-9 rounded-card bg-brand-primary text-white flex items-center justify-center text-sm font-bold shrink-0"
            aria-hidden="true"
          >
            tP
          </div>
          <span className="text-lg font-bold text-neutral-text-primary tracking-tight">
            TruePPM
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <h1 className="text-[26px] font-semibold text-neutral-text-primary tracking-tight leading-tight">
            Accept workspace invite
          </h1>
          <p className="text-sm text-neutral-text-secondary leading-relaxed">
            {token
              ? 'Set a username and password to create your account, or leave them blank if your account already exists.'
              : 'No invite token found. Please use the link from your invitation email.'}
          </p>
        </div>

        {success !== null ? (
          <div
            role="status"
            className="rounded-card border border-semantic-on-track bg-semantic-on-track-bg p-4 text-sm text-neutral-text-primary"
          >
            {success}
            <div className="mt-3">
              <a
                href="/login"
                className="font-semibold text-brand-primary hover:text-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded-control"
              >
                Sign in →
              </a>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              void handleSubmit(e);
            }}
            noValidate
            className="flex flex-col gap-4"
          >
            {/* Username — optional for existing accounts */}
            <div className="flex flex-col gap-1">
              <label htmlFor={usernameId} className="text-sm font-medium text-neutral-text-primary">
                Username{' '}
                <span className="text-neutral-text-secondary font-normal text-xs">
                  (new accounts only)
                </span>
              </label>
              <input
                id={usernameId}
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={isSubmitting || !token}
                placeholder="anna_khoury"
                className="
                  h-10 px-3 rounded-control border border-neutral-border
                  bg-neutral-surface text-neutral-text-primary text-sm
                  placeholder:text-neutral-text-disabled
                  focus-visible:outline-none focus-visible:border-brand-primary
                  focus-visible:ring-2 focus-visible:ring-brand-primary
                  disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed disabled:cursor-not-allowed
                "
              />
            </div>

            {/* Password — optional for existing accounts */}
            <div className="flex flex-col gap-1">
              <label htmlFor={passwordId} className="text-sm font-medium text-neutral-text-primary">
                Password{' '}
                <span className="text-neutral-text-secondary font-normal text-xs">
                  (new accounts only)
                </span>
              </label>
              <input
                id={passwordId}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isSubmitting || !token}
                className="
                  h-10 px-3 rounded-control border border-neutral-border
                  bg-neutral-surface text-neutral-text-primary text-sm font-mono
                  focus-visible:outline-none focus-visible:border-brand-primary
                  focus-visible:ring-2 focus-visible:ring-brand-primary
                  disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed disabled:cursor-not-allowed
                "
              />
            </div>

            {error !== null && (
              <p role="alert" className="text-sm text-semantic-critical">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={isSubmitting || !token}
              className="
                h-11 w-full rounded-control bg-brand-primary text-white
                text-sm font-semibold
                hover:bg-brand-primary-dark
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed disabled:cursor-not-allowed
                transition-colors
              "
            >
              {isSubmitting ? 'Accepting invite…' : 'Accept invite'}
            </button>

            <p className="text-xs text-neutral-text-disabled text-center">
              Already have an account?{' '}
              <a
                href="/login"
                className="font-medium text-brand-primary hover:text-brand-primary-dark"
              >
                Sign in
              </a>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
