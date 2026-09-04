import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ModeChip, ModeGutter } from './RowModeIndicators';

describe('ModeGutter', () => {
  it('draws nothing for the waterfall baseline', () => {
    // Matching the canvas (`drawDeliveryModeMark` returns early on waterfall) is
    // what keeps a 400-row waterfall plan from carrying 400 identical marks.
    const { container } = render(<ModeGutter mode={{ kind: 'waterfall', parts: ['waterfall'] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('draws nothing when the row has no resolved mode', () => {
    const { container } = render(<ModeGutter mode={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('draws a solid band for a single mode', () => {
    render(<ModeGutter mode={{ kind: 'scrum', parts: ['scrum'] }} />);
    const gutter = screen.getByTestId('mode-gutter');
    expect(gutter).toHaveAttribute('data-mode', 'scrum');
    expect(gutter.style.background).toContain('var(--agile)');
  });

  it('splits the band across the modes a mixed subtree actually contains', () => {
    render(<ModeGutter mode={{ kind: 'mixed', parts: ['scrum', 'kanban'] }} />);
    const style = screen.getByTestId('mode-gutter').style.background;
    expect(style).toContain('linear-gradient');
    expect(style).toContain('var(--agile)');
    expect(style).toContain('var(--kanban)');
  });

  it('is decorative and never intercepts a row click', () => {
    // The chip carries the same fact as text; the gutter must not become a
    // second, silent tab stop or swallow the click that focuses the row.
    render(<ModeGutter mode={{ kind: 'kanban', parts: ['kanban'] }} />);
    const gutter = screen.getByTestId('mode-gutter');
    expect(gutter).toHaveAttribute('aria-hidden', 'true');
    expect(gutter.className).toContain('pointer-events-none');
  });
});

describe('ModeChip', () => {
  it('draws nothing for the waterfall baseline', () => {
    const { container } = render(<ModeChip mode={{ kind: 'waterfall', parts: ['waterfall'] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the mode token', () => {
    render(<ModeChip mode={{ kind: 'scrum', parts: ['scrum'] }} />);
    expect(screen.getByTestId('mode-chip')).toHaveTextContent('SCRUM');
  });

  it('reads MIXED on a parent whose subtree disagrees', () => {
    render(<ModeChip mode={{ kind: 'mixed', parts: ['waterfall', 'scrum'] }} />);
    expect(screen.getByTestId('mode-chip')).toHaveTextContent('MIXED');
  });

  it('carries a sentence as its accessible name, not the bare token', () => {
    render(<ModeChip mode={{ kind: 'kanban', parts: ['kanban'] }} />);
    expect(screen.getByLabelText(/item throughput/i)).toBeInTheDocument();
  });
});
