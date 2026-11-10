/**
 * #4089 — the demo-collapsed default must hold when `/edition/` resolves AFTER the
 * Schedule mounted. The lazy `useState` initializer reads the flag once; without a
 * follow-up effect the tray stays open for the whole demo session.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRef } from 'react';
import type { ReactElement } from 'react';
import type { Task } from '@/types';
import { UnscheduledGutter } from './UnscheduledGutter';

const demo = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useDemoMode', () => ({
  useDemoMode: () => ({
    isDemoReadOnly: demo.value,
    loginHint: null,
    resetSchedule: null,
    isLoading: false,
  }),
}));
vi.mock('@/api/client', () => ({ apiClient: { patch: vi.fn() } }));

const task = {
  id: 't1',
  wbs: '1',
  name: 'Loose task',
  start: '',
  finish: '',
  duration: 1,
  progress: 0,
  parentId: null,
  isCritical: false,
  isComplete: false,
  isSummary: false,
  isMilestone: false,
  status: 'NOT_STARTED',
  assignees: [],
  notes: '',
} as Task;

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const canvasScrollRef = createRef<HTMLDivElement>();
function ui(): ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <UnscheduledGutter
        tasks={[task]}
        projectId="proj1"
        scaleData={null}
        canvasScrollRef={canvasScrollRef}
        taskListWidth={200}
      />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  demo.value = false;
});

describe('UnscheduledGutter — late demo resolution (#4089)', () => {
  it('collapses once isDemoReadOnly flips true after mount', () => {
    localStorage.setItem('trueppm.gantt.unscheduledGutter.collapsed', 'false');
    const { rerender } = render(ui());
    expect(screen.getByRole('button', { name: 'Collapse unscheduled tasks' })).toBeTruthy();
    demo.value = true;
    rerender(ui());
    expect(screen.getByRole('button', { name: 'Expand unscheduled tasks' })).toBeTruthy();
  });

  it('does not override a toggle the visitor made before the flag flipped', () => {
    localStorage.setItem('trueppm.gantt.unscheduledGutter.collapsed', 'true');
    const { rerender } = render(ui());
    fireEvent.click(screen.getByRole('button', { name: 'Expand unscheduled tasks' }));
    demo.value = true;
    rerender(ui());
    expect(screen.getByRole('button', { name: 'Collapse unscheduled tasks' })).toBeTruthy();
  });
});
