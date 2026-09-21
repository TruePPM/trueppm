import { useDemoMode } from '@/hooks/useDemoMode';

/**
 * Persistent read-only-demo indicator in the shell's banner slot (ADR-1197 D3, #3926).
 *
 * The login screen announces the mode once; this is what keeps it true for the rest of
 * the session, so a refusal twenty minutes later lands on someone who already knows
 * why. Brand/info tone, not a warning: nothing is wrong.
 *
 * **No `aria-live`, no `role="status"`.** The bar never changes during a session, so a
 * live region here would announce nothing of its own and would compete with the
 * Schedule's assertive region — which is where the actual refusal is announced.
 * `<aside aria-label>` gives it findability instead.
 */
export function DemoModeBar() {
  // Read whole rather than destructured, deliberately. This bar is a **withdrawal**
  // (rule 379): "still loading", "the read failed" and "not a demo" all resolve to the
  // same correct render — nothing — and `useDemoMode` already folds the error branch
  // into that answer. So there is no failure state for rule 246's `QueryErrorState` to
  // occupy, and a red retry offered to report that we could not confirm the ABSENCE of
  // a demo would be worse than silence. Rendering nothing while unsettled is also what
  // stops a normal install flashing a banner it takes straight back.
  const demo = useDemoMode();
  if (demo.isLoading || !demo.isDemoReadOnly) return null;

  return (
    <aside
      aria-label="Demo mode"
      className="flex items-center justify-center gap-2 border-b border-brand-primary/30 bg-brand-primary/10 text-brand-primary px-4 py-1.5 text-xs font-medium"
    >
      <span aria-hidden="true">◆</span>
      {/* One text node, and the pitch half is hidden below `md` VISUALLY only —
          `sr-only`, never `hidden`. `display:none` would take it out of the
          accessibility tree too, so a screen-reader user on a phone would hear a
          shorter sentence than a sighted one (web rule 429). */}
      <span>
        Read-only demo — nothing you change here is saved.
        <span className="sr-only md:not-sr-only md:inline">
          {' '}
          Drag a task on the Schedule to watch the critical path recompute.
        </span>
      </span>
    </aside>
  );
}
