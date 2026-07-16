import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { OfflineBanner } from './OfflineBanner';

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
}

describe('OfflineBanner', () => {
  afterEach(() => {
    setOnline(true);
    vi.restoreAllMocks();
  });

  it('renders nothing when online', () => {
    setOnline(true);
    render(<OfflineBanner />);
    expect(screen.queryByRole('status')).toBeNull();
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

  it('appears on the offline event and clears on the online event', () => {
    setOnline(true);
    render(<OfflineBanner />);
    expect(screen.queryByRole('status')).toBeNull();

    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByRole('status')).toBeInTheDocument();

    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
