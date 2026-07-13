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
    vi.restoreAllMocks();
  });

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
});
