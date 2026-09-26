import { useId } from 'react';
import { useDemoAccessGate, type DemoLoginHint as DemoLoginHintValue } from '@/hooks/useEdition';

interface Props {
  hint: DemoLoginHintValue;
  /** Sign in with the hint values (ADR-1197 Amendment 2026-09-26, #4153). */
  onExplore: () => void;
  /** True while any sign-in is in flight — mirrors the form's own controls. */
  disabled: boolean;
  /** True while THIS control's sign-in is the one in flight. */
  isSigningIn: boolean;
}

/**
 * The read-only demo's one-click entry, inside the sign-in form (ADR-1197 D3, amended
 * 2026-09-26 by #4153).
 *
 * "Explore the demo" signs the visitor in with the published credential in one click.
 * It replaced a "Fill in demo login" control that deliberately stopped short of
 * submitting, so a visitor who pressed a button to *look* was never signed in
 * unawares. That consent argument binds the button's **label**, not the click count:
 * the copy directly above the button says, before the click, that it signs in to one
 * shared read-only account — so pressing it is the decision to proceed. The button is
 * `aria-describedby` that copy so a screen-reader user hears the same disclosure with
 * the name.
 *
 * The credential stays printed (`select-all` on each value) for anyone who prefers the
 * form or an API client: one click is the fast path, not the only one.
 *
 * Rendered at **every** width, unlike the marketing-panel note beside it (`hidden
 * md:flex`): the panel is an announcement a phone can do without, this is the one
 * thing a visitor on a phone cannot proceed without.
 */
export function DemoLoginHint({ hint, onExplore, disabled, isSigningIn }: Props) {
  const disclosureId = useId();
  // Null on every normal install and on a demo with no gate declared, which is what
  // keeps this disclosure conditional rather than a blanket claim (#3969).
  const accessGate = useDemoAccessGate();

  return (
    <div className="rounded-card border border-neutral-border bg-neutral-surface-raised p-3 flex flex-col gap-2">
      <p id={disclosureId} className="text-xs font-medium text-neutral-text-primary">
        Read-only demo — one click signs you in to the shared account below. Everyone uses the same
        account, and nothing you change is saved.
      </p>
      <button
        type="button"
        onClick={onExplore}
        disabled={disabled}
        aria-describedby={disclosureId}
        // The page's primary action in demo mode (the bare origin lands here), so it
        // takes the primary recipe and the password form's Sign in drops to secondary
        // — one primary button per screen. Rule 4's `focus:` ring, not
        // `focus-visible:`: Firefox and desktop Safari do not match `:focus-visible` on
        // a pointer-initiated button focus.
        className="
          h-11 w-full rounded bg-brand-primary text-neutral-text-inverse
          text-sm font-semibold
          hover:bg-brand-primary-dark
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
          disabled:opacity-50 disabled:cursor-not-allowed
          transition-colors
        "
      >
        {isSigningIn ? 'Opening the demo…' : 'Explore the demo'}
      </button>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-neutral-text-secondary">Email</dt>
        <dd className="tppm-mono text-neutral-text-primary select-all">{hint.username}</dd>
        <dt className="text-neutral-text-secondary">Password</dt>
        <dd className="tppm-mono text-neutral-text-primary select-all">{hint.password}</dd>
      </dl>
      {accessGate && (
        // The email-capture disclosure (ADR-1197 D8 resolution, #3969).
        //
        // Deliberately POST-HOC, and it says so: the gate intercepts in front of the
        // app, so by the time any TruePPM code runs the visitor has already handed
        // over an address. This confirms what happened and names who holds it; the
        // notice that arrives *before* the prompt lives on the page that links here
        // (getting-started/try-it). Shipping only this half would not meet the
        // "before the email-capture step" bar and must not be described as if it did.
        //
        // Rendered only when the deployment declared a gate — `provider` is the
        // operator's own text, never a hardcoded vendor, so a demo behind Authelia
        // does not publish a notice naming Cloudflare.
        <p
          data-testid="demo-access-gate-notice"
          className="text-xs text-neutral-text-secondary border-t border-neutral-border pt-2"
        >
          <strong className="font-medium text-neutral-text-primary">{accessGate.provider}</strong>{' '}
          gates this demo host and collected your email address before you reached this page.
          TruePPM does not store it, and a TruePPM instance you host yourself has no such check
          unless you add one.
          {accessGate.privacy_url && (
            <>
              {' '}
              <a
                href={accessGate.privacy_url}
                target="_blank"
                rel="noreferrer noopener"
                className="underline hover:text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 rounded"
              >
                What {accessGate.provider} collects
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}
