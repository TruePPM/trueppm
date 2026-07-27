import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MilestoneDatePopover } from './MilestoneDatePopover';
import type { ApiSprint } from '@/types';
import type { IterationLabelForms } from '@/lib/iterationLabel';

// ---------------------------------------------------------------------------
// Module mocks — the popover reads the active sprint and the project's
// iteration label; both are driven from mutable fixtures so each branch of the
// "End of {label} ({sprint})" chip can be exercised deterministically.
// ---------------------------------------------------------------------------

let mockActiveSprint: ApiSprint | null = null;
vi.mock('@/hooks/useSprints', () => ({
  useSprintsByState: () => ({
    closed: [],
    active: mockActiveSprint,
    planned: [],
    isLoading: false,
    error: null,
  }),
}));

let mockLabel: IterationLabelForms = {
  singular: 'Sprint',
  plural: 'Sprints',
  lower: 'sprint',
  lowerPlural: 'sprints',
  possessive: "Sprint's",
};
vi.mock('@/hooks/useIterationLabel', () => ({
  useIterationLabel: () => mockLabel,
}));

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/projects/p1/schedule']}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const PARENTS = [{ name: 'Foundation Phase', finish: '2026-06-30' }];

const ACTIVE_SPRINT: ApiSprint = {
  id: 'sprint-1',
  server_version: 1,
  short_id: 'SP-1',
  short_id_display: 'SP-1',
  name: 'Sprint 7',
  goal: '',
  notes: '',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  state: 'ACTIVE',
  target_milestone: null,
  target_milestone_detail: null,
  capacity_points: null,
  wip_limit: null,
  committed_points: 0,
  committed_task_count: 0,
  completed_points: 0,
  completed_task_count: 0,
  completion_ratio_points: null,
  completion_ratio_tasks: null,
  activated_at: '2026-04-01T00:00:00Z',
  closed_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

beforeEach(() => {
  mockActiveSprint = null;
  mockLabel = {
    singular: 'Sprint',
    plural: 'Sprints',
    lower: 'sprint',
    lowerPlural: 'sprints',
    possessive: "Sprint's",
  };
});

describe('MilestoneDatePopover', () => {
  it('renders nothing when open=false', () => {
    const { container } = wrap(
      <MilestoneDatePopover open={false} parents={PARENTS} onSelect={vi.fn()} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows parent phase chip when open=true', () => {
    wrap(<MilestoneDatePopover open parents={PARENTS} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('End of Foundation Phase')).toBeInTheDocument();
  });

  it('calls onSelect with parent finish date when chip clicked', () => {
    const onSelect = vi.fn();
    wrap(<MilestoneDatePopover open parents={PARENTS} onSelect={onSelect} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('End of Foundation Phase'));
    expect(onSelect).toHaveBeenCalledWith('2026-06-30');
  });

  it('closes after a phase chip is chosen', () => {
    const onClose = vi.fn();
    wrap(<MilestoneDatePopover open parents={PARENTS} onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByText('End of Foundation Phase'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows Pick custom… button', () => {
    wrap(<MilestoneDatePopover open parents={[]} onSelect={vi.fn()} onClose={vi.fn()} />);
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

  it('keeps only the parents that carry a finish date', () => {
    wrap(
      <MilestoneDatePopover
        open
        parents={[
          { name: 'Undated Phase', finish: undefined },
          { name: 'Dated Phase', finish: '2026-06-30' },
        ]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('End of Dated Phase')).toBeInTheDocument();
    expect(screen.queryByText('End of Undated Phase')).toBeNull();
  });

  it('caps phase chips at 3 when more parents are provided', () => {
    const manyParents = [
      { name: 'Phase 1', finish: '2026-03-31' },
      { name: 'Phase 2', finish: '2026-06-30' },
      { name: 'Phase 3', finish: '2026-09-30' },
      { name: 'Phase 4', finish: '2026-12-31' },
    ];
    wrap(<MilestoneDatePopover open parents={manyParents} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByText(/^End of/).length).toBe(3);
  });

  it('exposes the dialog role', () => {
    wrap(<MilestoneDatePopover open parents={[]} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Pick milestone date' })).toBeInTheDocument();
  });
});

describe('MilestoneDatePopover — active sprint chip', () => {
  it('omits the sprint chip when no sprint is active', () => {
    wrap(<MilestoneDatePopover open parents={[]} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /End of sprint/ })).toBeNull();
  });

  it('offers the active sprint finish when a sprint is active', () => {
    mockActiveSprint = ACTIVE_SPRINT;
    wrap(<MilestoneDatePopover open parents={[]} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: 'End of sprint (Sprint 7)' }),
    ).toBeInTheDocument();
  });

  it('uses the project iteration label in the sprint chip', () => {
    mockActiveSprint = ACTIVE_SPRINT;
    mockLabel = {
      singular: 'PI',
      plural: 'PIs',
      lower: 'PI',
      lowerPlural: 'PIs',
      possessive: "PI's",
    };
    wrap(<MilestoneDatePopover open parents={[]} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'End of PI (Sprint 7)' })).toBeInTheDocument();
  });

  it('selects the sprint finish date and closes when the sprint chip is clicked', () => {
    mockActiveSprint = ACTIVE_SPRINT;
    const onSelect = vi.fn();
    const onClose = vi.fn();
    wrap(<MilestoneDatePopover open parents={[]} onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'End of sprint (Sprint 7)' }));
    expect(onSelect).toHaveBeenCalledWith('2026-04-14');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('MilestoneDatePopover — custom date entry', () => {
  it('swaps the "Pick custom…" chip for a date field', () => {
    wrap(<MilestoneDatePopover open parents={[]} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pick custom…' }));
    expect(screen.queryByRole('button', { name: 'Pick custom…' })).toBeNull();
    expect(screen.getByRole('button', { name: 'OK' })).toBeInTheDocument();
  });

  it('disables OK until a date is typed', () => {
    const { container } = wrap(
      <MilestoneDatePopover open parents={[]} onSelect={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pick custom…' }));
    const ok = screen.getByRole('button', { name: 'OK' });
    expect(ok).toBeDisabled();

    const input = container.querySelector<HTMLInputElement>('input[type="date"]');
    expect(input).not.toBeNull();
    fireEvent.change(input as HTMLInputElement, { target: { value: '2026-08-15' } });
    expect(ok).not.toBeDisabled();
  });

  it('submits the typed date when OK is clicked', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { container } = wrap(
      <MilestoneDatePopover open parents={[]} onSelect={onSelect} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pick custom…' }));
    const input = container.querySelector<HTMLInputElement>('input[type="date"]');
    fireEvent.change(input as HTMLInputElement, { target: { value: '2026-08-15' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(onSelect).toHaveBeenCalledWith('2026-08-15');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('submits on Enter', () => {
    const onSelect = vi.fn();
    const { container } = wrap(
      <MilestoneDatePopover open parents={[]} onSelect={onSelect} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pick custom…' }));
    const input = container.querySelector<HTMLInputElement>('input[type="date"]');
    fireEvent.change(input as HTMLInputElement, { target: { value: '2026-09-01' } });
    fireEvent.keyDown(input as HTMLInputElement, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('2026-09-01');
  });

  it('ignores Enter while the field is still empty', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { container } = wrap(
      <MilestoneDatePopover open parents={[]} onSelect={onSelect} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pick custom…' }));
    const input = container.querySelector<HTMLInputElement>('input[type="date"]');
    fireEvent.keyDown(input as HTMLInputElement, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores unrelated keys in the date field', () => {
    const onSelect = vi.fn();
    const { container } = wrap(
      <MilestoneDatePopover open parents={[]} onSelect={onSelect} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pick custom…' }));
    const input = container.querySelector<HTMLInputElement>('input[type="date"]');
    fireEvent.change(input as HTMLInputElement, { target: { value: '2026-09-01' } });
    fireEvent.keyDown(input as HTMLInputElement, { key: 'a' });
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'OK' })).toBeInTheDocument();
  });

  // The popover's own Escape listener is registered on `document` in the capture
  // phase and calls stopPropagation, so it wins over the date field's inline
  // handler: Escape dismisses the whole popover rather than only the field.
  it('dismisses the popover on Escape in the date field, without selecting', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { container } = wrap(
      <MilestoneDatePopover open parents={[]} onSelect={onSelect} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pick custom…' }));
    const input = container.querySelector<HTMLInputElement>('input[type="date"]');
    fireEvent.change(input as HTMLInputElement, { target: { value: '2026-11-11' } });
    fireEvent.keyDown(input as HTMLInputElement, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps the typed value across re-renders of the field', () => {
    const { container } = wrap(
      <MilestoneDatePopover open parents={[]} onSelect={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pick custom…' }));
    const input = container.querySelector<HTMLInputElement>('input[type="date"]');
    fireEvent.change(input as HTMLInputElement, { target: { value: '2026-10-05' } });
    expect(container.querySelector<HTMLInputElement>('input[type="date"]')?.value).toBe(
      '2026-10-05',
    );
  });
});

describe('MilestoneDatePopover — dismissal', () => {
  it('closes on a mousedown outside the panel', () => {
    const onClose = vi.fn();
    wrap(<MilestoneDatePopover open parents={PARENTS} onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open on a mousedown inside the panel', () => {
    const onClose = vi.fn();
    wrap(<MilestoneDatePopover open parents={PARENTS} onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    wrap(<MilestoneDatePopover open parents={PARENTS} onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys', () => {
    const onClose = vi.fn();
    wrap(<MilestoneDatePopover open parents={PARENTS} onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('registers no document listeners while closed', () => {
    const onClose = vi.fn();
    wrap(
      <MilestoneDatePopover open={false} parents={PARENTS} onSelect={vi.fn()} onClose={onClose} />,
    );
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stops listening once the popover is closed again', () => {
    const onClose = vi.fn();
    const { rerender } = wrap(
      <MilestoneDatePopover open parents={PARENTS} onSelect={vi.fn()} onClose={onClose} />,
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <MemoryRouter initialEntries={['/projects/p1/schedule']}>
        <QueryClientProvider client={qc}>
          <MilestoneDatePopover
            open={false}
            parents={PARENTS}
            onSelect={vi.fn()}
            onClose={onClose}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
