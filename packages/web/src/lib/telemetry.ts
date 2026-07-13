/**
 * Opt-in, self-hosted-friendly frontend telemetry (issue #1901).
 *
 * The web app's error boundaries render a fallback and `console.error` only —
 * nothing reaches the operator. This module gives a self-hoster a single,
 * deliberate egress for two client-side signals:
 *   1. uncaught render errors (via the existing error boundaries), and
 *   2. Core Web Vitals (CLS / LCP / INP / FCP / TTFB).
 *
 * Design constraints (mirrors the API-side OTLP export — opt-in, no default
 * endpoint, no third-party SaaS):
 *   - **Off by default.** Until an endpoint is configured this module is a
 *     strict no-op: no observers registered, no network, no cost.
 *   - **No third-party SaaS, no CDN.** Reports are POSTed as a small JSON
 *     envelope to an operator-configured OTLP/HTTP-style collector URL, via
 *     `navigator.sendBeacon` (with a `fetch(keepalive)` fallback).
 *   - **No PII.** The payload carries only the error message + stack + route,
 *     web-vital name/value, app version, and the URL *pathname* (never the query
 *     string, which can hold ids/tokens). No credentials are ever attached.
 *   - **Zero new dependencies.** Web Vitals are collected from the native
 *     `PerformanceObserver` / navigation-timing APIs rather than pulling a
 *     package into the bundle.
 *
 * The endpoint is read from runtime config (`window.__TRUEPPM_CONFIG__`, which a
 * deploy can inject into `index.html` without a rebuild) or, as a build-time
 * fallback, the `VITE_TELEMETRY_ENDPOINT` env var. Runtime config wins.
 */

interface TruePPMRuntimeConfig {
  /**
   * Collector URL for client telemetry. When unset (the default), every export
   * in this module is a no-op. An OTLP/HTTP collector or any endpoint that
   * accepts a JSON POST works.
   */
  telemetryEndpoint?: string;
}

declare global {
  interface Window {
    __TRUEPPM_CONFIG__?: TruePPMRuntimeConfig;
  }
}

/** Defensive cap on the reported stack so a pathological trace can't bloat a beacon. */
const MAX_STACK_CHARS = 4096;

/** Context attached to an error report by whichever boundary caught it. */
export interface ErrorReportContext {
  /** Which boundary caught the error (e.g. `'route'`, `'section:Overview'`). */
  boundary?: string;
  /** The route/path the user was on, if the boundary knows it. */
  route?: string;
}

interface TelemetryEnvelope {
  type: 'error' | 'web-vital';
  /** ISO-8601 client timestamp. */
  timestamp: string;
  appVersion: string;
  buildSha: string;
  /** URL pathname only — deliberately excludes the query string to avoid PII. */
  path: string;
  // error-only fields
  name?: string;
  message?: string;
  stack?: string;
  boundary?: string;
  route?: string;
  // web-vital-only fields
  metric?: string;
  value?: number;
}

/**
 * Resolve the configured collector URL, or `null` when telemetry is disabled.
 *
 * Resolved on every call (not cached at module load) so a runtime config
 * injected after this module is imported — and so tests — take effect. Runtime
 * `window.__TRUEPPM_CONFIG__.telemetryEndpoint` wins over the build-time
 * `VITE_TELEMETRY_ENDPOINT`, letting an operator configure a deployed bundle
 * without rebuilding.
 */
export function getTelemetryEndpoint(): string | null {
  const runtime = typeof window !== 'undefined' ? window.__TRUEPPM_CONFIG__?.telemetryEndpoint : undefined;
  // `import.meta.env`'s index signature is `any`; narrow to `unknown` first.
  const build: unknown = import.meta.env.VITE_TELEMETRY_ENDPOINT;
  const raw = typeof runtime === 'string' && runtime.trim() ? runtime : typeof build === 'string' ? build : '';
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** True when an endpoint is configured. Exposed for callers that want to skip setup work. */
export function isTelemetryEnabled(): boolean {
  return getTelemetryEndpoint() !== null;
}

function baseEnvelope(type: TelemetryEnvelope['type']): TelemetryEnvelope {
  return {
    type,
    timestamp: new Date().toISOString(),
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
    buildSha: typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'unknown',
    path: typeof window !== 'undefined' ? window.location.pathname : '',
  };
}

/**
 * Best-effort POST of a telemetry envelope. No-op when no endpoint is configured.
 *
 * Prefers `sendBeacon` (survives page unload, which is when web-vitals flush);
 * falls back to `fetch(keepalive)` when the beacon queue is full or the API is
 * unavailable. Every failure is swallowed — telemetry must never throw into the
 * app or surface to the user, and never carries credentials.
 */
function send(payload: TelemetryEnvelope): void {
  const endpoint = getTelemetryEndpoint();
  if (!endpoint) return;

  const body = JSON.stringify(payload);
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(endpoint, blob)) return;
      // sendBeacon returns false when the user-agent queue is full — fall through.
    }
    if (typeof fetch === 'function') {
      void fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
        // Telemetry must never carry the session cookie / JWT.
        credentials: 'omit',
        mode: 'cors',
      }).catch(() => {
        /* best-effort: a failed report must never surface to the user */
      });
    }
  } catch {
    /* CSP block, disabled API, etc. — telemetry is never allowed to throw */
  }
}

