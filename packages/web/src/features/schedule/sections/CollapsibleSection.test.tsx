import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CollapsibleSection } from './CollapsibleSection';

describe('CollapsibleSection', () => {
  it('renders collapsed by default and exposes aria-expanded=false', () => {
    render(
      <CollapsibleSection id="overview" title="Overview">
        <p>body content</p>
      </CollapsibleSection>,
    );
    const button = screen.getByRole('button', { name: 'Overview' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('body content')).not.toBeInTheDocument();
  });

  it('renders open when defaultOpen is true', () => {
    render(
      <CollapsibleSection id="overview" title="Overview" defaultOpen>
        <p>body content</p>
      </CollapsibleSection>,
    );
    expect(screen.getByRole('button', { name: 'Overview' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText('body content')).toBeInTheDocument();
  });

  it('toggles open/closed when the header is clicked', () => {
    render(
      <CollapsibleSection id="overview" title="Overview">
        <p>body content</p>
      </CollapsibleSection>,
    );
    const button = screen.getByRole('button', { name: 'Overview' });
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('body content')).toBeInTheDocument();
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('lazily renders body via render-prop — children function is not called while collapsed', () => {
    let calls = 0;
    render(
      <CollapsibleSection id="overview" title="Overview">
        {() => {
          calls += 1;
          return <p>fetched</p>;
        }}
      </CollapsibleSection>,
    );
    // Closed by default → render-prop not called → no fetch fired.
    expect(calls).toBe(0);
    expect(screen.queryByText('fetched')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
    expect(calls).toBe(1);
    expect(screen.getByText('fetched')).toBeInTheDocument();
  });
});
