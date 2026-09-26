import { useDemoMode } from '@/hooks/useDemoMode';
import { parseDemoResetLine } from './demoResetSchedule';
import { DemoForecastChip } from './DemoForecastChip';
import { DemoProjectSwitcher } from './DemoProjectSwitcher';
import { DemoTipsHint } from './DemoTipsHint';

/**
 * The read-only demo's single 44px chrome bar (ADR-1197 D3, #3926, #4050 A1).
 *
 * **What this replaces.** Five stacked strips used to sit between the top bar
 * and the Gantt on the hosted demo: this banner (two lines), the sample-project
 * strip, the "How this works" coach bar, the "Worth a look" NextStrip, and the
 * docked forecast bar. Each is right in a working session. Together, on a first
 * visit, they left the schedule about a third of the viewport and made a
 * healthy plan look like a product mid-collapse (#4050, #3887). They are now
 * one bar: mode, edition, project, and what to do first — which is the whole
 * set of questions a first-time visitor actually has.
 *
 * **Height is fixed and load-bearing.** 44px at every state, on purpose: the ×
 * that dismisses the hint must not move the Gantt under the pointer, and the
 * hint's step 1 → step 2 transition must not reflow the canvas mid-drag. The
 * hint is therefore `truncate`d rather than wrapped, and below `lg` it collapses
 * into a Tips popover instead of taking a second line.
 *
 * **No `aria-live`, no `role="status"`.** The bar's standing text never changes
 * during a session, so a live region here would announce nothing of its own and
 * would compete with the Schedule's assertive region — which is where an actual
 * refusal is announced. The hint inside it is `role="note"` and never takes
 * focus (#4050 A1). `<aside aria-label>` gives the whole thing findability.
 *
 * **Edition disclosure (#3968) survives the merge.** The demo is otherwise
 * silent about being the OSS community edition, which leaves a portfolio-scale
 * evaluator with no signal that the cross-program views they cannot find are a
 * separate tier rather than a product gap. What is *removed* is the sentence
 * naming those Enterprise features: on a landing screen it reads as a pitch,
 * and CLAUDE.md is explicit that the OSS UI does not upsell before adoption.
 * The link stays, because "what is in this edition" is a question, not a sell.
 */
export function DemoModeBar() {
  // Read whole rather than destructured, deliberately. This bar is a
  // **withdrawal** (rule 379): "still loading", "the read failed" and "not a
  // demo" all resolve to the same correct render — nothing — and `useDemoMode`
  // already folds the error branch into that answer. Rendering nothing while
  // unsettled is also what stops a normal install flashing a banner it takes
  // straight back.
  const demo = useDemoMode();
  if (demo.isLoading || !demo.isDemoReadOnly) return null;

  // #4152: null whenever the reset is disabled or the server predates the field —
  // rendering nothing is correct in both cases, never a guessed cadence.
  const resetLine = parseDemoResetLine(demo.resetSchedule);

  return (
    <aside
      aria-label="Demo mode"
      data-testid="demo-mode-bar"
      // h-11 = 44px desktop, h-12 = 48px on a phone (design section 7 — the bar
      // carries two items there and its controls are 44px touch targets).
      // `flex-nowrap` + `min-w-0` children is what makes the hint truncate
      // instead of wrapping the bar onto a second line.
      className="flex h-12 lg:h-11 flex-shrink-0 flex-nowrap items-center gap-3 overflow-hidden
        border-b border-brand-primary/30 bg-brand-primary/10 px-3 text-xs
        text-brand-primary sm:px-4"
    >
      {/* The mode, stated first and never abbreviated. `title` carries the
          consequence — the sentence the two-line banner used to spend a whole
          line on — so it is one hover/focus away rather than permanently
          occupying 44px of the schedule. */}
      <span
        className="flex-shrink-0 rounded-chip border border-brand-primary/40 px-2 py-0.5
          font-semibold uppercase tracking-wide"
        title="Read-only demo — nothing you change here is saved, and the data resets regularly."
      >
        Read-only demo
      </span>

      {/* Edition disclosure (#3968). Hidden below `sm` VISUALLY only — `sr-only`,
          never `hidden`: `display:none` takes it out of the accessibility tree
          too, so a screen-reader user on a phone would hear less than a sighted
          one (web rule 429). */}
      <span className="sr-only flex-shrink-0 whitespace-nowrap sm:not-sr-only sm:inline">
        Community edition{' '}
        <a
          href="https://docs.trueppm.com/overview/#open-core-model"
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold underline underline-offset-2 hover:no-underline rounded
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1"
        >
          What&apos;s included
        </a>
      </span>

      <DemoProjectSwitcher />

      {/* The forecast bar's headline, relocated (#4050 A1). Hidden below `md`,
          where the phone keeps `MobileMonteCarloCard` as its forecast surface. */}
      <span className="hidden md:contents">
        <DemoForecastChip />
      </span>

      {/* The reset cadence (#4152) — one line inside the existing row, never a
          second strip. `sr-only` below `lg` rather than `hidden`, for the same
          reason the edition disclosure is: `display:none` removes it from the
          accessibility tree too, and a screen-reader visitor on a narrow viewport
          is owed the same fact a sighted desktop visitor gets for free. Null
          (reset disabled, or a pre-0.5 server) renders nothing — never a guess. */}
      {resetLine && (
        <span className="sr-only truncate whitespace-nowrap lg:not-sr-only lg:inline">
          {resetLine}
        </span>
      )}

      <DemoTipsHint />
    </aside>
  );
}
