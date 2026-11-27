/**
 * When the iOS Add-to-Home-Screen nudge may show (ADR-1523 §7, #1426).
 *
 * Not nagware: the first "Not now" hides it for {@link SNOOZE_MS}; the second hides
 * it for good. State lives in localStorage and every access is wrapped, so a
 * private window or blocked site data just behaves like a first visit.
 */
import { isIosSafari, isStandalone } from '@/lib/pwa/displayMode';

export const INSTALL_NUDGE_STORAGE_KEY = 'trueppm.pwa.installNudge';
/** How long one "Not now" hides the nudge. */
export const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
/** After this many dismissals the nudge never shows again on this browser. */
export const MAX_DISMISSALS = 2;

export interface InstallNudgeState {
  dismissCount: number;
  lastDismissedAt: number | null;
}

const EMPTY: InstallNudgeState = { dismissCount: 0, lastDismissedAt: null };

export function readNudgeState(): InstallNudgeState {
  try {
    const raw = localStorage.getItem(INSTALL_NUDGE_STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<InstallNudgeState>;
    return {
      dismissCount: typeof parsed.dismissCount === 'number' ? parsed.dismissCount : 0,
      lastDismissedAt: typeof parsed.lastDismissedAt === 'number' ? parsed.lastDismissedAt : null,
    };
  } catch {
    return EMPTY;
  }
}

/** Record one dismissal. Returns the new state (also when storage is unavailable). */
export function recordDismissal(now: number = Date.now()): InstallNudgeState {
  const prev = readNudgeState();
  const next = { dismissCount: prev.dismissCount + 1, lastDismissedAt: now };
  try {
    localStorage.setItem(INSTALL_NUDGE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the nudge hides for this page load only.
  }
  return next;
}

/** The dismissal rule alone: hidden for good after two, snoozed for 30 days after one. */
export function isDismissed(state: InstallNudgeState, now: number = Date.now()): boolean {
  if (state.dismissCount >= MAX_DISMISSALS) return true;
  if (state.dismissCount > 0 && state.lastDismissedAt !== null) {
    return now - state.lastDismissedAt < SNOOZE_MS;
  }
  return false;
}

/**
 * Whole eligibility: iOS Safari, not already installed, not dismissed. Platform
 * facts are injectable for tests.
 */
export function shouldShowInstallNudge({
  iosSafari = isIosSafari(),
  standalone = isStandalone(),
  state = readNudgeState(),
  now = Date.now(),
}: {
  iosSafari?: boolean;
  standalone?: boolean;
  state?: InstallNudgeState;
  now?: number;
} = {}): boolean {
  return iosSafari && !standalone && !isDismissed(state, now);
}
