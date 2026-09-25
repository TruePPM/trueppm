import { useDemoTipsStore } from '@/stores/demoTipsStore';
import { STEP_TWO_TEXT, stepOneText } from './demoTips';

/**
 * The demo bar's two-step landing hint (#4050 A1, A6).
 *
 * **Why step 1 has a button and not just a sentence.** The design drew "Drag
 * ‹task› 2 days right". It cannot work from the landing state: A6 lands the
 * demo in Read, where `readOnly` is true and drag is disabled, so a visitor who
 * follows that instruction gets nothing and concludes the product is broken —
 * which is the exact impression this whole issue exists to remove. So step 1
 * names the mode change and offers to make it: "Try it" enters Author for the
 * session and takes them to the bar it is talking about. The drag they then
 * perform is the real one, and it advances the hint.
 *
 * **`role="note"`, and it never takes focus.** It is a caption on the screen
 * behind it, not a dialog and not an alert: nothing here interrupts, nothing
 * steals the caret from the outline, and a keyboard user reaches the two
 * controls in normal tab order. It is also not a live region — the step
 * transition is a consequence of something the user just did, and announcing it
 * would talk over the Schedule's own assertive announcement of the same drag.
 *
 * **The bar's height never changes.** Dismissed, the hint leaves a "Tips"
 * button of the same height in the same place. That is not tidiness: the
 * control sits directly above a Gantt canvas whose rows are 32px, and a bar
 * that shrank on × would slide the whole chart up under the pointer.
 */
export function DemoTipsHint() {
  const state = useDemoTipsStore((s) => s.state);
  const target = useDemoTipsStore((s) => s.target);
  const requestAuthor = useDemoTipsStore((s) => s.requestAuthor);
  const dismiss = useDemoTipsStore((s) => s.dismiss);
  const restore = useDemoTipsStore((s) => s.restore);

  if (state === 'dismissed') {
    return (
      <button
        type="button"
        onClick={restore}
        data-testid="demo-tips-restore"
        className="ml-auto flex-shrink-0 rounded-control px-2 py-1 font-semibold underline
          underline-offset-2 hover:no-underline focus-visible:outline-none
          focus-visible:ring-2 focus-visible:ring-brand-primary"
      >
        Tips
      </button>
    );
  }

  const isStepOne = state === 'step1';
  const text = isStepOne ? stepOneText(target?.name ?? null) : STEP_TWO_TEXT;

  return (
    <div
      role="note"
      aria-label="Demo tips"
      data-testid="demo-tips"
      data-step={isStepOne ? '1' : '2'}
      className="ml-auto flex min-w-0 flex-shrink items-center gap-2"
    >
      <span aria-hidden="true" className="flex-shrink-0 font-semibold tabular-nums">
        {isStepOne ? '1/2' : '2/2'}
      </span>
      {/* `truncate` rather than wrap — below ~1180px the sentence loses its tail
          to an ellipsis and the bar keeps its 44px.
          Below `lg` it is `sr-only`, NOT `hidden`: the bar has no room for the
          sentence there, but `display:none` would take it out of the
          accessibility tree too and leave a `role="note"` whose only remaining
          content is an `aria-hidden` step counter and two buttons — a note that
          names nothing (web rule 429). So a narrow sighted viewport loses the
          text and a screen reader never does. */}
      <span className="sr-only min-w-0 lg:not-sr-only lg:block lg:truncate">{text}</span>
      {isStepOne ? (
        <button
          type="button"
          onClick={requestAuthor}
          data-testid="demo-tips-try"
          className="flex h-11 flex-shrink-0 items-center rounded-control border
            border-brand-primary/40 px-3 font-semibold lg:h-7
            hover:bg-brand-primary/10 focus-visible:outline-none focus-visible:ring-2
            focus-visible:ring-brand-primary"
        >
          Try it
        </button>
      ) : null}
      <button
        type="button"
        onClick={dismiss}
        data-testid="demo-tips-dismiss"
        // A real accessible name, not the glyph: "×" is announced as
        // "multiplication sign" or skipped entirely depending on the AT.
        aria-label="Dismiss demo tips"
        className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-control
          text-base leading-none lg:h-7 lg:w-7 hover:bg-brand-primary/10
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
