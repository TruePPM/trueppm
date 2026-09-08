/**
 * Tests for the allocation truncation notice (#3576 / ADR-1118).
 *
 * The thing worth asserting is not the copy — it is that the notice states the
 * *denominator*. A user who cannot see how many people are missing has no way to
 * tell an incomplete overallocation picture from a complete one, which is the
 * failure the server-side cap would otherwise introduce silently.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AllocationTruncationNotice } from './AllocationTruncationNotice';

describe('AllocationTruncationNotice', () => {
  it('names both how many are shown and how many exist', () => {
    render(<AllocationTruncationNotice resourceCount={62} shownCount={40} />);

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Showing 40 of 62 resources');
    expect(notice).toHaveTextContent('22 resources are not listed');
  });

  it('says "resource is" when exactly one is missing', () => {
    render(<AllocationTruncationNotice resourceCount={5} shownCount={4} />);

    expect(screen.getByRole('status')).toHaveTextContent('1 resource is not listed');
  });

  it('does not report a negative count if the server sends an unexpected pair', () => {
    // resource_count should never be below the number returned, but a clamped 0
    // is a better failure than "-3 resources are not listed".
    render(<AllocationTruncationNotice resourceCount={2} shownCount={5} />);

    expect(screen.getByRole('status')).toHaveTextContent('0 resources are not listed');
  });

  it('announces itself politely rather than as an alert', () => {
    // A capped read is informational, not an error — role="alert" would interrupt
    // a screen-reader user mid-sentence for something they cannot act on urgently.
    render(<AllocationTruncationNotice resourceCount={62} shownCount={40} />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
