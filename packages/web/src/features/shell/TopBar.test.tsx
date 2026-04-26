import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { TopBar } from './TopBar';

// ViewTabs hides itself when there is no :projectId in the URL path (ADR-0030).
// Provide one so the nav renders; individual tests render under the default `*`
// route where useParams() is empty.
vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => 'test-project-id',
}));

describe('TopBar', () => {
  it('renders the logo', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByText('TruePPM')).toBeInTheDocument();
  });

  it('renders view tabs navigation with all views including WBS', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByRole('navigation', { name: /view/i })).toBeInTheDocument();
    // "Gantt" renamed to "Schedule" per design handoff (issue #177)
    expect(screen.getByRole('link', { name: 'Schedule' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'WBS' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Table' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Board' })).toBeInTheDocument();
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
});
