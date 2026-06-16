import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { EmptyState } from './EmptyState';
import { ListIcon } from './Icons';

describe('EmptyState', () => {
  it('renders the icon (decorative), title, and description', () => {
    render(<EmptyState icon={ListIcon} title="No tasks yet" description="Add your first task." />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('No tasks yet');
    expect(status).toHaveTextContent('Add your first task.');
    // Heading is a real h2 for the document outline.
    expect(screen.getByRole('heading', { name: 'No tasks yet' })).toBeInTheDocument();
    // The icon is decorative — not exposed to the a11y tree.
    expect(status.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
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
        action={<button type="button" onClick={onClick}>Add task</button>}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('animates only under motion-safe (reduced-motion shows it statically)', () => {
    render(<EmptyState icon={ListIcon} title="No tasks yet" />);
    // The entrance is gated behind motion-safe: so prefers-reduced-motion users
    // get the content with no animation (v2 motion contract — motion, never content).
    expect(screen.getByRole('status').className).toContain('motion-safe:animate-empty-state-in');
  });

  it('accepts a className for hosts that must fill their area', () => {
    render(<EmptyState icon={ListIcon} title="x" className="h-full" />);
    expect(screen.getByRole('status').className).toContain('h-full');
  });
});
