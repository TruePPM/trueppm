import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect } from 'vitest';
import type { ReactNode } from 'react';
import { MyWorkSourceFreshness } from './MyWorkSourceFreshness';
import type { MyWorkExternalSource } from '@/hooks/useMyWork';

function wrap(ui: ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

const connected: MyWorkExternalSource = {
  source_type: 'jira',
  label: 'Jira',
  site_url: 'truescope.atlassian.net',
  status: 'connected',
  last_synced_at: '2026-07-06T09:31:00Z',
};

describe('MyWorkSourceFreshness', () => {
  it('renders nothing when no sources are connected', () => {
    const { container } = wrap(<MyWorkSourceFreshness sources={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a "synced …" freshness line for a healthy connection', () => {
    wrap(<MyWorkSourceFreshness sources={[connected]} />);
    expect(screen.getByText('Jira')).toBeInTheDocument();
    expect(screen.getByText(/synced/)).toBeInTheDocument();
    // Healthy connection is not a reconnect prompt.
    expect(screen.queryByRole('link', { name: /Reconnect/ })).not.toBeInTheDocument();
  });

  it('shows a Reconnect link to Connected Accounts when the token failed', () => {
    wrap(<MyWorkSourceFreshness sources={[{ ...connected, status: 'auth_failed' }]} />);
    const link = screen.getByRole('link', { name: 'Reconnect Jira' });
    expect(link).toHaveAttribute('href', '/me/settings/connected-accounts');
  });

  it('handles a connected source that has never synced', () => {
    wrap(<MyWorkSourceFreshness sources={[{ ...connected, last_synced_at: null }]} />);
    expect(screen.getByText('not synced yet')).toBeInTheDocument();
  });
});