/**
 * Report an uncaught error to the configured collector. No-op when telemetry is
 * off. Called from the app's error boundaries alongside their `console.error`.
 *
 * @param error - The thrown value (Error or otherwise).
 * @param context - Which boundary caught it and the route, if known.
 */
export function reportError(error: unknown, context: ErrorReportContext = {}): void {
  if (!getTelemetryEndpoint()) return;

  const err = error instanceof Error ? error : undefined;
  const message = err ? err.message : typeof error === 'string' ? error : String(error);

  send({
    ...baseEnvelope('error'),
    name: err?.name ?? 'Error',
    message,
    stack: err?.stack ? err.stack.slice(0, MAX_STACK_CHARS) : undefined,
    boundary: context.boundary,
    route: context.route,
  });
}

function reportWebVital(metric: string, value: number): void {
  send({ ...baseEnvelope('web-vital'), metric, value });
}

// --- Web Vitals collection (native PerformanceObserver, zero dependencies) ---

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

interface EventTimingEntry extends PerformanceEntry {
  interactionId?: number;
}

let webVitalsStarted = false;

/** `durationThreshold` (event-timing) is standard but not yet in the DOM lib types. */
type ObserveInit = PerformanceObserverInit & { durationThreshold?: number };

function observe(type: string, callback: (entries: PerformanceEntry[]) => void, extra: ObserveInit = {}): void {
  try {
    const observer = new PerformanceObserver((list) => callback(list.getEntries()));
    observer.observe({ type, buffered: true, ...extra });
  } catch {
    // An unsupported entry type throws on `.observe`; skip that metric silently.
  }
}

/**
 * Initialize Core Web Vitals reporting once. No-op when telemetry is off or the
 * `PerformanceObserver` API is unavailable (older browsers, jsdom).
 *
 * TTFB and FCP are point-in-time and reported as soon as they are observed.
 * LCP, CLS, and INP evolve over the page's lifetime, so they are accumulated and
 * flushed once when the page is hidden/unloaded — the moment the values are
 * final and a `sendBeacon` still succeeds.
 *
 * INP here is the maximum interaction latency (a standard, lightweight
 * approximation of the p98 the full web-vitals library computes) — adequate for
 * an operator's single-egress client signal without pulling in a dependency.
 */
export function initWebVitals(): void {
  if (webVitalsStarted) return;
  if (!getTelemetryEndpoint()) return;
  if (typeof PerformanceObserver === 'undefined') return;
  webVitalsStarted = true;

  // TTFB from the navigation entry.
  try {
    const [nav] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    if (nav && nav.responseStart > 0) reportWebVital('TTFB', nav.responseStart);
  } catch {
    /* navigation timing unavailable */
  }

  // FCP — first-contentful-paint from the paint timeline.
  observe('paint', (entries) => {
    for (const entry of entries) {
      if (entry.name === 'first-contentful-paint') reportWebVital('FCP', entry.startTime);
    }
  });

  // LCP — keep the latest candidate; flush the final value on page hide.
  let lcp = 0;
  observe('largest-contentful-paint', (entries) => {
    const last = entries[entries.length - 1];
    if (last) lcp = last.startTime;
  });

  // CLS — cumulative sum of layout shifts not tied to a recent interaction.
  let cls = 0;
  observe('layout-shift', (entries) => {
    for (const entry of entries as LayoutShiftEntry[]) {
      if (!entry.hadRecentInput) cls += entry.value;
    }
  });

  // INP — track the worst interaction latency; flush on page hide.
  let inp = 0;
  observe('event', (entries) => {
    for (const entry of entries as EventTimingEntry[]) {
      if (entry.interactionId && entry.duration > inp) inp = entry.duration;
    }
  }, { durationThreshold: 40 });

  let flushed = false;
  const flush = (): void => {
    if (flushed) return;
    flushed = true;
    if (lcp > 0) reportWebVital('LCP', lcp);
    if (cls > 0) reportWebVital('CLS', cls);
    if (inp > 0) reportWebVital('INP', inp);
  };

  // `visibilitychange → hidden` is the reliable end-of-session signal on both
  // desktop and mobile (`pagehide`/`beforeunload` don't fire consistently on
  // mobile). Flush there; keep `pagehide` as a belt-and-braces fallback.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flush);
  }
}

/** Reset internal state — test-only. */
export function __resetTelemetryForTests(): void {
  webVitalsStarted = false;
}
