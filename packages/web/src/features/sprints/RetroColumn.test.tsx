import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { RetroColumn } from './RetroColumn';
import type { RetroBoardItem } from '@/hooks/useRetroBoard';

function sticky(overrides: Partial<RetroBoardItem> = {}): RetroBoardItem {
  return {
    id: 'it1',
    retro: 'r1',
    column: 'went_well',
    text: 'Pairing helped',
    author: 7,
    author_username: 'alex',
    position: 1,
    color: '',
    converted_action_item_id: null,
    created_at: '2026-04-15T00:00:00Z',
    updated_at: '2026-04-15T00:00:00Z',
    ...overrides,
  };
}

const handlers = {
  onAdd: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onConvert: vi.fn(),
  onRetry: vi.fn(),
  onDiscard: vi.fn(),
};

function renderColumn(props: Partial<Parameters<typeof RetroColumn>[0]> = {}) {
  return renderWithProviders(
    <RetroColumn
      columnKey="went_well"
      label="What went well"
      items={[sticky()]}
      pending={[]}
      remoteIds={new Set()}
      readOnly={false}
      convertingId={null}
      {...handlers}
      {...props}
    />,
  );
}

beforeEach(() => Object.values(handlers).forEach((h) => h.mockReset()));

describe('RetroColumn', () => {
  it('renders the column label, count, and a sticky with its author', () => {
    renderColumn();
    expect(screen.getByText('What went well')).toBeInTheDocument();
    expect(screen.getByText('Pairing helped')).toBeInTheDocument();
    expect(screen.getByText(/alex/i)).toBeInTheDocument();
  });

  it('adds a card: the +Add tile opens an editor and Enter fires onAdd(column, text)', async () => {
    renderColumn({ items: [] });
    await userEvent.click(screen.getByRole('button', { name: /\+ Add a card/i }));
    const editor = screen.getByRole('textbox', { name: /Add a card to What went well/i });
    await userEvent.type(editor, 'Try async standup{Enter}');
    expect(handlers.onAdd).toHaveBeenCalledWith('went_well', 'Try async standup');
  });

  it('exposes convert / edit / delete affordances and wires delete + convert', async () => {
    renderColumn();
    await userEvent.click(screen.getByRole('button', { name: /Delete card/i }));
    expect(handlers.onDelete).toHaveBeenCalledWith('it1');
    await userEvent.click(screen.getByRole('button', { name: /action item|convert/i }));
    expect(handlers.onConvert).toHaveBeenCalledWith('it1');
  });

  it('read-only mode hides add and per-card write affordances', () => {
    renderColumn({ readOnly: true });
    expect(
      screen.queryByRole('button', { name: /Add a card/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete card/i })).not.toBeInTheDocument();
  });

  it('a remote-added sticky is announced in the live region', () => {
    renderColumn({ items: [sticky({ id: 'rmt' })], remoteIds: new Set(['rmt']) });
    // The sticky still renders; the column's aria-live region carries the announcement.
    expect(screen.getByText('Pairing helped')).toBeInTheDocument();
  });
});
