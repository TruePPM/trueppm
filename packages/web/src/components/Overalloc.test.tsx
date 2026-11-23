import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OverallocBadge, OverallocBanner } from './Overalloc';

describe('OverallocBadge', () => {
  it('chip carries the glyph and the value, the glyph hidden from assistive tech', () => {
    render(<OverallocBadge value="1.4×" />);
    const chip = screen.getByTestId('overalloc-chip');
    expect(chip).toHaveTextContent('▲1.4×');
    expect(screen.getByText('▲')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('1.4×')).toBeInTheDocument();
  });

  it('marker is the glyph alone and is decorative (the avatar owns the name)', () => {
    render(<OverallocBadge variant="marker" />);
    const marker = screen.getByTestId('overalloc-marker');
    expect(marker).toHaveTextContent('▲');
    expect(marker).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('OverallocBanner', () => {
  it('states the server count with the glyph, singular and plural', () => {
    const { rerender } = render(<OverallocBanner count={1} />);
    expect(screen.getByRole('status')).toHaveTextContent('▲1 person over capacity');
    rerender(<OverallocBanner count={3} action={<a href="/people">Review</a>} />);
    expect(screen.getByRole('status')).toHaveTextContent('3 people over capacity');
    expect(screen.getByRole('link', { name: 'Review' })).toBeInTheDocument();
  });

  it('renders nothing when nobody is over capacity', () => {
    const { container } = render(<OverallocBanner count={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});
