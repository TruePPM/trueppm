import { within, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { useThemeStore } from '@/stores/themeStore';
import { FIXTURE_SHELL_STATS } from '@/fixtures/shellStats';
import { TopBar } from './TopBar';

// ViewTabs hides itself when there is no :projectId in the URL path (ADR-0030).
// Provide one so the nav renders; individual tests render under the default `*`
// route where useParams() is empty.
vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => 'test-project-id',
}));

// Stub useNavigate to avoid react-router navigation side-effects in JSDOM tests.
// handleTaskNavigate calls navigate('/') which triggers react-router's fetch machinery
// and produces an unhandled AbortSignal rejection in the test environment.
const mockNavigate = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// useShellStats now calls the real API — stub with fixture data for unit tests.
// Use a hoisted mutable container so individual tests can override the return value.
import type { ShellStats } from '@/types';

const mockShellStatsContainer = vi.hoisted<{ current: ShellStats | undefined }>(() => ({ current: undefined }));

vi.mock('@/hooks/useShellStats', () => ({
  useShellStats: () => ({ data: mockShellStatsContainer.current, isLoading: false, error: null }),
}));

// useProjectPresence calls the presence API — stub with empty list for unit tests.
vi.mock('@/hooks/useProjectPresence', () => ({
  useProjectPresence: () => [],
}));

// useMonteCarloResult — stub with fixture data so the MC panel can open.
vi.mock('@/hooks/useMonteCarloResult', () => ({
  useMonteCarloResult: () => ({
    data: {
      projectId: 'proj-1',
      runs: 1000,
      p50: '2026-10-05',
      p80: '2026-11-03',
      p95: '2026-11-30',
      buckets: [],
    },
    isLoading: false,
    error: null,
  }),
}));

beforeEach(() => {
  useThemeStore.setState({ theme: 'auto' });
  mockShellStatsContainer.current = FIXTURE_SHELL_STATS;
});

