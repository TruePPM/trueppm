import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { willAutoPromoteOnComplete, useProgressAutoStatusConfirm } from './useProgressAutoStatusConfirm';
import { ROLE_MEMBER, ROLE_ADMIN } from '@/lib/roles';
import type { TaskStatus } from '@/types';

describe('willAutoPromoteOnComplete (#2639)', () => {
  it('is true at 100% from any status not already past sign-off', () => {
    const eligible: TaskStatus[] = ['NOT_STARTED', 'IN_PROGRESS'];
    for (const status of eligible) {
      expect(willAutoPromoteOnComplete(status, 100)).toBe(true);
    }
  });

  it('is false below 100%, regardless of status', () => {
    expect(willAutoPromoteOnComplete('IN_PROGRESS', 99)).toBe(false);
    expect(willAutoPromoteOnComplete('NOT_STARTED', 0)).toBe(false);
  });

  it('is false for statuses already past sign-off or requiring a manual promotion', () => {
    expect(willAutoPromoteOnComplete('COMPLETE', 100)).toBe(false);
    expect(willAutoPromoteOnComplete('REVIEW', 100)).toBe(false);
    expect(willAutoPromoteOnComplete('BACKLOG', 100)).toBe(false);
  });
});

/** Minimal harness so the hook's stateful confirm/cancel flow can be exercised directly. */
function Harness({
  role,
  status,
  commit,
  onCancel,
}: {
  role: number | null | undefined;
  status: TaskStatus;
  commit: () => void;
  onCancel?: () => void;
}) {
  const { dialog, requestCommit } = useProgressAutoStatusConfirm(role);
  return (
    <div>
      <button onClick={() => requestCommit(status, 100, commit, onCancel)}>Set to 100</button>
      {dialog}
    </div>
  );
}

describe('useProgressAutoStatusConfirm (#2639)', () => {
  it('commits immediately with no dialog when the write would not trigger auto-promotion', () => {
    const commit = vi.fn();
    render(<Harness role={ROLE_MEMBER} status="REVIEW" commit={commit} />);
    fireEvent.click(screen.getByRole('button', { name: /Set to 100/i }));
    expect(commit).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('shows the Review confirmation for a below-Admin role and only commits after confirming', () => {
    const commit = vi.fn();
    render(<Harness role={ROLE_MEMBER} status="IN_PROGRESS" commit={commit} />);
    fireEvent.click(screen.getByRole('button', { name: /Set to 100/i }));
    expect(commit).not.toHaveBeenCalled();
    expect(screen.getByText(/Send task to Review\?/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Send to Review/i }));
    expect(commit).toHaveBeenCalledOnce();
  });

  it('shows the Complete confirmation for an Admin+ role and only commits after confirming', () => {
    const commit = vi.fn();
    render(<Harness role={ROLE_ADMIN} status="IN_PROGRESS" commit={commit} />);
    fireEvent.click(screen.getByRole('button', { name: /Set to 100/i }));
    expect(commit).not.toHaveBeenCalled();
    expect(screen.getByText(/Mark task Complete\?/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Mark Complete/i }));
    expect(commit).toHaveBeenCalledOnce();
  });

  it('cancelling calls onCancel and never calls commit', () => {
    const commit = vi.fn();
    const onCancel = vi.fn();
    render(<Harness role={ROLE_MEMBER} status="IN_PROGRESS" commit={commit} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /Set to 100/i }));
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(commit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
