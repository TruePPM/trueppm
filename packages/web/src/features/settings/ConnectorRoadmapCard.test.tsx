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

    // Inbound task-sync → published docs guide, opened safely in a new tab (rule 212).
    const guide = screen.getByRole('link', { name: /Set-up guide/i });
    expect(guide).toHaveAttribute('href', 'https://docs.trueppm.com/features/inbound-task-sync');
    expect(guide).toHaveAttribute('target', '_blank');
    expect(guide).toHaveAttribute('rel', 'noopener noreferrer');
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
