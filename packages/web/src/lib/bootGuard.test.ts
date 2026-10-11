import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// public/boot-guard.js is a classic script served outside the bundle (#4408);
// importing it here runs its IIFE, which installs window.__trueppmBootGuard.
interface BootGuardTestApi {
  booted: () => void;
  _handleFailure: (el: Element | null) => 'ignored' | 'reloading' | 'notice';
  _setDeps: (deps: Record<string, unknown>) => void;
  _reset: () => void;
  STORAGE_KEY: string;
  RELOAD_DELAYS_MS: number[];
  RESET_AFTER_MS: number;
}

let guard: BootGuardTestApi;

beforeAll(async () => {
  // @ts-expect-error -- plain JS file with no type declarations
  await import('../../public/boot-guard.js');
  guard = (window as unknown as { __trueppmBootGuard: BootGuardTestApi }).__trueppmBootGuard;
});

function script(src: string): HTMLScriptElement {
  const el = document.createElement('script');
  el.type = 'module';
  el.src = src;
  return el;
}

function link(rel: string, href: string): HTMLLinkElement {
  const el = document.createElement('link');
  el.rel = rel;
  el.href = href;
  return el;
}

describe('boot-guard', () => {
  let now: number;
  let online: boolean;
  const reload = vi.fn();
  const schedule = vi.fn();

  beforeEach(() => {
    now = 1_000_000;
    online = true;
    reload.mockReset();
    schedule.mockReset();
    sessionStorage.clear();
    document.body.innerHTML = '<div id="root"></div>';
    guard._reset();
    guard._setDeps({ now: () => now, isOnline: () => online, reload, schedule });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('schedules a reload with the first backoff when the entry script fails', () => {
    expect(guard._handleFailure(script('/assets/index-abc.js'))).toBe('reloading');
    expect(schedule).toHaveBeenCalledWith(reload, guard.RELOAD_DELAYS_MS[0]);
    expect(JSON.parse(sessionStorage.getItem(guard.STORAGE_KEY) ?? '{}')).toEqual({ n: 1, t: now });
  });

  it('covers eager modulepreload chunks and the entry stylesheet', () => {
    expect(guard._handleFailure(link('modulepreload', '/assets/chunk-x.js'))).toBe('reloading');
    guard._reset();
    expect(guard._handleFailure(link('stylesheet', '/assets/index-y.css'))).toBe('reloading');
  });

  it('ignores failures that are not same-origin /assets/ boot assets', () => {
    expect(guard._handleFailure(script('/theme-init.js'))).toBe('ignored');
    expect(guard._handleFailure(script('https://elsewhere.example/assets/x.js'))).toBe('ignored');
    expect(guard._handleFailure(link('preload', '/fonts/inter-latin.woff2'))).toBe('ignored');
    expect(guard._handleFailure(document.createElement('img'))).toBe('ignored');
    expect(guard._handleFailure(null)).toBe('ignored');
    expect(schedule).not.toHaveBeenCalled();
  });

  it('acts once per page load even when several boot assets fail', () => {
    expect(guard._handleFailure(script('/assets/index-abc.js'))).toBe('reloading');
    expect(guard._handleFailure(link('modulepreload', '/assets/chunk-x.js'))).toBe('ignored');
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('backs off across reloads, then shows the notice instead of looping', () => {
    guard.RELOAD_DELAYS_MS.forEach((delay, i) => {
      guard._reset(); // a reload is a fresh page load
      expect(guard._handleFailure(script('/assets/index-abc.js'))).toBe('reloading');
      expect(schedule).toHaveBeenLastCalledWith(reload, delay);
      const stored = JSON.parse(sessionStorage.getItem(guard.STORAGE_KEY) ?? '{}') as { n: number };
      expect(stored.n).toBe(i + 1);
    });
    guard._reset();
    expect(guard._handleFailure(script('/assets/index-abc.js'))).toBe('notice');
    expect(schedule).toHaveBeenCalledTimes(guard.RELOAD_DELAYS_MS.length);
    expect(document.getElementById('trueppm-boot-notice')).not.toBeNull();
  });

  it('refills the budget once the reset window has passed', () => {
    sessionStorage.setItem(
      guard.STORAGE_KEY,
      JSON.stringify({ n: guard.RELOAD_DELAYS_MS.length, t: now - guard.RESET_AFTER_MS - 1 }),
    );
    expect(guard._handleFailure(script('/assets/index-abc.js'))).toBe('reloading');
    expect(schedule).toHaveBeenCalledWith(reload, guard.RELOAD_DELAYS_MS[0]);
  });

  it('shows the notice instead of reloading while offline', () => {
    online = false;
    expect(guard._handleFailure(script('/assets/index-abc.js'))).toBe('notice');
    expect(schedule).not.toHaveBeenCalled();
  });

  it('shows the notice when storage throws, since no reload budget can be kept', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(guard._handleFailure(script('/assets/index-abc.js'))).toBe('notice');
    expect(schedule).not.toHaveBeenCalled();
  });

  it('shows the notice when the budget cannot be written', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(guard._handleFailure(script('/assets/index-abc.js'))).toBe('notice');
    expect(schedule).not.toHaveBeenCalled();
  });

  it('stands down after boot and refunds the reload budget', () => {
    sessionStorage.setItem(guard.STORAGE_KEY, JSON.stringify({ n: 2, t: now }));
    guard.booted();
    expect(sessionStorage.getItem(guard.STORAGE_KEY)).toBeNull();
    // A lazy route's modulepreload after boot is chunkReload.ts's job.
    expect(guard._handleFailure(link('modulepreload', '/assets/route-z.js'))).toBe('ignored');
    expect(schedule).not.toHaveBeenCalled();
  });

  it('renders an accessible notice whose Reload button clears the budget', () => {
    online = false;
    sessionStorage.setItem(guard.STORAGE_KEY, JSON.stringify({ n: 1, t: now }));
    guard._handleFailure(script('/assets/index-abc.js'));
    const notice = document.getElementById('trueppm-boot-notice');
    expect(notice?.getAttribute('role')).toBe('alert');
    expect(notice?.textContent).toContain('TruePPM is being updated');
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy },
    });
    notice?.querySelector('button')?.click();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(guard.STORAGE_KEY)).toBeNull();
  });

  it('is wired to capture-phase resource errors on window', () => {
    const el = script('/assets/index-abc.js');
    document.body.appendChild(el);
    el.dispatchEvent(new Event('error'));
    expect(schedule).toHaveBeenCalledWith(reload, guard.RELOAD_DELAYS_MS[0]);
  });
});
