import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  __resetTelemetryForTests,
  getTelemetryEndpoint,
  initWebVitals,
  isTelemetryEnabled,
  reportError,
} from './telemetry';

const ENDPOINT = 'https://collector.example.test/v1/client';

function enableTelemetry(url = ENDPOINT): void {
  window.__TRUEPPM_CONFIG__ = { telemetryEndpoint: url };
}

function disableTelemetry(): void {
  delete window.__TRUEPPM_CONFIG__;
}

/** Parse the JSON body handed to a mocked sendBeacon Blob. */
async function readBeaconBody(blob: unknown): Promise<Record<string, unknown>> {
  const text = await (blob as Blob).text();
  return JSON.parse(text) as Record<string, unknown>;
}

type BeaconFn = (url: string, data?: BodyInit | null) => boolean;
type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

describe('telemetry', () => {
  let beacon: Mock<BeaconFn>;
  let fetchMock: Mock<FetchFn>;

  beforeEach(() => {
    __resetTelemetryForTests();
    disableTelemetry();

    beacon = vi.fn<BeaconFn>(() => true);
    Object.defineProperty(navigator, 'sendBeacon', {
      value: beacon,
      configurable: true,
      writable: true,
    });

    fetchMock = vi.fn<FetchFn>(() => Promise.resolve(new Response(null, { status: 202 })));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    disableTelemetry();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** Decode every beacon body sent so far into parsed envelopes. */
  async function beaconPayloads(): Promise<Array<Record<string, unknown>>> {
    return Promise.all(beacon.mock.calls.map(([, blob]) => readBeaconBody(blob)));
  }

  describe('getTelemetryEndpoint / isTelemetryEnabled', () => {
    it('returns null and disabled when nothing is configured', () => {
      expect(getTelemetryEndpoint()).toBeNull();
      expect(isTelemetryEnabled()).toBe(false);
    });

    it('reads the runtime window config and trims it', () => {
      enableTelemetry(`  ${ENDPOINT}  `);
      expect(getTelemetryEndpoint()).toBe(ENDPOINT);
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('treats a whitespace-only endpoint as unconfigured', () => {
      enableTelemetry('   ');
      expect(getTelemetryEndpoint()).toBeNull();
    });
  });

  describe('reportError', () => {
    it('is a no-op when no endpoint is configured', () => {
      reportError(new Error('boom'), { boundary: 'route' });
      expect(beacon).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('POSTs the expected error shape via sendBeacon when enabled', async () => {
      enableTelemetry();
      reportError(new Error('kaboom'), { boundary: 'route', route: '/projects/x' });

      expect(beacon).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();

      const [url, blob] = beacon.mock.calls[0];
      expect(url).toBe(ENDPOINT);
      const payload = await readBeaconBody(blob);
      expect(payload).toMatchObject({
        type: 'error',
        name: 'Error',
        message: 'kaboom',
        boundary: 'route',
        route: '/projects/x',
      });
      expect(typeof payload.stack).toBe('string');
      expect(typeof payload.timestamp).toBe('string');
      // Never the query string — only the pathname.
      expect(payload.path).not.toContain('?');
    });

    it('coerces a non-Error thrown value', async () => {
      enableTelemetry();
      reportError('a plain string', {});
      const [, blob] = beacon.mock.calls[0];
      const payload = await readBeaconBody(blob);
      expect(payload).toMatchObject({ type: 'error', message: 'a plain string' });
    });

    it('falls back to fetch(keepalive) without credentials when sendBeacon is unavailable', () => {
      enableTelemetry();
      Object.defineProperty(navigator, 'sendBeacon', {
        value: undefined,
        configurable: true,
        writable: true,
      });

      reportError(new Error('no beacon'));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(ENDPOINT);
      expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit' });
    });

    it('falls back to fetch when sendBeacon returns false (queue full)', () => {
      enableTelemetry();
      beacon.mockReturnValue(false);
      reportError(new Error('queue full'));
      expect(beacon).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('initWebVitals', () => {
    // A class stands in for PerformanceObserver: `new` requires a constructable
    // mock, and the telemetry module swallows a throwing `new`, so an arrow-fn
    // mock would silently register nothing.
    const observeSpy = vi.fn();
    let constructed = 0;
    class ObserverMock {
      constructor(_cb: PerformanceObserverCallback) {
        constructed += 1;
      }
      observe = observeSpy;
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
    }

    beforeEach(() => {
      observeSpy.mockClear();
      constructed = 0;
    });

    it('is a no-op when no endpoint is configured (registers no observers)', () => {
      vi.stubGlobal('PerformanceObserver', ObserverMock);

      initWebVitals();

      expect(constructed).toBe(0);
      expect(observeSpy).not.toHaveBeenCalled();
      expect(beacon).not.toHaveBeenCalled();
    });

    it('is a no-op when PerformanceObserver is unavailable even if enabled', () => {
      enableTelemetry();
      vi.stubGlobal('PerformanceObserver', undefined);
      // Should not throw.
      expect(() => initWebVitals()).not.toThrow();
      expect(beacon).not.toHaveBeenCalled();
    });

    it('registers observers and reports TTFB when enabled', () => {
      enableTelemetry();
      vi.stubGlobal('PerformanceObserver', ObserverMock);
      vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
        { entryType: 'navigation', responseStart: 123 } as unknown as PerformanceEntry,
      ]);

      initWebVitals();

      // paint, largest-contentful-paint, layout-shift, event = 4 observers.
      expect(observeSpy).toHaveBeenCalled();
      // TTFB fired synchronously from the navigation entry.
      expect(beacon).toHaveBeenCalledTimes(1);
    });

    it('runs its setup only once', () => {
      enableTelemetry();
      vi.stubGlobal('PerformanceObserver', ObserverMock);
      vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);

      initWebVitals();
      const firstConstructed = constructed;
      initWebVitals();
      expect(constructed).toBe(firstConstructed);
    });
  });

  // The observer callbacks and the page-hide flush hold the bulk of the vitals
  // logic. A capturing observer records each callback by entry type so a test can
  // feed it synthetic PerformanceEntries and assert the resulting beacons.
  describe('initWebVitals — vital callbacks and flush', () => {
    const callbacks: Record<string, (entries: PerformanceEntry[]) => void> = {};

    class CapturingObserver {
      private readonly cb: PerformanceObserverCallback;
      constructor(cb: PerformanceObserverCallback) {
        this.cb = cb;
      }
      observe(init: PerformanceObserverInit & { type?: string }): void {
        const type = init.type ?? '';
        callbacks[type] = (entries) =>
          this.cb(
            { getEntries: () => entries } as unknown as PerformanceObserverEntryList,
            this as unknown as PerformanceObserver,
          );
      }
      disconnect(): void {}
      takeRecords(): PerformanceEntry[] {
        return [];
      }
    }

    function setVisibility(state: DocumentVisibilityState): void {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    }

    beforeEach(() => {
      for (const key of Object.keys(callbacks)) delete callbacks[key];
      enableTelemetry();
      vi.stubGlobal('PerformanceObserver', CapturingObserver);
      // Default: no navigation entry so no TTFB beacon muddies the vital assertions.
      vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);
    });

    afterEach(() => {
      // initWebVitals attaches anonymous visibilitychange/pagehide listeners that
      // outlive the test. Force any closure still holding unflushed vitals to flush
      // now (marking its `flushed` guard) so it can't fire — and beacon — during a
      // later test's dispatch. Beacons emitted here hit the outgoing test's mock.
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
      setVisibility('visible');
    });

    it('reports FCP only for the first-contentful-paint paint entry', async () => {
      initWebVitals();
      callbacks.paint([
        { name: 'first-paint', startTime: 10 } as PerformanceEntry,
        { name: 'first-contentful-paint', startTime: 42 } as PerformanceEntry,
      ]);

      const payloads = await beaconPayloads();
      const fcp = payloads.filter((p) => p.metric === 'FCP');
      expect(fcp).toHaveLength(1);
      expect(fcp[0]).toMatchObject({ type: 'web-vital', metric: 'FCP', value: 42 });
      // first-paint must not produce a beacon.
      expect(payloads.some((p) => p.value === 10)).toBe(false);
    });

    it('accumulates LCP/CLS/INP and flushes them once on visibility hidden', async () => {
      initWebVitals();

      // LCP keeps the latest candidate.
      callbacks['largest-contentful-paint']([
        { startTime: 100 } as PerformanceEntry,
        { startTime: 250 } as PerformanceEntry,
      ]);
      // CLS sums only shifts NOT tied to a recent interaction.
      callbacks['layout-shift']([
        { value: 0.1, hadRecentInput: false } as unknown as PerformanceEntry,
        { value: 0.05, hadRecentInput: true } as unknown as PerformanceEntry,
      ]);
      // INP tracks the worst interaction latency; the no-interactionId entry is ignored.
      callbacks.event([
        { interactionId: 1, duration: 80 } as unknown as PerformanceEntry,
        { interactionId: 2, duration: 40 } as unknown as PerformanceEntry,
        { duration: 500 } as unknown as PerformanceEntry,
      ]);

      // Nothing flushed yet — these evolve until page-hide.
      expect((await beaconPayloads()).some((p) => p.metric === 'LCP')).toBe(false);

      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));

      const payloads = await beaconPayloads();
      expect(payloads.find((p) => p.metric === 'LCP')).toMatchObject({ value: 250 });
      expect(payloads.find((p) => p.metric === 'CLS')).toMatchObject({ value: 0.1 });
      expect(payloads.find((p) => p.metric === 'INP')).toMatchObject({ value: 80 });
    });

    it('flushes at most once even across a second hide/pagehide', () => {
      initWebVitals();
      callbacks['largest-contentful-paint']([{ startTime: 120 } as PerformanceEntry]);

      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      const afterFirst = beacon.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0);

      // A second hide and a pagehide must not re-flush (the `flushed` guard).
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
      expect(beacon.mock.calls.length).toBe(afterFirst);
    });

    it('does not flush while the page is still visible', async () => {
      initWebVitals();
      callbacks['largest-contentful-paint']([{ startTime: 300 } as PerformanceEntry]);

      // visibilitychange fires but state is 'visible' → the hidden-guard skips flush.
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));

      expect((await beaconPayloads()).some((p) => p.metric === 'LCP')).toBe(false);
    });

    it('emits no LCP/CLS/INP beacons when the vitals never moved off zero', () => {
      initWebVitals();
      // No callbacks invoked → lcp/cls/inp stay 0 → flush is a no-op.
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(beacon).not.toHaveBeenCalled();
    });

    it('skips TTFB when the navigation entry has responseStart 0', async () => {
      vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
        { entryType: 'navigation', responseStart: 0 } as unknown as PerformanceEntry,
      ]);
      initWebVitals();
      expect((await beaconPayloads()).some((p) => p.metric === 'TTFB')).toBe(false);
    });
  });

  describe('send edge cases', () => {
    it('swallows a throwing sendBeacon and does not fall through to fetch', () => {
      enableTelemetry();
      beacon.mockImplementation(() => {
        throw new Error('blocked by CSP');
      });
      expect(() => reportError(new Error('x'))).not.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is an inert no-op when neither sendBeacon nor fetch is available', () => {
      enableTelemetry();
      Object.defineProperty(navigator, 'sendBeacon', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      vi.stubGlobal('fetch', undefined);
      expect(() => reportError(new Error('x'))).not.toThrow();
    });

    it('omits the stack field when the Error carries no stack', async () => {
      enableTelemetry();
      const err = new Error('stackless');
      Object.defineProperty(err, 'stack', { value: undefined, configurable: true });
      reportError(err);
      const [payload] = await beaconPayloads();
      expect(payload).toMatchObject({ type: 'error', name: 'Error', message: 'stackless' });
      expect(payload.stack).toBeUndefined();
    });
  });

  describe('build-time endpoint fallback', () => {
    it('falls back to VITE_TELEMETRY_ENDPOINT when no runtime config is set', () => {
      disableTelemetry();
      vi.stubEnv('VITE_TELEMETRY_ENDPOINT', ENDPOINT);
      expect(getTelemetryEndpoint()).toBe(ENDPOINT);
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('lets the runtime window config win over the build-time env', () => {
      vi.stubEnv('VITE_TELEMETRY_ENDPOINT', 'https://build.example.test/otlp');
      enableTelemetry('https://runtime.example.test/otlp');
      expect(getTelemetryEndpoint()).toBe('https://runtime.example.test/otlp');
    });
  });
});
