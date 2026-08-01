/**
 * Unit tests for ResourceAllocationTimeline (issue #85, ADR-0031).
 *
 * The component is mostly derived state: the month/week axis, the today marker,
 * per-span geometry, the four span variants, the overallocation affordances and
 * the unscheduled bucket are all computed from the AllocationResponse. Each
 * conditional below is driven both true and false.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { ResourceAllocationTimeline } from './ResourceAllocationTimeline';
import type { AllocationResource, AllocationResponse, AllocationTask } from './resourceUtils';

// `todayISO()` reads the wall clock. Pin it through a partial module mock rather
// than fake timers so the async popover assertions below keep a real event loop.
const today = vi.hoisted(() => ({ iso: '2026-04-15' }));
vi.mock('./resourceUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resourceUtils')>();
  return { ...actual, todayISO: () => today.iso };
});

const patchMock = vi.hoisted(() => vi.fn<(url: string, body: unknown) => Promise<unknown>>());
vi.mock('@/api/client', () => ({ apiClient: { patch: patchMock } }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function task(overrides: Partial<AllocationTask> = {}): AllocationTask {
  // scheduled_start defaults to whichever early_start this call resolves to
  // (not-started/complete windows coincide, ADR-0752 §2) so pre-existing
  // overrides that only touch early_start/early_finish stay geometrically
  // correct. Pass scheduled_start explicitly to test the in-progress
  // narrowing case (#2677).
  const early_start = 'early_start' in overrides ? overrides.early_start! : '2026-04-06';
  return {
    assignment_id: 'assign-1',
    id: 'task-1',
    name: 'Draft the charter',
    early_start,
    early_finish: '2026-04-10',
    scheduled_start: early_start,
    units: '1.00',
    status: 'IN_PROGRESS',
    ...overrides,
  };
}

function resource(overrides: Partial<AllocationResource> = {}): AllocationResource {
  return {
    id: 'res-1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    max_units: '1.00',
    tasks: [task()],
    ...overrides,
  };
}

function response(resources: AllocationResource[]): AllocationResponse {
  return {
    project_id: 'proj-1',
    window_start: '2026-04-01',
    window_end: '2026-04-30',
    resources,
  };
}

interface RenderOverrides {
  data?: AllocationResponse;
  windowStart?: string;
  windowEnd?: string;
  currentUserResourceId?: string;
  projectId?: string | undefined;
  onRunScheduler?: () => void;
}

function renderTimeline(overrides: RenderOverrides = {}) {
  const {
    data = response([resource()]),
    windowStart = '2026-04-01',
    windowEnd = '2026-04-30',
    currentUserResourceId,
    projectId = 'proj-1',
    onRunScheduler,
  } = overrides;
  return renderWithProviders(
    <ResourceAllocationTimeline
      data={data}
      windowStart={windowStart}
      windowEnd={windowEnd}
      currentUserResourceId={currentUserResourceId}
      projectId={projectId}
      onRunScheduler={onRunScheduler}
    />,
  );
}

/** The absolutely-positioned wrapper the component gives each scheduled span. */
function spanWrapper(container: HTMLElement, assignmentId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-assignment-id="${assignmentId}"]`);
  if (!el) throw new Error(`no span wrapper for ${assignmentId}`);
  return el;
}

/** The decorative "today" rule, or null when today falls outside the window. */
function todayMarker(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('div.bg-brand-primary\\/50');
}

beforeEach(() => {
  today.iso = '2026-04-15';
  patchMock.mockReset();
  patchMock.mockResolvedValue({ data: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Axis
// ---------------------------------------------------------------------------

describe('ResourceAllocationTimeline — month and week axis', () => {
  it('collapses consecutive days of one month into a single month group', () => {
    renderTimeline({ windowStart: '2026-04-01', windowEnd: '2026-04-30' });
    expect(screen.getAllByText('Apr 2026')).toHaveLength(1);
    expect(screen.queryByText('Mar 2026')).not.toBeInTheDocument();
  });

  it('opens a new month group when the window crosses a month boundary', () => {
    renderTimeline({ windowStart: '2026-03-30', windowEnd: '2026-04-05' });
    expect(screen.getByText('Mar 2026')).toBeInTheDocument();
    expect(screen.getByText('Apr 2026')).toBeInTheDocument();
  });

  it('labels one column per ISO week in the window', () => {
    const { container } = renderTimeline({
      windowStart: '2026-03-30',
      windowEnd: '2026-04-12',
    });
    // 2026-03-30 is a Monday, so the window is exactly two ISO weeks.
    const weekLabels = [...container.querySelectorAll('div')]
      .map((d) => d.textContent ?? '')
      .filter((t) => /^W\d+$/.test(t));
    expect(weekLabels).toEqual(['W14', 'W15']);
  });

  it('always renders the Resource column header', () => {
    renderTimeline();
    expect(screen.getByText('Resource')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Today marker
// ---------------------------------------------------------------------------

describe('ResourceAllocationTimeline — today marker', () => {
  it('draws the today rule when today falls inside the window', () => {
    const { container } = renderTimeline({
      windowStart: '2026-04-01',
      windowEnd: '2026-04-30',
    });
    const marker = todayMarker(container);
    expect(marker).not.toBeNull();
    // 14 whole days elapsed of a 30-day window → 46.6…%
    expect(marker?.style.left).toMatch(/^46\.6/);
  });

  it('omits the today rule when today is after the window', () => {
    today.iso = '2026-09-01';
    const { container } = renderTimeline({
      windowStart: '2026-04-01',
      windowEnd: '2026-04-30',
    });
    expect(todayMarker(container)).toBeNull();
  });

  it('omits the today rule when today is before the window', () => {
    today.iso = '2026-01-01';
    const { container } = renderTimeline({
      windowStart: '2026-04-01',
      windowEnd: '2026-04-30',
    });
    expect(todayMarker(container)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Span geometry
// ---------------------------------------------------------------------------

describe('ResourceAllocationTimeline — span geometry', () => {
  it('positions a fully-contained span as a fraction of the window', () => {
    const { container } = renderTimeline({
      data: response([
        resource({ tasks: [task({ early_start: '2026-04-11', early_finish: '2026-04-20' })] }),
      ]),
    });
    const wrapper = spanWrapper(container, 'assign-1');
    // Day 11 of 30 → 10/30 offset; 10 days wide → 10/30.
    expect(wrapper.style.left).toMatch(/^33\.3/);
    expect(wrapper.style.width).toMatch(/^33\.3/);
  });

  it('clamps a span that overhangs both window edges to the full width', () => {
    const { container } = renderTimeline({
      data: response([
        resource({ tasks: [task({ early_start: '2026-01-01', early_finish: '2026-12-31' })] }),
      ]),
    });
    const wrapper = spanWrapper(container, 'assign-1');
    expect(wrapper.style.left).toBe('0%');
    expect(wrapper.style.width).toBe('100%');
  });

  it('gives a span that ends before the window opens a zero width', () => {
    const { container } = renderTimeline({
      data: response([
        resource({ tasks: [task({ early_start: '2026-01-01', early_finish: '2026-01-05' })] }),
      ]),
    });
    const wrapper = spanWrapper(container, 'assign-1');
    expect(wrapper.style.width).toBe('0%');
  });

  it('skips a task that has a start but no finish', () => {
    const { container } = renderTimeline({
      data: response([
        resource({
          tasks: [
            task(),
            task({
              assignment_id: 'assign-2',
              id: 't2',
              name: 'Half-scheduled',
              early_finish: null,
            }),
          ],
        }),
      ]),
    });
    expect(container.querySelector('[data-assignment-id="assign-1"]')).not.toBeNull();
    expect(container.querySelector('[data-assignment-id="assign-2"]')).toBeNull();
  });

  it('positions the bar from the SPAN start (scheduled_start), not the narrowed early_start (#2677, ADR-0752)', () => {
    // early_start has narrowed to the remaining-work window (day 20 only);
    // scheduled_start still carries the real span start (day 11), matching
    // the fully-contained-span test above.
    const { container } = renderTimeline({
      data: response([
        resource({
          tasks: [
            task({
              early_start: '2026-04-20',
              early_finish: '2026-04-20',
              scheduled_start: '2026-04-11',
            }),
          ],
        }),
      ]),
    });
    const wrapper = spanWrapper(container, 'assign-1');
    // Same geometry as the "fully-contained span" test: day 11 of 30 → 10/30
    // offset; span runs day 11–20 → 10/30 wide.
    expect(wrapper.style.left).toMatch(/^33\.3/);
    expect(wrapper.style.width).toMatch(/^33\.3/);
  });
});

// ---------------------------------------------------------------------------
// Span variants
// ---------------------------------------------------------------------------

describe('ResourceAllocationTimeline — span variants', () => {
  it('renders a full-units, in-budget task as the normal variant', () => {
    renderTimeline({
      data: response([resource({ max_units: '2.00', tasks: [task({ units: '1.00' })] })]),
    });
    const button = screen.getByRole('button', { name: /Edit allocation for Draft the charter/ });
    expect(button).toHaveAccessibleName(
      'Edit allocation for Draft the charter, 100%, 2026-04-06 to 2026-04-10',
    );
    expect(button.style.backgroundImage).toBe('');
    expect(button.className).toContain('bg-brand-primary');
  });

  it('renders a sub-100% task as the partial variant with the stripe overlay', () => {
    renderTimeline({
      data: response([resource({ tasks: [task({ units: '0.50' })] })]),
    });
    const button = screen.getByRole('button', { name: /Edit allocation/ });
    expect(button.getAttribute('aria-label')).toContain('50%');
    expect(button.style.backgroundImage).toContain('var(--allocation-partial-stripe)');
  });

  it('renders an overallocated task as the over variant', () => {
    renderTimeline({
      data: response([
        resource({
          max_units: '1.00',
          tasks: [
            task({ units: '1.00' }),
            task({ assignment_id: 'assign-2', id: 't2', units: '1.00' }),
          ],
        }),
      ]),
    });
    const buttons = screen.getAllByRole('button', { name: /Edit allocation/ });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.getAttribute('aria-label')).toContain('overallocated');
      expect(button.className).toContain('bg-semantic-critical');
    }
  });

  it('renders a COMPLETE task as the complete variant even when overallocated', () => {
    renderTimeline({
      data: response([
        resource({
          max_units: '1.00',
          tasks: [
            task({ units: '1.00', status: 'COMPLETE' }),
            task({ assignment_id: 'assign-2', id: 't2', name: 'Sibling', units: '1.00' }),
          ],
        }),
      ]),
    });
    const complete = screen.getByRole('button', { name: /Edit allocation for Draft the charter/ });
    expect(complete.getAttribute('aria-label')).toContain('complete');
    expect(complete.getAttribute('aria-label')).not.toContain('overallocated');
    expect(complete.className).toContain('opacity-60');
  });
});

// ---------------------------------------------------------------------------
// Row header — overallocation and current-user affordances
// ---------------------------------------------------------------------------

describe('ResourceAllocationTimeline — row header', () => {
  it('shows availability with no overallocation affordances for a healthy resource', () => {
    renderTimeline({
      data: response([resource({ max_units: '0.50', tasks: [task({ units: '0.25' })] })]),
    });
    expect(screen.getByText('50% available')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Jump to first overallocation/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/overallocated ·/)).not.toBeInTheDocument();
  });

  it('shows the jump dot and the overallocated week range for a loaded resource', () => {
    renderTimeline({
      data: response([
        resource({
          max_units: '1.00',
          tasks: [
            task({ units: '1.00' }),
            task({ assignment_id: 'assign-2', id: 't2', units: '1.00' }),
          ],
        }),
      ]),
    });
    expect(
      screen.getByRole('button', { name: 'Jump to first overallocation for Ada Lovelace' }),
    ).toBeInTheDocument();
    // 2026-04-06 → 2026-04-10 is ISO week 15.
    expect(screen.getByText('· overallocated · W15')).toBeInTheDocument();
  });

  it('renders a multi-week range when the overload spans two ISO weeks', () => {
    renderTimeline({
      data: response([
        resource({
          max_units: '1.00',
          tasks: [
            task({ early_start: '2026-04-06', early_finish: '2026-04-17', units: '1.00' }),
            task({
              assignment_id: 'assign-2',
              id: 't2',
              early_start: '2026-04-06',
              early_finish: '2026-04-17',
              units: '1.00',
            }),
          ],
        }),
      ]),
    });
    expect(screen.getByText('· overallocated · W15–W16')).toBeInTheDocument();
  });

  it('scrolls the first overallocated span into view when the jump dot is clicked', () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    renderTimeline({
      data: response([
        resource({
          max_units: '1.00',
          tasks: [
            task({ units: '1.00' }),
            task({ assignment_id: 'assign-2', id: 't2', units: '1.00' }),
          ],
        }),
      ]),
    });

    fireEvent.click(screen.getByRole('button', { name: /Jump to first overallocation/ }));

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'center',
    });
  });

  it('badges only the row belonging to the current user', () => {
    renderTimeline({
      data: response([
        resource({ id: 'res-1', name: 'Ada Lovelace' }),
        resource({
          id: 'res-2',
          name: 'Grace Hopper',
          tasks: [task({ assignment_id: 'assign-2' })],
        }),
      ]),
      currentUserResourceId: 'res-1',
    });
    expect(screen.getAllByText('YOU')).toHaveLength(1);
  });

  it('renders no YOU badge when the viewer has no resource record', () => {
    renderTimeline({ data: response([resource()]) });
    expect(screen.queryByText('YOU')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Unscheduled bucket
// ---------------------------------------------------------------------------

describe('ResourceAllocationTimeline — unscheduled assignments', () => {
  const unscheduledTask = (overrides: Partial<AllocationTask> = {}) =>
    task({ early_start: null, early_finish: null, ...overrides });

  it('hides the unscheduled section when every assignment has dates', () => {
    renderTimeline();
    expect(screen.queryByText(/unscheduled assignment/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run scheduler' })).not.toBeInTheDocument();
  });

  it('uses the singular noun for exactly one unscheduled assignment', () => {
    renderTimeline({
      data: response([
        resource({
          tasks: [
            task(),
            unscheduledTask({ assignment_id: 'assign-2', name: 'Kickoff', units: '0.50' }),
          ],
        }),
      ]),
    });
    expect(
      screen.getByText('1 unscheduled assignment — tasks with no computed dates.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Kickoff')).toBeInTheDocument();
    expect(screen.getByText('(50%)')).toBeInTheDocument();
  });

  it('uses the plural noun for more than one unscheduled assignment', () => {
    renderTimeline({
      data: response([
        resource({
          tasks: [
            task(),
            unscheduledTask({ assignment_id: 'assign-2', name: 'Kickoff' }),
            unscheduledTask({ assignment_id: 'assign-3', name: 'Retro' }),
          ],
        }),
      ]),
    });
    expect(
      screen.getByText('2 unscheduled assignments — tasks with no computed dates.'),
    ).toBeInTheDocument();
  });

  it('drops a resource with no scheduled task from the timeline rows', () => {
    renderTimeline({
      data: response([
        resource({ id: 'res-1', name: 'Ada Lovelace' }),
        resource({
          id: 'res-2',
          name: 'Grace Hopper',
          tasks: [unscheduledTask({ assignment_id: 'assign-2', name: 'Kickoff' })],
        }),
      ]),
    });
    // Only the scheduled resource gets an availability read-out row.
    expect(screen.getAllByText('100% available')).toHaveLength(1);
    // …but the unscheduled resource still surfaces in the bucket below.
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
  });

  it('offers the Run scheduler action only when a handler is supplied', () => {
    const onRunScheduler = vi.fn();
    const data = response([
      resource({
        tasks: [task(), unscheduledTask({ assignment_id: 'assign-2', name: 'Kickoff' })],
      }),
    ]);

    const { unmount } = renderTimeline({ data, onRunScheduler });
    fireEvent.click(screen.getByRole('button', { name: 'Run scheduler' }));
    expect(onRunScheduler).toHaveBeenCalledTimes(1);
    unmount();

    renderTimeline({ data });
    expect(screen.queryByRole('button', { name: 'Run scheduler' })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Screen-reader summary
// ---------------------------------------------------------------------------

describe('ResourceAllocationTimeline — screen-reader summary', () => {
  function summaryText(container: HTMLElement): string {
    return container.querySelector('[aria-live="polite"]')?.textContent ?? '';
  }

  it('omits the overallocation clause when nobody is overloaded', () => {
    const { container } = renderTimeline({
      data: response([resource({ tasks: [task({ units: '0.50' })] })]),
    });
    expect(summaryText(container)).toBe(
      'Resource allocation timeline. 1 resources. Date range 2026-04-01 to 2026-04-30.',
    );
  });

  it('counts the overallocated resources when at least one is overloaded', () => {
    const { container } = renderTimeline({
      data: response([
        resource({
          max_units: '1.00',
          tasks: [
            task({ units: '1.00' }),
            task({ assignment_id: 'assign-2', id: 't2', units: '1.00' }),
          ],
        }),
        resource({
          id: 'res-2',
          name: 'Grace Hopper',
          tasks: [task({ assignment_id: 'assign-3', units: '0.25' })],
        }),
      ]),
    });
    expect(summaryText(container)).toBe(
      'Resource allocation timeline. 2 resources. 1 overallocated. Date range 2026-04-01 to 2026-04-30.',
    );
  });
});

// ---------------------------------------------------------------------------
// Inline edit popover wiring
// ---------------------------------------------------------------------------

describe('ResourceAllocationTimeline — inline allocation edit', () => {
  it('opens the popover for the clicked span only', () => {
    renderTimeline({
      data: response([
        resource({
          max_units: '2.00',
          tasks: [
            task({ units: '1.00' }),
            task({ assignment_id: 'assign-2', id: 't2', name: 'Sibling task', units: '1.00' }),
          ],
        }),
      ]),
    });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Edit allocation for Sibling task/ }));

    const dialog = screen.getByRole('dialog', { name: 'Edit allocation for Sibling task' });
    expect(within(dialog).getByText('Ada Lovelace · 2026-04-06 – 2026-04-10')).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('closes the popover on Cancel without issuing a PATCH', () => {
    renderTimeline();
    fireEvent.click(screen.getByRole('button', { name: /Edit allocation/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('saves a new allocation and closes the popover', async () => {
    renderTimeline({ projectId: 'proj-1' });
    fireEvent.click(screen.getByRole('button', { name: /Edit allocation/ }));

    const input = screen.getByLabelText<HTMLInputElement>('Allocation');
    expect(input.value).toBe('100');
    fireEvent.change(input, { target: { value: '75' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/task-resources/assign-1/', { units: 0.75 });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
