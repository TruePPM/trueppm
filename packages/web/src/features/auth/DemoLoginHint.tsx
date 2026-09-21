import { useState } from 'react';
import type { DemoLoginHint as DemoLoginHintValue } from '@/hooks/useEdition';

interface Props {
  hint: DemoLoginHintValue;
  /** Fill the sign-in form with the hint values. Must NOT submit it. */
  onFill: () => void;
  /** Mirrors the form's own controls so nothing stays live mid-submit. */
  disabled: boolean;
}

/**
 * The read-only demo's shared credential, inside the sign-in form (ADR-1197 D3).
 *
 * Rendered at **every** width, unlike the marketing-panel note beside it (`hidden
 * md:flex`): the panel is an announcement a phone can do without, the credential is
 * the one thing a visitor on a phone cannot proceed without.
 *
 * `select-all` on each value so one click takes the whole token — a copy button would
 * be a second affordance for what the Fill control already does in one step.
 *
 * The live region is mounted permanently and empty (`empty:hidden`) rather than
 * conditionally rendered: a region that appears *with* its text is announced
 * inconsistently, so the text is injected into a node already in the tree.
 */
export function DemoLoginHint({ hint, onFill, disabled }: Props) {
  const [filledNotice, setFilledNotice] = useState('');

  function handleFill() {
    onFill();
    setFilledNotice('Demo credentials filled in. Select Sign in to continue.');
  }

  return (
    <div className="rounded-card border border-neutral-border bg-neutral-surface-raised p-3 flex flex-col gap-2">
      <p className="text-xs font-medium text-neutral-text-primary">
        Read-only demo — sign in with the shared account below. Nothing you change is saved.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-neutral-text-secondary">Email</dt>
        <dd className="tppm-mono text-neutral-text-primary select-all">{hint.username}</dd>
        <dt className="text-neutral-text-secondary">Password</dt>
        <dd className="tppm-mono text-neutral-text-primary select-all">{hint.password}</dd>
      </dl>
      <button
        type="button"
        onClick={handleFill}
        disabled={disabled}
        aria-label="Fill in the demo email and password"
        className="
          h-11 w-full rounded border border-neutral-border
          bg-neutral-surface-raised text-neutral-text-primary
          text-sm font-medium
          hover:bg-neutral-surface-sunken
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
          disabled:opacity-50 disabled:cursor-not-allowed
          transition-colors
        "
      >
        Fill in demo login
      </button>
      <p
        role="status"
        aria-live="polite"
        className="text-xs text-neutral-text-secondary empty:hidden"
      >
        {filledNotice}
      </p>
    </div>
  );
}
