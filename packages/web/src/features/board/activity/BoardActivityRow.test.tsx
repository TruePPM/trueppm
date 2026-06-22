import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BoardActivityRow } from './BoardActivityRow';
import type { BoardActivityEvent, BoardEventType } from './useBoardActivity';

function event(over: Partial<BoardActivityEvent> = {}): BoardActivityEvent {
  return {
    id: 'e1',
    event_type: 'task_updated' as BoardEventType,
    actor: 'Priya',
    actor_id: 'u-priya',
    timestamp: '2026-06-22T00:00:00Z',
    task_id: 't1',
    task_name: 'Login API',
    sprint_id: null,
    changes: [{ field: 'status', old: 'To do', new: 'In progress' }],
    ...over,
  };
}

describe('BoardActivityRow', () => {
  it('shows actor, verb, task name, and a single-change summary', () => {
    render(<BoardActivityRow event={event()} onOpen={vi.fn()} />);
    expect(screen.getByText('Priya')).toBeInTheDocument();
    expect(screen.getByText('updated')).toBeInTheDocument();
    expect(screen.getByText('Login API')).toBeInTheDocument();
    expect(screen.getByText('status: To do → In progress')).toBeInTheDocument();
  });

  it('summarizes multiple changes as "+N more"', () => {
    render(
      <BoardActivityRow
        event={event({
          changes: [
            { field: 'status', old: 'To do', new: 'Done' },
            { field: 'story_points', old: '3', new: '5' },
          ],
        })}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText('status: To do → Done · +1 more')).toBeInTheDocument();
  });

  it('renders an openable event as a button and fires onOpen on click', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<BoardActivityRow event={event()} onOpen={onOpen} />);
    await user.click(screen.getByRole('button', { name: /Open card/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders a deleted card as a static row with a "(deleted)" marker, no button', () => {
    render(<BoardActivityRow event={event({ event_type: 'task_deleted', changes: [] })} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('(deleted)')).toBeInTheDocument();
    expect(screen.getByText('deleted')).toBeInTheDocument();
  });

  it('falls back to "System" when there is no actor', () => {
    render(<BoardActivityRow event={event({ actor: null })} onOpen={vi.fn()} />);
    expect(screen.getByText('System')).toBeInTheDocument();
  });
});
