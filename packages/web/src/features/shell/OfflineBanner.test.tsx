import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { OfflineBanner } from './OfflineBanner';

// Delegates to the real hook unless a test pins the value, so the existing
// navigator.onLine cases keep exercising it while the cases tagged "shared hook"
// prove the component reads connectivity through `useOnlineStatus` (#3863).
const onlineOverride = vi.hoisted(() => ({ value: null as boolean | null }));
vi.mock('@/hooks/useOnlineStatus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useOnlineStatus')>();
  return {
    useOnlineStatus: () => {
      const real = actual.useOnlineStatus();
      return onlineOverride.value ?? real;
    },
  };
});

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
}

describe('OfflineBanner', () => {
  afterEach(() => {
    setOnline(true);
    onlineOverride.value = null;
    vi.restoreAllMocks();
  });

  it('keeps the live region mounted but empty when online (#2203)', () => {
    // Persisted so going offline injects text into an existing live node — a
    // region mounted with its content is not reliably announced.
    setOnline(true);
    render(<OfflineBanner />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();
  });

  it('renders a polite status banner when offline', () => {
    setOnline(false);
    render(<OfflineBanner />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(banner).toHaveTextContent(/offline/i);
  });

  it('gives honest guidance: keep the tab open and name the scheduling exception (#2028)', () => {
    setOnline(false);
    render(<OfflineBanner />);
    const banner = screen.getByRole('status');
    // The old copy over-promised durability; the queue is memory-only.
    expect(banner).not.toHaveTextContent(/changes will be saved when you reconnect/i);
    expect(banner).toHaveTextContent(/keep this tab open/i);
    expect(banner).toHaveTextContent(/scheduling changes need a connection/i);
  });

  it('injects the message on the offline event and clears it on the online event', () => {
    setOnline(true);
    render(<OfflineBanner />);
    const region = screen.getByRole('status');
    expect(region).toBeEmptyDOMElement();

    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(region).toHaveTextContent(/offline/i);

    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(region).toBeEmptyDOMElement();
  });

  it('follows the shared useOnlineStatus hook, not navigator directly (shared hook)', () => {
    setOnline(true);
    onlineOverride.value = false;
    render(<OfflineBanner />);
    expect(screen.getByRole('status')).toHaveTextContent(/offline/i);
  });
});
