import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ConnectorRoadmapCard } from './ConnectorRoadmapCard';

describe('ConnectorRoadmapCard', () => {
  it('renders the "Coming soon" heading', () => {
    render(<ConnectorRoadmapCard />);
    expect(screen.getByRole('heading', { name: 'Coming soon' })).toBeInTheDocument();
  });

  it('links each roadmap connector to its tracking issue', () => {
    render(<ConnectorRoadmapCard />);
    const expectedIssues = [500, 488, 570, 571, 572, 587];
    for (const issue of expectedIssues) {
      const link = screen.getByRole('link', { name: `#${issue}` });
      expect(link).toHaveAttribute(
        'href',
        `https://gitlab.com/trueppm/trueppm/-/issues/${issue}`,
      );
      // External links must open safely (no reverse-tabnabbing).
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });
});
