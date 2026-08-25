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

  it('names the filter, not the token, when the stored filter is unusable (#2888)', () => {
    // Same destination, different fault: `invalid_filter` means the credential
    // works and the saved filter cannot be scoped, so "Reconnect" would point at
    // the wrong fix.
    wrap(<MyWorkSourceFreshness sources={[{ ...connected, status: 'invalid_filter' }]} />);
    const link = screen.getByRole('link', { name: 'Fix Jira filter' });
    expect(link).toHaveAttribute('href', '/me/settings/connected-accounts');
    expect(screen.queryByRole('link', { name: /Reconnect/ })).not.toBeInTheDocument();
  });

  it('handles a connected source that has never synced', () => {
    wrap(<MyWorkSourceFreshness sources={[{ ...connected, last_synced_at: null }]} />);
    expect(screen.getByText('not synced yet')).toBeInTheDocument();
  });

  it('states when the feed above it is only the first N of the assigned items (#2925)', () => {
    wrap(
      <MyWorkSourceFreshness
        sources={[
          {
            ...connected,
            last_sync: {
              at: '2026-07-06T09:31:00Z',
              ok: true,
              reason: '',
              fetched: 100,
              stored: 100,
              total_available: 412,
              truncated: true,
            },
          },
        ]}
      />,
    );
    expect(
      screen.getByText('Showing the first 100 of 412 items assigned to you.'),
    ).toBeInTheDocument();
  });

  it('suppresses the truncation note when the connection needs fixing first', () => {
    // A source that needs reconnecting has a bigger problem than a partial page,
    // and the cached truncation describes a pull made with the dead token.
    wrap(
      <MyWorkSourceFreshness
        sources={[
          {
            ...connected,
            status: 'auth_failed',
            last_sync: {
              at: '2026-07-06T09:31:00Z',
              ok: true,
              reason: '',
              fetched: 100,
              stored: 100,
              total_available: 412,
              truncated: true,
            },
          },
        ]}
      />,
    );
    expect(screen.getByRole('link', { name: 'Reconnect Jira' })).toBeInTheDocument();
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument();
  });

  it('names a failed pull instead of reporting the clock (#2925)', () => {
    // `unreachable` leaves status `connected`, so without this the line says
    // "synced 3h ago" about a sync that did not happen — the same defect one
    // surface down.
    wrap(
      <MyWorkSourceFreshness
        sources={[
          {
            ...connected,
            last_sync: {
              at: '2026-07-06T09:31:00Z',
              ok: false,
              reason: 'unreachable',
              fetched: 0,
              stored: 0,
              total_available: null,
              truncated: false,
            },
          },
        ]}
      />,
    );
    expect(screen.getByText(/Couldn't reach Jira on the last sync/)).toBeInTheDocument();
    expect(screen.queryByText(/synced/)).not.toBeInTheDocument();
    // Neither remedy lives on Connected Accounts — no dead trip.
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('says nothing extra when a pull was complete', () => {
    wrap(
      <MyWorkSourceFreshness
        sources={[
          {
            ...connected,
            last_sync: {
              at: '2026-07-06T09:31:00Z',
              ok: true,
              reason: '',
              fetched: 8,
              stored: 8,
              total_available: 8,
              truncated: false,
            },
          },
        ]}
      />,
    );
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument();
  });
});
