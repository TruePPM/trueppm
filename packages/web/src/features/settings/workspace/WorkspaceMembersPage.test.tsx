import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { WorkspaceMembersPage } from './WorkspaceMembersPage';

// Uses the real fixture hook (useWorkspaceMembers) — the page is a stub that
// owns its fixtures, so a component-level test exercises the actual rendered
// output without any mocking.

describe('WorkspaceMembersPage — search + filters', () => {
  it('renders an accessible search input (not a span placeholder)', () => {
    render(<WorkspaceMembersPage />);
    expect(
      screen.getByRole('searchbox', { name: /search members by name or email/i }),
    ).toBeInTheDocument();
  });

  it('renders a Role filter as a real <select>', () => {
    render(<WorkspaceMembersPage />);
    const select = screen.getByRole('combobox', { name: /filter by role/i });
    expect(select).toBeInTheDocument();
    expect(select.tagName).toBe('SELECT');
  });

  it('narrows visible rows when typing in the search input', async () => {
    const user = userEvent.setup();
    render(<WorkspaceMembersPage />);
    const input = screen.getByRole('searchbox', { name: /search members/i });
    expect(screen.getByText('Anika Krishnan')).toBeInTheDocument();
    expect(screen.getByText('Maya Kearns')).toBeInTheDocument();

    await user.type(input, 'anika');

    expect(screen.getByText('Anika Krishnan')).toBeInTheDocument();
    expect(screen.queryByText('Maya Kearns')).not.toBeInTheDocument();
  });

  it('updates the "Showing N of M" footer when filtered', async () => {
    const user = userEvent.setup();
    render(<WorkspaceMembersPage />);
    expect(screen.getByText(/Showing all 10/)).toBeInTheDocument();

    await user.type(
      screen.getByRole('searchbox', { name: /search members/i }),
      'anika',
    );

    expect(screen.getByText(/Showing 1 of 10/)).toBeInTheDocument();
  });

  it('renders an empty state with the search term when nothing matches', async () => {
    const user = userEvent.setup();
    render(<WorkspaceMembersPage />);
    await user.type(
      screen.getByRole('searchbox', { name: /search members/i }),
      'zzzzz',
    );
    expect(screen.getByText('No members match "zzzzz"')).toBeInTheDocument();
  });

  it('narrows visible rows when selecting a Role', async () => {
    const user = userEvent.setup();
    render(<WorkspaceMembersPage />);
    await user.selectOptions(
      screen.getByRole('combobox', { name: /filter by role/i }),
      'Lead',
    );
    // Two Leads in the fixture: Sam Reyes, Erin Lai
    expect(screen.getByText('Sam Reyes')).toBeInTheDocument();
    expect(screen.getByText('Erin Lai')).toBeInTheDocument();
    expect(screen.queryByText('Anika Krishnan')).not.toBeInTheDocument();
    expect(screen.getByText(/Showing 2 of 10/)).toBeInTheDocument();
  });
});
