import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disableServiceWorker,
  honorKillSwitch,
  registerServiceWorker,
  resetServiceWorkerStateForTests,
  SERVICE_WORKER_URL,
  UPDATE_CHECK_INTERVAL_MS,
} from './registerServiceWorker';

function stubContainer() {
  const update = vi.fn().mockResolvedValue(undefined);
  const unregister = vi.fn().mockResolvedValue(true);
  const registration = { update, unregister };
  const container = {
    register: vi.fn().mockResolvedValue(registration),
    getRegistrations: vi.fn().mockResolvedValue([registration]),
  };
  Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true });
  return { container, update, unregister };
}

function stubCaches() {
  const store = {
    keys: vi.fn().mockResolvedValue(['workbox-precache-v2', 'other']),
    delete: vi.fn().mockResolvedValue(true),
  };
  vi.stubGlobal('caches', store);
  return store;
}

beforeEach(() => {
  resetServiceWorkerStateForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('registerServiceWorker', () => {
  it('is a no-op where the browser has no service-worker support', async () => {
    await expect(registerServiceWorker({ isDev: false })).resolves.toBeNull();
  });

  it('never registers in the dev server', async () => {
    const { container } = stubContainer();
    await expect(registerServiceWorker({ isDev: true })).resolves.toBeNull();
    expect(container.register).not.toHaveBeenCalled();
  });

  it('registers /sw.js at scope / and checks for updates hourly and on foreground', async () => {
    vi.useFakeTimers();
    const { container, update } = stubContainer();
    const reg = await registerServiceWorker({ isDev: false });
    expect(reg).not.toBeNull();
    expect(container.register).toHaveBeenCalledWith(SERVICE_WORKER_URL, { scope: '/' });

    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
    expect(update).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('swallows a registration failure (the app works as before the PWA existed)', async () => {
    const { container } = stubContainer();
    container.register.mockRejectedValueOnce(new TypeError('bad MIME type'));
    await expect(registerServiceWorker({ isDev: false })).resolves.toBeNull();
  });
});

describe('kill switch', () => {
  it('unregisters every worker and deletes every cache', async () => {
    const { unregister } = stubContainer();
    const store = stubCaches();
    await disableServiceWorker();
    expect(unregister).toHaveBeenCalled();
    expect(store.delete).toHaveBeenCalledWith('workbox-precache-v2');
    expect(store.delete).toHaveBeenCalledWith('other');
  });

  it('fires on the header, case-insensitively, from a Headers bag', async () => {
    const { unregister } = stubContainer();
    stubCaches();
    honorKillSwitch(new Headers({ 'X-TruePPM-Service-Worker': 'Disable' }));
    await vi.waitFor(() => expect(unregister).toHaveBeenCalled());
  });

  it('fires from a plain lower-cased header record and then blocks re-registration', async () => {
    const { container, unregister } = stubContainer();
    stubCaches();
    honorKillSwitch({ 'x-trueppm-service-worker': 'disable' });
    await vi.waitFor(() => expect(unregister).toHaveBeenCalled());
    await expect(registerServiceWorker({ isDev: false })).resolves.toBeNull();
    expect(container.register).not.toHaveBeenCalled();
  });

  it('ignores a response without the header or with another value', () => {
    const { unregister } = stubContainer();
    honorKillSwitch({ 'content-type': 'application/json' });
    honorKillSwitch({ 'x-trueppm-service-worker': 'enable' });
    honorKillSwitch(undefined);
    expect(unregister).not.toHaveBeenCalled();
  });
});
