import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MyWorkRetroSection } from './MyWorkRetroSection';
import type { MyWorkRetroActionItem } from '@/hooks/useMyWork';

const acceptMutate = vi.hoisted(() => vi.fn());
const declineMutate = vi.hoisted(() => vi.fn());
const pending = vi.hoisted(() => ({ accept: false, decline: false }));

vi.mock('@/hooks/useSprints', () => ({
  useAcceptSuggestion: () => ({ mutate: acceptMutate, isPending: pending.accept }),
  useDeclineSuggestion: () => ({ mutate: declineMutate, isPending: pending.decline }),
}));

function item(overrides: Partial<MyWorkRetroActionItem> = {}): MyWorkRetroActionItem {
  return {
    suggestion_state: 'suggested',
    suggestion_id: 'sg1',
    task_id: 'task-1111-2222',
    task_status: 'NOT_STARTED',
    task_short_id: 'RIV-07',
    text: 'Write the runbook',
    from_retro_id: 'r1',
    from_sprint_id: 's1',
    from_sprint_short_id: 'S3',
    suggested_by_id: 7,
    suggested_by_username: 'alex',
    reason: 'you own the deploy',
    age_days: 2,
    story_points: null,
    ...overrides,
  };
}

beforeEach(() => {
  acceptMutate.mockReset();
  declineMutate.mockReset();
  pending.accept = false;
  pending.decline = false;
});

describe('MyWorkRetroSection', () => {
  it('renders nothing when there are no items', () => {
    const { container } = render(<MyWorkRetroSection items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists suggestions with their provenance line and wires Accept / Decline', async () => {
    const user = userEvent.setup();
    render(<MyWorkRetroSection items={[item()]} />);

    expect(screen.getByRole('heading', { name: 'From retros' })).toBeInTheDocument();
    expect(screen.getByText(/Suggested for you/)).toHaveTextContent('1');
    expect(screen.getByText('Write the runbook')).toBeInTheDocument();
    expect(screen.getByText(/Sprint S3 retro/)).toHaveTextContent('from alex — you own the deploy');

    await user.click(screen.getByRole('button', { name: 'Accept' }));
    expect(acceptMutate).toHaveBeenCalledWith({ taskId: 'task-1111-2222', suggestionId: 'sg1' });

    await user.click(screen.getByRole('button', { name: 'Decline' }));
    expect(declineMutate).toHaveBeenCalledWith({ taskId: 'task-1111-2222', suggestionId: 'sg1' });
  });

  it('falls back to "retro" and "(unknown)" when the sprint id and suggester are missing', () => {
    render(
      <MyWorkRetroSection
        items={[item({ from_sprint_short_id: null, suggested_by_username: null, reason: '' })]}
      />,
    );
    const line = screen.getByText(/from \(unknown\)/);
    expect(line.textContent).toMatch(/^retro ·/);
    expect(line.textContent).not.toContain('—');
  });

  it('skips a suggested row that carries no suggestion id', () => {
    render(<MyWorkRetroSection items={[item({ suggestion_id: null })]} />);
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('disables the action buttons while a mutation is pending', () => {
    pending.accept = true;
    pending.decline = true;
    render(<MyWorkRetroSection items={[item()]} />);
    expect(screen.getByRole('button', { name: 'Accept' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled();
  });

  it('renders owned items with the short id, or a slice of the task id when none', () => {
    render(
      <MyWorkRetroSection
        items={[
          item({ suggestion_state: 'owned', suggestion_id: null, task_status: 'IN_PROGRESS' }),
          item({
            suggestion_state: 'owned',
            suggestion_id: null,
            task_id: 'zzzzzz-9999',
            task_short_id: null,
            text: 'Trim the standup',
            from_sprint_short_id: null,
          }),
        ]}
      />,
    );
    expect(screen.getByText(/^Owned/)).toHaveTextContent('2');
    expect(screen.queryByText(/Suggested for you/)).toBeNull();
    expect(screen.getByText('T-RIV-07')).toBeInTheDocument();
    expect(screen.getByText('T-zzzzzz')).toBeInTheDocument();
    expect(screen.getByText('IN_PROGRESS')).toBeInTheDocument();
    expect(screen.getByText('retro')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
