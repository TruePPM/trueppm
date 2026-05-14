import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MilestoneDatePopover } from './MilestoneDatePopover';

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/projects/p1/schedule']}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const PARENTS = [{ name: 'Foundation Phase', finish: '2026-06-30' }];

describe('MilestoneDatePopover', () => {
  it('renders nothing when open=false', () => {
    const { container } = wrap(
      <MilestoneDatePopover open={false} parents={PARENTS} onSelect={vi.fn()} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows parent phase chip when open=true', () => {
    wrap(
      <MilestoneDatePopover open parents={PARENTS} onSelect={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByText('End of Foundation Phase')).toBeInTheDocument();
  });

  it('calls onSelect with parent finish date when chip clicked', () => {
    const onSelect = vi.fn();
    wrap(
      <MilestoneDatePopover open parents={PARENTS} onSelect={onSelect} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('End of Foundation Phase'));
    expect(onSelect).toHaveBeenCalledWith('2026-06-30');
  });

  it('shows Pick custom… button', () => {
    wrap(
      <MilestoneDatePopover open parents={[]} onSelect={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByText('Pick custom…')).toBeInTheDocument();
  });

  it('does not show a phase chip when parent has no finish date', () => {
    wrap(
      <MilestoneDatePopover
        open
        parents={[{ name: 'Phase', finish: undefined }]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText(/End of/)).toBeNull();
  });

  it('caps phase chips at 3 when more parents are provided', () => {
    const manyParents = [
      { name: 'Phase 1', finish: '2026-03-31' },
      { name: 'Phase 2', finish: '2026-06-30' },
      { name: 'Phase 3', finish: '2026-09-30' },
      { name: 'Phase 4', finish: '2026-12-31' },
    ];
    wrap(
      <MilestoneDatePopover open parents={manyParents} onSelect={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getAllByText(/^End of/).length).toBe(3);
  });

  it('exposes the dialog role', () => {
    wrap(
      <MilestoneDatePopover open parents={[]} onSelect={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('dialog', { name: 'Pick milestone date' })).toBeInTheDocument();
  });
});
