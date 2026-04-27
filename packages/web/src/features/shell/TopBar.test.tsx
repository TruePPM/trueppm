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

// useShellStats now calls the real API — stub with fixture data for unit tests.
vi.mock('@/hooks/useShellStats', () => ({
  useShellStats: () => ({ data: FIXTURE_SHELL_STATS, isLoading: false, error: null }),
}));

// useProjectPresence calls the presence API — stub with empty list for unit tests.
vi.mock('@/hooks/useProjectPresence', () => ({
  useProjectPresence: () => [],
}));

beforeEach(() => {
  useThemeStore.setState({ theme: 'auto' });
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
});
