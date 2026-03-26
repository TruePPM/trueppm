import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import axios from 'axios';
import { useAuthStore } from '@/stores/authStore';

interface TokenResponse {
  access: string;
  refresh: string;
}

export function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const setTokens = useAuthStore((s) => s.setTokens);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await axios.post<TokenResponse>('/api/v1/auth/token/', {
        username,
        password,
      });
      setTokens(response.data.access, response.data.refresh);
      const next = searchParams.get('next') ?? '/';
      void navigate(next, { replace: true });
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        setError('Invalid username or password.');
      } else {
        setError('An unexpected error occurred. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-neutral-surface-raised flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo / wordmark */}
        <div className="mb-8 text-center">
          <span className="text-2xl font-semibold text-neutral-text-primary tracking-tight">
            TruePPM
          </span>
          <p className="mt-1 text-sm text-neutral-text-secondary">Sign in to your workspace</p>
        </div>

        {/* Card — border instead of shadow per rule 1 */}
        <div className="bg-neutral-surface border border-neutral-border rounded-lg p-6">
          <form onSubmit={(e) => { void handleSubmit(e); }} noValidate>
            <div className="space-y-4">
              {/* Username */}
              <div>
                <label
                  htmlFor="username"
                  className="block text-sm font-medium text-neutral-text-primary mb-1"
                >
                  Username
                </label>
                <input
                  id="username"
                  type="text"
                  autoComplete="username"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={isSubmitting}
                  className="
                    w-full h-11 px-3 rounded border border-neutral-border
                    bg-neutral-surface text-neutral-text-primary text-sm
                    placeholder:text-neutral-text-disabled
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                    disabled:opacity-50 disabled:cursor-not-allowed
                  "
                  placeholder="Enter your username"
                />
              </div>

              {/* Password */}
              <div>
                <label
                  htmlFor="password"
                  className="block text-sm font-medium text-neutral-text-primary mb-1"
                >
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={isSubmitting}
                  className="
                    w-full h-11 px-3 rounded border border-neutral-border
                    bg-neutral-surface text-neutral-text-primary text-sm
                    placeholder:text-neutral-text-disabled
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                    disabled:opacity-50 disabled:cursor-not-allowed
                  "
                  placeholder="Enter your password"
                />
              </div>

              {/* Inline error message */}
              {error !== null && (
                <p
                  role="alert"
                  className="text-sm text-semantic-critical"
                >
                  {error}
                </p>
              )}

              {/* Submit */}
              <button
                type="submit"
                disabled={isSubmitting || username.trim() === '' || password === ''}
                className="
                  w-full h-11 rounded bg-brand-primary text-neutral-text-inverse
                  text-sm font-medium
                  hover:bg-brand-primary-dark
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                  disabled:opacity-50 disabled:cursor-not-allowed
                  transition-colors
                "
              >
                {isSubmitting ? 'Signing in…' : 'Sign in'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
