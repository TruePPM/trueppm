import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { ReactNode } from 'react';
import { ExternalWorkItemRow } from './ExternalWorkItemRow';
import type { MyWorkExternalItem, MyWorkExternalSource } from '@/hooks/useMyWork';

function wrap(ui: ReactNode) {
  return render(<ul>{ui}</ul>);
}

const baseItem: MyWorkExternalItem = {
  id: 'ewi-1',
  source_type: 'jira',
  key: 'RIV-482',
  title: 'API gateway returns 502 under load',
  external_status: 'In Review',
  status_category: 'in_progress',
  due_date: '2026-07-12',
  url: 'https://truescope.atlassian.net/browse/RIV-482',
  synced_at: '2026-07-06T09:31:00Z',
};

const jiraSource: MyWorkExternalSource = {
  source_type: 'jira',
  label: 'Jira',
  site_url: 'truescope.atlassian.net',
  status: 'connected',
  last_synced_at: '2026-07-06T09:31:00Z',
};

describe('ExternalWorkItemRow', () => {
  it('renders the item as a read-only deep link that opens safely in a new tab', () => {
    wrap(<ExternalWorkItemRow item={baseItem} source={jiraSource} />);
    const link = screen.getByRole('link', { name: /API gateway returns 502/ });
    expect(link).toHaveAttribute('href', 'https://truescope.atlassian.net/browse/RIV-482');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('shows the provider key, source · host line, status and due date', () => {
    wrap(<ExternalWorkItemRow item={baseItem} source={jiraSource} />);
    expect(screen.getByText('RIV-482')).toBeInTheDocument();
    expect(screen.getByText('Jira')).toBeInTheDocument();
    expect(screen.getByText('truescope.atlassian.net')).toBeInTheDocument();
    expect(screen.getByText('In Review')).toBeInTheDocument();
    expect(screen.getByText('Due Jul 12')).toBeInTheDocument();
  });

  it('is read-only: no complete / timer / log-time / status-change controls', () => {
    wrap(<ExternalWorkItemRow item={baseItem} source={jiraSource} />);
    // The only interactive element is the deep link — no buttons at all.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText('Read-only')).toBeInTheDocument();
  });

  it('falls back to the key when the title is empty and omits due when null', () => {
    wrap(
      <ExternalWorkItemRow
        item={{ ...baseItem, title: '', due_date: null }}
        source={jiraSource}
      />,
    );
    expect(screen.getByRole('link', { name: /RIV-482/ })).toBeInTheDocument();
    expect(screen.queryByText(/^Due /)).not.toBeInTheDocument();
  });

  it('renders without a matching source (source label falls back to type)', () => {
    wrap(<ExternalWorkItemRow item={baseItem} />);
    // No host line, but the row still renders the key + title link.
    expect(screen.getByText('RIV-482')).toBeInTheDocument();
    expect(screen.queryByText('truescope.atlassian.net')).not.toBeInTheDocument();
  });
});
