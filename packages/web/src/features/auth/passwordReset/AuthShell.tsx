import { type ReactNode } from 'react';
import { Link } from 'react-router';
import { LogoMark } from '@/components/Icons';

/**
 * Shared centered-card layout for the five password-reset screens (issue 765).
 *
 * Provides the brand mark, an optional 3-step progress-dots indicator (Screens
 * 1–3), a title + subtitle, the screen body, and an optional "Back to sign in"
 * footer link. Mobile-first: a single full-height column that centers a max-width
 * card, so it reads well from a phone frame up to desktop. All colors use the
 * theme-aware neutral tokens, so light and dark are handled by the design system.
 */
export function AuthShell({
  step,
  icon,
  title,
  subtitle,
  children,
  backToSignIn = true,
}: {
  /** 1-based step for the progress dots (Screens 1–3). Omit to hide the dots. */
  step?: 1 | 2 | 3;
  /** Optional status icon rendered above the title (mail, check, warning). */
  icon?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  children?: ReactNode;
  /** Render the "Back to sign in" footer link (default true). */
  backToSignIn?: boolean;
}) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-neutral-surface px-6 py-12">
      <div className="w-full max-w-sm flex flex-col gap-8">
        {/* Brand mark */}
        <div className="flex items-center gap-2.5 self-center" aria-label="TruePPM">
          <LogoMark size={32} className="flex-shrink-0" />
          <span className="font-display text-xl font-bold tracking-[-0.02em] leading-none">
            <span className="text-navy-700 dark:text-reversed">True</span>
            <span className="text-sage-500">PPM</span>
          </span>
        </div>

        {step !== undefined && <ProgressDots step={step} />}

        <div className="flex flex-col gap-6">
          <div className="flex flex-col items-center gap-3 text-center">
            {icon}
            <div className="flex flex-col gap-1.5">
              <h1 className="text-2xl font-semibold text-neutral-text-primary tracking-tight">
                {title}
              </h1>
              {subtitle && (
                <p className="text-sm text-neutral-text-secondary leading-relaxed">{subtitle}</p>
              )}
            </div>
          </div>

          {children}
        </div>

        {backToSignIn && (
          <Link
            to="/login"
            className="self-center text-sm font-medium text-brand-primary hover:text-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
          >
            Back to sign in
          </Link>
        )}
      </div>
    </div>
  );
}

/** Three progress dots with the current step filled (Screens 1–3). */
function ProgressDots({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div
      className="flex items-center justify-center gap-2"
      role="img"
      aria-label={`Step ${step} of 3`}
    >
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          aria-hidden="true"
          className={`h-1.5 rounded-full transition-all ${
            n === step ? 'w-6 bg-brand-primary' : 'w-1.5 bg-neutral-border'
          }`}
        />
      ))}
    </div>
  );
}
