import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LabelPill, LabelPillRow } from './LabelPill';
import type { TaskLabel } from '@/types';

const LABELS: TaskLabel[] = [
  { id: 'l3', name: 'urgent', color: 'red', position: 2 },
  { id: 'l1', name: 'backend', color: 'blue', position: 0 },
  { id: 'l2', name: 'api', color: 'green', position: 0 },
  { id: 'l4', name: 'zeta', color: 'gray' },
];

describe('LabelPill', () => {
  it('renders the name beside a decorative color dot', () => {
    render(<LabelPill label={LABELS[0]} />);
    const pill = screen.getByTitle('urgent');
    expect(pill).toHaveTextContent('urgent');
    expect(pill.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('dot-only mode keeps the name reachable through the accessible name and title', () => {
    render(<LabelPill label={LABELS[0]} dotOnly />);
    const dot = screen.getByLabelText('Label: urgent');
    expect(dot).toHaveAttribute('title', 'urgent');
    expect(dot).toHaveTextContent('');
  });
});

describe('LabelPillRow', () => {
  it('renders nothing for an empty label set', () => {
    const { container } = render(<LabelPillRow labels={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('comfortable: two pills sorted by position (unset = 0) then name, plus an overflow chip naming the rest', () => {
    render(<LabelPillRow labels={LABELS} />);
    const titles = screen.getAllByTitle(/^(api|backend|urgent|zeta)$/).map((el) => el.title);
    expect(titles).toEqual(['api', 'backend']);
    const overflow = screen.getByText('+2');
    expect(overflow).toHaveAttribute('title', 'zeta, urgent');
  });

  it('detailed: every pill, no overflow chip', () => {
    render(<LabelPillRow labels={LABELS} density="detailed" />);
    expect(screen.getAllByTitle(/^(api|backend|urgent|zeta)$/)).toHaveLength(4);
    expect(screen.queryByText(/^\+\d/)).toBeNull();
  });

  it('compact: up to three dots under one group label, and a +N count', () => {
    render(<LabelPillRow labels={LABELS} density="compact" />);
    const group = screen.getByLabelText('Labels: api, backend, zeta, urgent');
    expect(group.querySelectorAll('[aria-label^="Label: "]')).toHaveLength(3);
    expect(group).toHaveTextContent('+1');
  });

  it('compact with three or fewer labels shows no count', () => {
    render(<LabelPillRow labels={LABELS.slice(0, 2)} density="compact" />);
    expect(screen.queryByText(/^\+\d/)).toBeNull();
  });
});
