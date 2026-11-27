/**
 * Platform and display-mode detection for the installable PWA (ADR-1523 §3, §7).
 *
 * Every function takes its inputs explicitly (with browser defaults) so the rules
 * are unit-testable without stubbing globals, and each is SSR-safe.
 */

interface NavigatorLike {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  /** iOS Safari's non-standard flag: true when launched from the Home Screen. */
  standalone?: boolean;
}

function currentNavigator(): NavigatorLike | null {
  return typeof navigator === 'undefined' ? null : (navigator as NavigatorLike);
}

function matchesStandaloneMedia(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(display-mode: standalone)').matches;
}

/**
 * True when the app is running as an installed PWA (launched from the Home Screen
 * or an Android/desktop install), not in a browser tab.
 */
export function isStandalone(
  nav: NavigatorLike | null = currentNavigator(),
  standaloneMedia: boolean = matchesStandaloneMedia(),
): boolean {
  return standaloneMedia || nav?.standalone === true;
}

/**
 * iPhone, iPod, or iPad. iPadOS 13+ reports a desktop Mac user agent and platform
 * `MacIntel`, so an iPad is recognized by a Mac platform that has touch points.
 */
export function isIos(nav: NavigatorLike | null = currentNavigator()): boolean {
  if (!nav) return false;
  if (/iPhone|iPad|iPod/.test(nav.userAgent)) return true;
  return nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1;
}

/**
 * In-app browsers and non-Safari iOS browsers. Their share menus either lack Add to
 * Home Screen or install into a different browser, so the Safari instructions
 * would be wrong there (ADR-1523 §7).
 */
const NON_SAFARI_IOS =
  /CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|FBAN|FBAV|Instagram|Line\/|Twitter|LinkedInApp/;

/** iOS Safari specifically: the one mainstream browser with no install prompt. */
export function isIosSafari(nav: NavigatorLike | null = currentNavigator()): boolean {
  if (!nav || !isIos(nav)) return false;
  return /Safari\//.test(nav.userAgent) && !NON_SAFARI_IOS.test(nav.userAgent);
}
