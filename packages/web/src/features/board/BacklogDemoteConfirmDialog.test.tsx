/**
 * BacklogDemoteConfirmDialog unit tests (#361, ADR-0057, Option C).
 *
 * The dialog is the deliberate-decision moment for demoting TO DO →
 * BACKLOG. Two persona-driven hard-NOs ride on it:
 *  - David (Resource Mgr): silent demotion → capacity bleed
 *  - Alex (Scrum Master):  silent mid-sprint scope shrinkage
 * So we verify confirm and cancel paths fire the right callback exactly once,
 * and that Esc cancels (so the keyboard exit matches the visual exit).
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BacklogDemoteConfirmDialog } from './BacklogDemoteConfirmDialog';
import type { Task } from '@/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Refresh login UX',
    start: '2026-04-01',
    finish: '2026-04-02',
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
    ...overrides,
  };
}

describe('BacklogDemoteConfirmDialog', () => {
  it('renders task name in the description', () => {
    render(
      <BacklogDemoteConfirmDialog
        task={makeTask({ name: 'Refresh login UX' })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Refresh login UX')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /Move back to backlog/i })).toBeInTheDocument();
  });

  it('fires onConfirm when Move-to-backlog is clicked', () => {
    const onConfirm = vi.fn();
    render(
      <BacklogDemoteConfirmDialog
        task={makeTask()}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Move to backlog' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('fires onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    render(
      <BacklogDemoteConfirmDialog
        task={makeTask()}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('fires onCancel when Escape is pressed', () => {
    const onCancel = vi.fn();
    render(
      <BacklogDemoteConfirmDialog
        task={makeTask()}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('focuses the confirm button on mount (so Enter commits without tabbing)', () => {
    render(
      <BacklogDemoteConfirmDialog
        task={makeTask()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Move to backlog' }),
    );
  });
});
