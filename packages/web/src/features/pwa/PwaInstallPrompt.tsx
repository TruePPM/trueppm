import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/Button';
import { LogoMark } from '@/components/Icons';
import { recordDismissal, shouldShowInstallNudge } from './installNudgePolicy';

/** iOS's Share glyph (a square with an arrow out of the top), as Safari draws it. */
function IosShareGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3v12M8 7l4-4 4 4" />
      <path d="M8 10H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-2" />
    </svg>
  );
}

/**
 * iOS Add-to-Home-Screen nudge (ADR-1523 §7, #1426).
 *
 * iOS Safari has no `beforeinstallprompt` and no install button, so installing is
 * an instruction, not a one-tap prompt: this card points at Safari's own Share
 * menu and never tries to render or script the native sheets. It shows only on iOS
 * Safari, outside the installed app, until dismissed (see installNudgePolicy).
 *
 * Non-modal on purpose: a `region` that takes no focus and blocks nothing, floated
 * above the page (fixed, so the shell layout is untouched) and kept above the
 * home indicator with the safe-area inset. Buttons are 44px tall (WCAG 2.5.8 and
 * Apple's touch-target guidance).
 */
export function PwaInstallPrompt({ eligible }: { eligible?: boolean }) {
  const [visible, setVisible] = useState(() => eligible ?? shouldShowInstallNudge());
  const [expanded, setExpanded] = useState(false);
  const titleId = useId();
  const stepsId = useId();
  const stepsRef = useRef<HTMLOListElement>(null);

  // "Show me how" unmounts itself, so move focus to the steps it revealed rather
  // than letting it fall to <body> (WCAG 2.4.3).
  useEffect(() => {
    if (expanded) stepsRef.current?.focus();
  }, [expanded]);

  if (!visible) return null;

  const dismiss = () => {
    recordDismissal();
    setVisible(false);
  };

  return (
    <section
      aria-labelledby={titleId}
      className="fixed inset-x-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[60] mx-auto max-w-md rounded-card border border-neutral-border bg-neutral-surface-raised p-4 text-neutral-text-primary shadow-pop"
      data-testid="pwa-install-prompt"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-navy-700 text-reversed">
          <LogoMark size={28} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 id={titleId} className="text-sm font-semibold">
            Install TruePPM
          </h2>
          <p className="mt-0.5 text-sm text-neutral-text-secondary">
            Add to your Home Screen for full-screen access. It opens without a signal and shows your
            last My Work list.
          </p>
          {!expanded && (
            <p className="mt-1 flex items-center gap-1 text-xs text-neutral-text-secondary">
              Tap <IosShareGlyph className="inline h-4 w-4" /> Share, then Add to Home Screen.
            </p>
          )}
        </div>
      </div>

      {expanded && (
        <ol
          id={stepsId}
          ref={stepsRef}
          tabIndex={-1}
          aria-label="How to install"
          className="mt-3 space-y-2 text-sm focus:outline-none"
        >
          <li className="flex items-start gap-2">
            <span className="font-mono text-neutral-text-secondary">1.</span>
            <span>
              Tap <IosShareGlyph className="inline h-4 w-4 align-[-0.2em]" /> <strong>Share</strong>{' '}
              in Safari&rsquo;s toolbar.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-mono text-neutral-text-secondary">2.</span>
            <span>
              Scroll down, tap <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.
            </span>
          </li>
          <li className="flex items-start gap-2 text-neutral-text-secondary">
            <span className="font-mono">3.</span>
            <span>
              Open TruePPM from your Home Screen. It runs full-screen and opens without a signal.
              Changes made offline are kept only while the app stays open.
            </span>
          </li>
        </ol>
      )}

      <div className="mt-3 flex justify-end gap-2">
        {/* min-h-[44px]: the shared Button tops out at 40px; 44px is the touch floor. */}
        <Button variant="ghost" size="lg" className="min-h-[44px]" onClick={dismiss}>
          {expanded ? 'Done' : 'Not now'}
        </Button>
        {!expanded && (
          <Button
            variant="primary"
            size="lg"
            className="min-h-[44px]"
            aria-expanded={expanded}
            aria-controls={stepsId}
            onClick={() => setExpanded(true)}
          >
            Show me how
          </Button>
        )}
      </div>
    </section>
  );
}
