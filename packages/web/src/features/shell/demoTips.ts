/**
 * The read-only demo's two-step landing hint (#4050 A1).
 *
 * Pure state + persistence for the hint the merged demo bar carries. Split out
 * of the component so the step machine and the storage contract can be tested
 * without a DOM, and so the `localStorage` key exists in exactly one place.
 *
 * **The key is `tppm.demo.tips` and it is deliberately NOT keyed by user.**
 * Every other client preference in this app is `…<userId>.<projectId>` because
 * every other deployment has real, separate users. The interactive demo
 * publishes ONE shared login (ADR-1197 D5), so a per-user key would be a single
 * global key wearing a disguise — and would then read as "this person dismissed
 * the tips" when what happened is that somebody else, on another continent,
 * did. Per browser is the honest scope: it is the only thing about a demo
 * visitor that is actually theirs.
 */

export const DEMO_TIPS_KEY = 'tppm.demo.tips';

/** Which step the hint is showing, or that it has been dismissed. */
export type DemoTipsState = 'step1' | 'step2' | 'dismissed';

/**
 * The stored values we accept back.
 *
 * `done` is stored once the visitor has completed step 2 — distinct from
 * `dismissed` (they closed it) so that "Tips" can restore a dismissed hint to
 * step 1 without also un-completing a walkthrough somebody finished.
 */
type StoredTips = 'step1' | 'step2' | 'dismissed' | 'done';

function isStored(value: unknown): value is StoredTips {
  return value === 'step1' || value === 'step2' || value === 'dismissed' || value === 'done';
}

/** Read the persisted hint state. Absent, unreadable or junk → `'step1'`. */
export function readDemoTips(): StoredTips {
  try {
    const raw = window.localStorage.getItem(DEMO_TIPS_KEY);
    return isStored(raw) ? raw : 'step1';
  } catch {
    // Private mode, blocked site data, or a storage quota refusal. A first-time
    // hint is the right answer for a browser that cannot remember anything.
    return 'step1';
  }
}

/** Persist the hint state. A storage refusal is silent — memory still wins. */
export function writeDemoTips(value: StoredTips): void {
  try {
    window.localStorage.setItem(DEMO_TIPS_KEY, value);
  } catch {
    // Ignored on purpose: the hint is a convenience, not a record.
  }
}

/**
 * What the bar renders for a stored value.
 *
 * `done` renders as `dismissed` — the visitor has finished, so the steps stop
 * asking, and the "Tips" affordance is still there if they want them back.
 */
export function visibleState(stored: StoredTips): DemoTipsState {
  return stored === 'done' ? 'dismissed' : stored;
}

/** Copy for each step. Step 1 names the task the overlay leaves behind plan. */
export function stepOneText(taskName: string | null): string {
  const target = taskName ?? 'a task';
  return `Switch to Author and drag ${target} 2 days right: watch the finish date move.`;
}

export const STEP_TWO_TEXT = 'Open Forecast to see the P80 finish and how it was computed.';
