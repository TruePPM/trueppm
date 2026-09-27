import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileBacklogCard } from './MobileBacklogCard';
import type { BacklogItem } from '../../types';

function item(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: 'b1',
    programId: 'pg1',
    title: 'Migrate the billing export',
    itemType: 'feature',
    status: 'PROPOSED',
    tags: ['finance', 'q3', 'hidden-third'],
    priorityRank: 4,
    serverVersion: 1,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

const onSelect = vi.fn();
const onPull = vi.fn();

beforeEach(() => {
  onSelect.mockReset();
  onPull.mockReset();
});

function renderCard(overrides: Partial<BacklogItem> = {}, canEdit = true, query = '') {
  return render(
    <MobileBacklogCard
      item={item(overrides)}
      query={query}
      canEdit={canEdit}
      onSelect={onSelect}
      onPull={onPull}
    />,
  );
}

describe('MobileBacklogCard', () => {
  it('renders rank, title and the first two tags, and opens the item on tap', async () => {
    const user = userEvent.setup();
    renderCard();
    const card = screen.getByRole('button', { name: 'Migrate the billing export' });
    expect(card).toHaveTextContent('#4');
    expect(screen.getByText('finance')).toBeInTheDocument();
    expect(screen.getByText('q3')).toBeInTheDocument();
    expect(screen.queryByText('hidden-third')).toBeNull();
    await user.click(card);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('shows Pull for a proposed item the user can edit, and pulls without selecting', async () => {
    const user = userEvent.setup();
    renderCard();
    const pull = screen.getByRole('button', {
      name: 'Pull Migrate the billing export to a project',
    });
    await user.click(pull);
    expect(onPull).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('pulls from the keyboard on Enter and Space without bubbling to the card', async () => {
    const user = userEvent.setup();
    renderCard();
    const pull = screen.getByRole('button', { name: /^Pull / });
    pull.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onPull).toHaveBeenCalledTimes(2);
    expect(onSelect).not.toHaveBeenCalled();
    // An unrelated key does nothing.
    await user.keyboard('a');
    expect(onPull).toHaveBeenCalledTimes(2);
  });

  it('hides Pull for a viewer and for a non-proposed item', () => {
    renderCard({}, false);
    expect(screen.queryByRole('button', { name: /^Pull / })).toBeNull();
    renderCard({ status: 'ARCHIVED' }, true);
    expect(screen.queryByRole('button', { name: /^Pull / })).toBeNull();
  });

  it('renders the pulled-to line with the project name when present', () => {
    renderCard({
      status: 'PULLED',
      pulledTo: {
        taskId: 't1',
        at: new Date(Date.now() - 3_600_000).toISOString(),
        projectName: 'Atlas',
      },
    });
    const line = screen.getByText(/Atlas · /);
    expect(line).toHaveTextContent(/ago$/);
    expect(screen.queryByRole('button', { name: /^Pull / })).toBeNull();
  });

  it('renders the pulled-to line without a project prefix when the name is unknown', () => {
    renderCard({
      status: 'PULLED',
      pulledTo: { taskId: 't1', at: new Date(Date.now() - 3_600_000).toISOString() },
    });
    expect(screen.queryByText(/ · /)).toBeNull();
    expect(screen.getByText(/ago$/)).toBeInTheDocument();
  });
});
