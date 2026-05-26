import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './ExternalLinksSection';
import type { ExternalLinkStatus } from '@/hooks/useTaskLinks';

describe('StatusBadge', () => {
  it.each<[ExternalLinkStatus, string]>([
    ['open', 'OPEN'],
    ['draft', 'DRAFT'],
    ['merged', 'MERGED'],
    ['closed', 'CLOSED'],
    ['unknown', 'UNKNOWN'],
  ])('renders the uppercase %s label (not color alone)', (status, label) => {
    render(<StatusBadge status={status} provider="github" />);
    expect(screen.getByText(label)).toBeInTheDocument();
    // The accessible name carries the status for screen readers.
    expect(screen.getByLabelText(`Status: ${status}`)).toBeInTheDocument();
  });

  it('shows an em dash for a generic link (status not applicable)', () => {
    render(<StatusBadge status="unknown" provider="generic" />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByLabelText('Status: not applicable')).toBeInTheDocument();
  });

  it('still shows UNKNOWN for a git provider awaiting refresh', () => {
    render(<StatusBadge status="unknown" provider="gitlab" />);
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
  });
});