describe('TopBar', () => {
  it('renders the logo', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByText('TruePPM')).toBeInTheDocument();
  });

  it('renders view tabs navigation with all views including WBS', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByRole('navigation', { name: /view/i })).toBeInTheDocument();
    // "Gantt" renamed to "Schedule" per design handoff (issue #204)
    expect(screen.getByRole('link', { name: 'Schedule' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'WBS' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Table' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Board' })).toBeInTheDocument();
  });

  it('Board is the first tab and Schedule is the second (issue #204)', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: /view/i });
    const links = within(nav).getAllByRole('link');
    expect(links[0]).toHaveTextContent('Board');
    expect(links[1]).toHaveTextContent('Schedule');
  });

  it('renders P80 badge from fixture stats (issue #205)', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    // Fixture has monteCarlop80: '2026-11-03'. Exact day depends on local TZ;
    // assert the button is present and contains "Nov" (the month is unambiguous).
    const p80Btn = screen.getByRole('button', { name: /monte carlo p80/i });
    expect(p80Btn).toBeInTheDocument();
    expect(p80Btn).toHaveTextContent(/P80:.*Nov/);
  });

  it('renders mobile Health dropdown button when there are health signals (issue #205)', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    // HealthDropdown is in the DOM at all viewport sizes; CSS hides it at lg+
    expect(screen.getByRole('button', { name: /project health summary/i })).toBeInTheDocument();
  });

  it('mobile Health dropdown expands to show P80 and task items on click (issue #205)', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    const healthBtn = screen.getByRole('button', { name: /project health summary/i });
    await user.click(healthBtn);
    expect(healthBtn).toHaveAttribute('aria-expanded', 'true');
    // Fixture has 2 at-risk tasks and 1 critical task
    expect(screen.getByRole('menu', { name: /project health summary/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /frontend build/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /backend implementation/i })).toBeInTheDocument();
  });

  it('renders hamburger button for mobile', () => {
    const onHamburgerClick = vi.fn();
    renderWithRouter(<TopBar onHamburgerClick={onHamburgerClick} />);
    expect(screen.getByRole('button', { name: /open sidebar/i })).toBeInTheDocument();
  });

  it('renders user avatar button', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: /user menu/i })).toBeInTheDocument();
  });

  it('renders at-risk and critical badge buttons from fixture stats', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    // Fixture has atRiskCount=2, criticalCount=1
    expect(screen.getByRole('button', { name: /2 at risk tasks/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1 critical tasks/i })).toBeInTheDocument();
  });

  it('renders the color scheme toggle group with three buttons', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByRole('group', { name: /color scheme/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /light mode/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /auto.*mode/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dark mode/i })).toBeInTheDocument();
  });

  it('marks the current theme button as pressed', () => {
    useThemeStore.setState({ theme: 'dark' });
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: /dark mode/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /light mode/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('switches theme when a toggle button is clicked', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /light mode/i }));
    expect(useThemeStore.getState().theme).toBe('light');
  });

  it('closes health dropdown on outside click', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    const healthBtn = screen.getByRole('button', { name: /project health summary/i });
    await user.click(healthBtn);
    expect(healthBtn).toHaveAttribute('aria-expanded', 'true');

    // Click outside the dropdown
    await user.click(document.body);
    expect(healthBtn).toHaveAttribute('aria-expanded', 'false');
  });

  it('health dropdown menu items are buttons with the correct role', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    const healthBtn = screen.getByRole('button', { name: /project health summary/i });
    await user.click(healthBtn);
    // at-risk tasks and critical tasks are rendered as menuitems
    const menuItems = screen.getAllByRole('menuitem');
    expect(menuItems.length).toBeGreaterThan(0);
  });

  it('calls onHamburgerClick when hamburger button is clicked', async () => {
    const user = userEvent.setup();
    const onHamburgerClick = vi.fn();
    renderWithRouter(<TopBar onHamburgerClick={onHamburgerClick} />);
    await user.click(screen.getByRole('button', { name: /open sidebar/i }));
    expect(onHamburgerClick).toHaveBeenCalledOnce();
  });

  it('marks the Board tab as active when on the board route', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />, {
      initialEntries: ['/projects/test-project-id/board'],
    });
    // The active Board link should have aria-current="page"
    const boardLink = screen.getByRole('link', { name: /Board/i });
    expect(boardLink).toHaveAttribute('aria-current', 'page');
    // Schedule link should NOT have aria-current
    const scheduleLink = screen.getByRole('link', { name: /Schedule/i });
    expect(scheduleLink).not.toHaveAttribute('aria-current');
  });

  it('clicking an at-risk menu item closes the dropdown', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />, {
      initialEntries: ['/projects/test-project-id/board'],
    });
    // Open the health dropdown
    await user.click(screen.getByRole('button', { name: /project health summary/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    // Click the first at-risk menuitem (from fixture: "Frontend Build")
    const items = screen.getAllByRole('menuitem');
    await user.click(items[0]);
    // Menu should close
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('clicking a critical menu item closes the dropdown', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />, {
      initialEntries: ['/projects/test-project-id/board'],
    });
    // Open the health dropdown
    await user.click(screen.getByRole('button', { name: /project health summary/i }));
    const items = screen.getAllByRole('menuitem');
    // Fixture: 2 at-risk + 1 critical — click the critical one (last menuitem)
    await user.click(items[items.length - 1]);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('renders no Health dropdown when stats has no health signals', () => {
    // Override mockShellStatsData to return stats with no health signals
    mockShellStatsContainer.current = {
      ...FIXTURE_SHELL_STATS,
      monteCarlop80: null,
      atRiskCount: 0,
      atRiskTasks: [],
      criticalCount: 0,
      criticalTasks: [],
    };
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    // HealthDropdown renders null when hasBadge is false — no dropdown button
    expect(screen.queryByRole('button', { name: /project health summary/i })).not.toBeInTheDocument();
  });

  it('renders no P80 button when monteCarlop80 is null', () => {
    mockShellStatsContainer.current = { ...FIXTURE_SHELL_STATS, monteCarlop80: null };
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /monte carlo p80/i })).not.toBeInTheDocument();
  });

  it('renders no at-risk badge when atRiskCount is 0', () => {
    mockShellStatsContainer.current = { ...FIXTURE_SHELL_STATS, atRiskCount: 0, atRiskTasks: [] };
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /at risk tasks/i })).not.toBeInTheDocument();
  });

  it('renders no critical badge when criticalCount is 0', () => {
    mockShellStatsContainer.current = { ...FIXTURE_SHELL_STATS, criticalCount: 0, criticalTasks: [] };
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /1 critical tasks/i })).not.toBeInTheDocument();
  });

  // P80 → MC distribution panel (issue #196)
  it('P80 button is not aria-disabled — it is clickable (issue #196)', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    const p80Btn = screen.getByRole('button', { name: /monte carlo p80/i });
    expect(p80Btn).not.toHaveAttribute('aria-disabled');
  });

  it('clicking P80 button opens MC distribution panel', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    const p80Btn = screen.getByRole('button', { name: /monte carlo p80/i });
    await user.click(p80Btn);
    expect(screen.getByRole('dialog', { name: /monte carlo confidence distribution/i })).toBeInTheDocument();
  });

  it('MC panel shows P50/P80/P95 section labels after P80 button click', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /monte carlo p80/i }));
    const dialog = screen.getByRole('dialog', { name: /monte carlo confidence distribution/i });
    // P50/P80/P95 section labels inside the panel (may appear multiple times with histogram)
    expect(within(dialog).getAllByText('P50').length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText('P80').length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText('P95').length).toBeGreaterThan(0);
  });

  it('MC panel can be closed with the close button', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /monte carlo p80/i }));
    expect(screen.getByRole('dialog', { name: /monte carlo confidence distribution/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /close monte carlo panel/i }));
    expect(screen.queryByRole('dialog', { name: /monte carlo confidence distribution/i })).not.toBeInTheDocument();
  });
});
