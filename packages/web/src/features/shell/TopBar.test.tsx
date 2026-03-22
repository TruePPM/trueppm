import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { TopBar } from './TopBar';

describe('TopBar', () => {
  it('renders the logo', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByText('TruePPM')).toBeInTheDocument();
  });

  it('renders view tabs navigation', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByRole('navigation', { name: /view/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Gantt' })).toBeInTheDocument();
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

  it('renders at-risk and critical badges from fixture stats', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    // Fixture has atRiskCount=2, criticalCount=1
    expect(screen.getByLabelText(/2 tasks at risk/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/1 critical/i)).toBeInTheDocument();
  });
});
