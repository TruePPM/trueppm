/**
 * First-login "primary use" prompt (ADR-0129).
 *
 * An inline presentational card at the top of My Work — NOT a modal (it is page
 * content: no focus trap, no auto-focus). Contributor-first: it mounts only on
 * My Work; PMs discover the same control in Settings. It shows once, gated on
 * `me.default_landing === 'auto'` AND an unset `localStorage` flag, and lets the
 * user pin a home screen or defer.
 *
 * Saving PATCHes the preference (applies to *future* logins — we do NOT navigate)
 * and animates the card out (motion-safe only). Skip / ✕ just set the seen flag.
 *
 * Accessibility (items 1–4 of the ux-review):
 *   - All four options (three concrete + Auto) are one `role="radiogroup"` via
 *     `LandingChoiceRadioGroup`'s `autoOption` prop — AT can arrow between all.
 *   - The hairline divider before Auto is `aria-hidden` (presentational only).
 *   - Roving tabindex: arrow keys move focus, commit is click/Enter/Space only.
 *   - Dismiss (✕) button is `min-h-[44px] min-w-[44px]` (rule 5 / WCAG 2.5.5).
 *   - Animate-out: `motion-safe:opacity-0` is applied when `saved === true` so
 *     the CSS transition fires before the 900ms unmount.
 */
import { useRef, useState, type ReactNode } from 'react';
import { useCurrentUser, type DefaultLanding } from '@/hooks/useCurrentUser';
import { useUpdateDefaultLanding } from '@/hooks/useDefaultLanding';
import { Button } from '@/components/Button';
import { CloseIcon } from '@/components/Icons';
import { LANDING_CHOICES, LANDING_PROMPT_SEEN_KEY, humanizeIntent } from '@/features/me/landing';
import {
  LandingChoiceRadioGroup,
  type AutoOptionProps,
} from '@/features/me/LandingChoiceRadioGroup';

/** True only when the prompt has never been seen AND no preference is set yet. */
export function shouldShowLandingPrompt(defaultLanding: DefaultLanding | undefined): boolean {
  if (defaultLanding !== 'auto') return false;
  try {
    return localStorage.getItem(LANDING_PROMPT_SEEN_KEY) == null;
  } catch {
    // localStorage can throw in private mode / sandboxed iframes — fail closed
    // (don't nag) rather than crash the page.
    return false;
  }
}

function markPromptSeen() {
  try {
    localStorage.setItem(LANDING_PROMPT_SEEN_KEY, '1');
  } catch {
    /* private mode — the prompt re-appears next visit, which is acceptable */
  }
}

// The three concrete choices appear above the hairline; Auto is set apart below.
const CONCRETE_CHOICES = LANDING_CHOICES.filter((c) => c.value !== 'auto');

export function LandingPrimaryUsePrompt() {
  const { user } = useCurrentUser();
  const updateLanding = useUpdateDefaultLanding();
  // My Work is the contributor-first default selection.
  const [choice, setChoice] = useState<DefaultLanding>('my_work');
  const [dismissed, setDismissed] = useState(false);
  const [saved, setSaved] = useState(false);
  // Latch the show decision the first time conditions hold. Saving sets the
  // `seen` flag, which would otherwise make `shouldShowLandingPrompt` flip to
  // false and unmount the card before the "Saved" line / animate-out is
  // observed — so once eligible, stay mounted until skipped/dismissed.
  const eligibleRef = useRef(false);
  if (!eligibleRef.current && user && shouldShowLandingPrompt(user.default_landing)) {
    eligibleRef.current = true;
  }

  if (!user || !eligibleRef.current) return null;
  if (dismissed) return null;

  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const isPendingOrSaved = updateLanding.isPending || saved;

  function handleSkip() {
    markPromptSeen();
    setDismissed(true);
  }

  function handleSave() {
    updateLanding.mutate(choice, {
      onSuccess: () => {
        markPromptSeen();
        setSaved(true);
        // Animate out: opacity-0 is set immediately via `saved` state driving the
        // className, then the card unmounts after the transition completes.
        // motion-reduce: transition class is absent so the card simply unmounts.
        window.setTimeout(() => setDismissed(true), 900);
      },
    });
  }

  // The Auto card helper text includes a live echo of the role-resolved intent.
  const autoHelperText: ReactNode = (
    <>
      Picks the best screen based on your role
      {user.landing && <> — currently opens {humanizeIntent(user.landing.intent)}</>}.
    </>
  );

  const autoOptionProps: AutoOptionProps = {
    checked: choice === 'auto',
    helperText: autoHelperText,
    onClick: () => setChoice('auto'),
    // Disabled state uses the full rule-122 recipe (item 4).
    disabled: isPendingOrSaved,
  };

  return (
    <section
      aria-label="Choose your home screen"
      className={`relative mx-4 mt-4 mb-2 rounded-card border border-brand-primary/40 bg-brand-primary/5 p-4 md:mx-6
        motion-safe:transition-opacity motion-safe:duration-300
        ${saved ? 'motion-safe:opacity-0' : ''}`}
    >
      {/* ✕ = Skip — 44px touch target (item 3, rule 5 / WCAG 2.5.5) */}
      <button
        type="button"
        onClick={handleSkip}
        aria-label="Skip — decide later"
        className="absolute right-2 top-2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-control
          text-neutral-text-secondary hover:text-neutral-text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        <CloseIcon className="h-4 w-4" />
      </button>

      <div className="pr-10">
        <h2 className="text-base font-semibold text-neutral-text-primary">
          Where do you want TruePPM to open?
        </h2>
        <p className="mt-1 text-sm text-neutral-text-secondary">
          Pick the screen you want to land on each time you sign in. You can change this anytime in
          Settings.
        </p>
      </div>

      <div className="mt-4">
        {/* Single radiogroup containing all four options (items 1+2).
            Concrete choices render above the hairline; Auto is the autoOption
            rendered below it — but both inside one role="radiogroup". */}
        <LandingChoiceRadioGroup
          label="Where TruePPM opens"
          options={CONCRETE_CHOICES}
          value={choice}
          onChange={setChoice}
          disabled={isPendingOrSaved}
          autoOption={autoOptionProps}
        />
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Button
          variant="primary"
          size="md"
          onClick={handleSave}
          disabled={updateLanding.isPending || saved || offline}
          title={offline ? "You're offline — reconnect to set your home screen" : undefined}
        >
          {updateLanding.isPending ? 'Saving…' : 'Set as my home'}
        </Button>
        <Button variant="ghost" size="md" onClick={handleSkip}>
          Skip
        </Button>
      </div>

      <p aria-live="polite" role="status" className="mt-2 min-h-[1rem] text-xs">
        {saved ? (
          <span className="text-neutral-text-secondary">Saved.</span>
        ) : updateLanding.isError ? (
          <span className="text-semantic-critical">Couldn&rsquo;t save preference. Try again.</span>
        ) : null}
      </p>
    </section>
  );
}
