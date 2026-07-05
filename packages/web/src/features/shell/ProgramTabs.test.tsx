import { screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { ProgramTabs } from './ProgramTabs';

// Default: has a program ID.
vi.mock('@/hooks/useProgramId', () => ({
  useProgramId: vi.fn(() => 'prog-1'),
}));

import { useProgramId } from '@/hooks/useProgramId';
const mockUseProgramId = useProgramId as ReturnType<typeof vi.fn>;

describe('ProgramTabs', () => {
  it('renders null when there is no programId (e.g. on a project route)', () => {
    mockUseProgramId.mockReturnValue(undefined);
    const { container } = renderWithRouter(<ProgramTabs />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the program nav with all eight tabs (incl. Schedule + Resources + Assets + Settings)', () => {
    mockUseProgramId.mockReturnValue('prog-1');
    renderWithRouter(<ProgramTabs />, { initialEntries: ['/programs/prog-1/overview'] });
    expect(screen.getByRole('navigation', { name: 'Program' })).toBeInTheDocument();
    for (const label of [
      'Overview',
      'Backlog',
      'Projects',
      'Schedule',
      'Resources',
      'Members',
      'Assets',
      'Settings',
    ]) {
      expect(screen.getByRole('link', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    }
  });

  it('links the Assets tab to the program-scoped assets path (ADR-0215)', () => {
    mockUseProgramId.mockReturnValue('prog-abc');
    renderWithRouter(<ProgramTabs />, { initialEntries: ['/programs/prog-abc/overview'] });
    expect(screen.getByRole('link', { name: /Assets/i })).toHaveAttribute(
      'href',
      '/programs/prog-abc/assets',
    );
  });

  it('links use program-scoped paths', () => {
    mockUseProgramId.mockReturnValue('prog-abc');
    renderWithRouter(<ProgramTabs />, { initialEntries: ['/programs/prog-abc/overview'] });
    expect(screen.getByRole('link', { name: /Backlog/i })).toHaveAttribute(
      'href',
      '/programs/prog-abc/backlog',
    );
    expect(screen.getByRole('link', { name: /Settings/i })).toHaveAttribute(
      'href',
      '/programs/prog-abc/settings',
    );
  });

  it('marks the Backlog tab active on /backlog', () => {
    mockUseProgramId.mockReturnValue('prog-1');
    renderWithRouter(<ProgramTabs />, { initialEntries: ['/programs/prog-1/backlog'] });
    expect(screen.getByRole('link', { name: /Backlog/i })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Overview/i })).not.toHaveAttribute('aria-current');
  });

  // Settings has sub-routes — the Settings tab must stay active across all of them.
  it('marks the Settings tab active across /settings/* sub-routes', () => {
    mockUseProgramId.mockReturnValue('prog-1');
    renderWithRouter(<ProgramTabs />, { initialEntries: ['/programs/prog-1/settings/cadence'] });
    expect(screen.getByRole('link', { name: /Settings/i })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Projects/i })).not.toHaveAttribute('aria-current');
  });
});
