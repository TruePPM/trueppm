import type { ReactNode, ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { SystemHealthCard, RateLimitCard, TrashCard } from './SystemSummaryCards';

// The cards read SettingsCard from the shell; strip the rest of the chrome.
vi.mock('../SettingsShell', async () => {
  const actual = await vi.importActual('../SettingsShell');
  return {
    ...actual,
    SettingsPageTitle: ({ title, subtitle }: { title: string; subtitle?: string }) => (
      <div>
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
    ),
    SettingsCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  };
});

const useSystemHealth = vi.fn();
vi.mock('@/hooks/useSystemHealth', () => ({
  useSystemHealth: () => useSystemHealth() as unknown,
}));

const useTrashedProjects = vi.fn();
vi.mock('@/hooks/useProjectMutations', () => ({
  useTrashedProjects: () => useTrashedProjects() as unknown,
}));

function comp(status: 'ok' | 'warn' | 'crit' | 'unknown') {
  return { key: status, label: status, status, state_label: '', meta: '' };
}

function healthResult(
  components: ReturnType<typeof comp>[],
  parked = 0,
  extra: Record<string, unknown> = {},
) {
  return {
    data: { components, dead_letter: { parked, oldest_age_seconds: null, top_cause: null, by_status: {} } },
    isLoading: false,
    error: null,
    dataUpdatedAt: Date.now(),
    ...extra,
  };
}

const renderIn = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('SystemHealthCard (#2298)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rolls all-ok components up to a healthy status and links to the console', () => {
    useSystemHealth.mockReturnValue(healthResult([comp('ok'), comp('ok'), comp('ok')]));
    renderIn(<SystemHealthCard />);
    expect(screen.getByText('All 3 components healthy')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open console/ })).toHaveAttribute(
      'href',
      '/settings/health',
    );
    // No parked jobs → no dead-letter token.
    expect(screen.queryByRole('link', { name: /Dead-letters/ })).toBeNull();
  });

  it('surfaces a degraded rollup and a dead-letter token linking to the inspector', () => {
    useSystemHealth.mockReturnValue(healthResult([comp('ok'), comp('warn'), comp('unknown')], 2));
    renderIn(<SystemHealthCard />);
    // warn + unknown both fold into the degraded bucket.
    expect(screen.getByText('2 of 3 components degraded')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Dead-letters: 2' })).toHaveAttribute(
      'href',
      '/settings/health/dead-letters',
    );
  });

  it('marks any critical component as critical', () => {
    useSystemHealth.mockReturnValue(healthResult([comp('ok'), comp('crit'), comp('warn')]));
    renderIn(<SystemHealthCard />);
    expect(screen.getByText('1 of 3 components critical')).toBeInTheDocument();
  });

  it('keeps the console reachable when the status fetch fails', () => {
    useSystemHealth.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('boom'),
      dataUpdatedAt: 0,
    });
    renderIn(<SystemHealthCard />);
    expect(screen.getByText(/Couldn't reach the health endpoint/)).toBeInTheDocument();
    // Degraded, not blocked — Open still works.
    expect(screen.getByRole('link', { name: /Open console/ })).toHaveAttribute(
      'href',
      '/settings/health',
    );
  });
});

describe('RateLimitCard (#2316)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows an Enabled status when API rate limiting is on', () => {
    useSystemHealth.mockReturnValue({
      data: { security: { rate_limiting_enabled: true } },
      isLoading: false,
    });
    renderIn(<RateLimitCard />);
    expect(screen.getByRole('heading', { name: 'API rate limiting' })).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    // The env-var note is always present so an admin knows where it is configured.
    expect(screen.getByText('TRUEPPM_RATE_LIMIT_ENABLED')).toBeInTheDocument();
  });

  it('shows a critical Disabled status and the abuse-protection warning when off', () => {
    useSystemHealth.mockReturnValue({
      data: { security: { rate_limiting_enabled: false } },
      isLoading: false,
    });
    renderIn(<RateLimitCard />);
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(screen.getByText(/turned off on this server/i)).toBeInTheDocument();
  });

  it('holds a skeleton — not a chip — while the shared fetch is loading (no flash)', () => {
    useSystemHealth.mockReturnValue({ data: undefined, isLoading: true });
    renderIn(<RateLimitCard />);
    expect(screen.getByRole('heading', { name: 'API rate limiting' })).toBeInTheDocument();
    expect(screen.queryByText('Enabled')).toBeNull();
    expect(screen.queryByText('Disabled')).toBeNull();
  });

  it('degrades to an unknown status when the payload has no security block', () => {
    useSystemHealth.mockReturnValue({ data: {}, isLoading: false });
    renderIn(<RateLimitCard />);
    expect(screen.getByText('Status unavailable')).toBeInTheDocument();
  });
});

describe('TrashCard (#2298)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the empty state and links to Trash', () => {
    useTrashedProjects.mockReturnValue({ data: [], isLoading: false });
    renderIn(<TrashCard />);
    expect(screen.getByText('Trash is empty')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open trash/ })).toHaveAttribute(
      'href',
      '/settings/trash',
    );
  });

  it('pluralizes the deleted-project count', () => {
    useTrashedProjects.mockReturnValue({ data: [{ id: 'a' }, { id: 'b' }], isLoading: false });
    renderIn(<TrashCard />);
    expect(screen.getByText('2 deleted projects')).toBeInTheDocument();
  });

  it('uses the singular for exactly one', () => {
    useTrashedProjects.mockReturnValue({ data: [{ id: 'a' }], isLoading: false });
    renderIn(<TrashCard />);
    expect(screen.getByText('1 deleted project')).toBeInTheDocument();
  });
});
