import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CollapsibleSection } from './CollapsibleSection';
import { useDrawerSectionStore } from '@/stores/drawerSectionStore';

describe('CollapsibleSection', () => {
  // The open/closed memory is a module-level session store (#2049); reset it so
  // one test's toggle doesn't leak its override into the next.
  beforeEach(() => useDrawerSectionStore.setState({ overrides: {} }));

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

  it('remembers an expanded section across remounts, keyed by id (#2049)', () => {
    // First mount: user expands the Estimates section.
    const first = render(
      <CollapsibleSection id="estimates" title="Estimates">
        <p>estimate body</p>
      </CollapsibleSection>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Estimates' }));
    expect(screen.getByRole('button', { name: 'Estimates' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    // Drawer closes and reopens on the next task → the section unmounts and
    // remounts. Its expanded state must survive because it's keyed by id.
    first.unmount();
    render(
      <CollapsibleSection id="estimates" title="Estimates">
        <p>estimate body</p>
      </CollapsibleSection>,
    );
    expect(screen.getByRole('button', { name: 'Estimates' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText('estimate body')).toBeInTheDocument();

    // A different, never-touched section still honors its collapsed default.
    render(
      <CollapsibleSection id="activity" title="Activity">
        <p>activity body</p>
      </CollapsibleSection>,
    );
    expect(screen.getByRole('button', { name: 'Activity' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});
