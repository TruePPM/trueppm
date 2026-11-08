import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { EmptyState } from './EmptyState';
import { ListIcon } from './Icons';

describe('EmptyState', () => {
  it('renders the icon (decorative), title, and description', () => {
    render(<EmptyState icon={ListIcon} title="No tasks yet" description="Add your first task." />);
    // The block carries no role of its own since #3198 — the announcement is the
    // shell's persistent region's job (ADR-0989), so specs scope on the testid.
    const block = screen.getByTestId('empty-state');
    expect(block).toHaveTextContent('No tasks yet');
    expect(block).toHaveTextContent('Add your first task.');
    // Heading is a real h2 for the document outline.
    expect(screen.getByRole('heading', { name: 'No tasks yet' })).toBeInTheDocument();
    // The icon is decorative — not exposed to the a11y tree.
    expect(block.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('omits the description and action blocks when not provided', () => {
    render(<EmptyState icon={ListIcon} title="Nothing here" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders an action and fires its handler', () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        icon={ListIcon}
        title="No tasks yet"
        action={
          <button type="button" onClick={onClick}>
            Add task
          </button>
        }
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('animates only under motion-safe (reduced-motion shows it statically)', () => {
    render(<EmptyState icon={ListIcon} title="No tasks yet" />);
    // The entrance is gated behind motion-safe: so prefers-reduced-motion users
    // get the content with no animation (v2 motion contract — motion, never content).
    expect(screen.getByTestId('empty-state').className).toContain(
      'motion-safe:animate-empty-state-in',
    );
  });

  it('accepts a className for hosts that must fill their area', () => {
    render(<EmptyState icon={ListIcon} title="x" className="h-full" />);
    expect(screen.getByTestId('empty-state').className).toContain('h-full');
  });
});

describe('EmptyState — Pass 2 page variant (rule 439)', () => {
  it('is left-aligned with no illustration', () => {
    render(<EmptyState variant="page" title="No risks logged yet" description="Log one." />);
    const block = screen.getByTestId('empty-state');
    expect(block).toHaveAttribute('data-variant', 'page');
    expect(block).toHaveClass('text-left', 'items-start');
    expect(block.querySelector('svg')).toBeNull();
    expect(
      screen.getByRole('heading', { level: 2, name: 'No risks logged yet' }),
    ).toBeInTheDocument();
  });

  it('renders up to two actions', () => {
    render(
      <EmptyState
        variant="page"
        title="Empty"
        actions={[
          <button key="a" type="button">
            Log a risk
          </button>,
          <button key="b" type="button">
            Import
          </button>,
        ]}
      />,
    );
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('refuses a third action at the type level', () => {
    render(
      <EmptyState
        variant="page"
        title="Empty"
        // @ts-expect-error — the tuple type caps actions at two.
        actions={[<span key="1" />, <span key="2" />, <span key="3" />]}
      />,
    );
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });
});
