import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { OfflineRouteGate, isOfflineCapableRoute } from './OfflineMiss';

const online = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useOnlineStatus', () => ({ useOnlineStatus: () => online.value }));

function renderAt(path: string, bootedOffline: boolean) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <OfflineRouteGate bootedOffline={bootedOffline}>
        <p>route content</p>
      </OfflineRouteGate>
    </MemoryRouter>,
  );
}

afterEach(() => {
  online.value = false;
});

describe('isOfflineCapableRoute', () => {
  it('allows My Work and the board, nothing else', () => {
    expect(isOfflineCapableRoute('/me/work')).toBe(true);
    expect(isOfflineCapableRoute('/projects/abc/board')).toBe(true);
    expect(isOfflineCapableRoute('/projects/abc/schedule')).toBe(false);
    expect(isOfflineCapableRoute('/me/settings')).toBe(false);
  });
});

describe('OfflineRouteGate', () => {
  it('shows "This view isn\'t cached" on a cold offline launch of an uncached route', () => {
    renderAt('/projects/abc/schedule', true);
    expect(screen.getByRole('heading', { name: 'This view isn’t cached' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to My Work' })).toHaveAttribute(
      'href',
      '/me/work',
    );
    expect(screen.getByRole('button', { name: 'Retry connection' })).toBeInTheDocument();
    expect(screen.queryByText('route content')).not.toBeInTheDocument();
    // Honest copy: only My Work has an offline copy; no offline time tracking ships yet.
    expect(
      screen.getByText(/My Work shows the last copy saved on this device/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/time tracking/i)).not.toBeInTheDocument();
  });

  it('renders My Work on a cold offline launch', () => {
    renderAt('/me/work', true);
    expect(screen.getByText('route content')).toBeInTheDocument();
  });

  it('never replaces a page in a warm session that lost its connection', () => {
    renderAt('/projects/abc/schedule', false);
    expect(screen.getByText('route content')).toBeInTheDocument();
  });

  it('renders the route once the connection is back', () => {
    online.value = true;
    renderAt('/projects/abc/schedule', true);
    expect(screen.getByText('route content')).toBeInTheDocument();
  });
});
