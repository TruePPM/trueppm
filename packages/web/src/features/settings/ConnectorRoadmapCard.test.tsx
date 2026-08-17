import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ConnectorRoadmapCard } from './ConnectorRoadmapCard';

describe('ConnectorRoadmapCard', () => {
  it('renders both the "Available now" and "Coming soon" sections', () => {
    render(<ConnectorRoadmapCard />);
    expect(screen.getByRole('heading', { name: 'Connectors' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Available now' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Coming soon' })).toBeInTheDocument();
  });

  it('surfaces shipped connectors under "Available now" with links to where they live', () => {
    render(<ConnectorRoadmapCard />);
    // Personal connected accounts → in-app SPA route (not a new tab).
    const accounts = screen.getByRole('link', { name: /Manage accounts/i });
    expect(accounts).toHaveAttribute('href', '/me/settings/connected-accounts');
    expect(accounts).not.toHaveAttribute('target', '_blank');

    // Two connectors now carry a "Set-up guide" link, so they must be addressed by
    // href rather than by shared label text.
    const guides = screen.getAllByRole('link', { name: /Set-up guide/i });
    const hrefs = guides.map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://docs.trueppm.com/features/inbound-task-sync');
    expect(hrefs).toContain('https://docs.trueppm.com/administration/git-event-automation');
    // Published docs open safely in a new tab (rule 212).
    for (const guide of guides) {
      expect(guide).toHaveAttribute('target', '_blank');
      expect(guide).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('describes inbound task-sync as a push, not a pull (#2882)', () => {
    render(<ConnectorRoadmapCard />);
    // The endpoint is push-only: the operator's tracker POSTs to TruePPM with a
    // project API token. "Pull … into this project" described a fetch that does not
    // exist and survived two audits; assert the direction so it cannot regress.
    expect(screen.queryByText(/^Pull issues/i)).not.toBeInTheDocument();
    expect(screen.getByText(/tracker push issues and status changes/i)).toBeInTheDocument();
  });

  it('lists the shipped Git-event automation connector under "Available now"', () => {
    render(<ConnectorRoadmapCard />);
    expect(screen.getByText(/Git-event card automation/i)).toBeInTheDocument();
  });

  it('does NOT advertise shipped connectors as coming soon', () => {
    render(<ConnectorRoadmapCard />);
    // The task-sync / connected-accounts / file-preview issues shipped (#1622);
    // they must not appear as roadmap tracking-issue links any more.
    for (const shipped of [500, 488, 571, 587]) {
      expect(screen.queryByRole('link', { name: `#${shipped}` })).not.toBeInTheDocument();
    }
  });

  it('lists only genuinely-future connectors under "Coming soon", tagged 0.6', () => {
    render(<ConnectorRoadmapCard />);
    for (const issue of [570, 572]) {
      const link = screen.getByRole('link', { name: `#${issue}` });
      expect(link).toHaveAttribute('href', `https://gitlab.com/trueppm/trueppm/-/issues/${issue}`);
      // External links must open safely (no reverse-tabnabbing).
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    // Both roadmap connectors target 0.6 — never the already-shipped 0.2/0.3.
    expect(screen.getAllByText('0.6')).toHaveLength(2);
    expect(screen.queryByText('0.3')).not.toBeInTheDocument();
    expect(screen.queryByText('0.2')).not.toBeInTheDocument();
  });
});
