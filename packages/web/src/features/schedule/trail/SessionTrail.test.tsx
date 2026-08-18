import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { SessionTrail } from './SessionTrail';
import { useTrailStore } from './trailStore';

describe('SessionTrail', () => {
  beforeEach(() => useTrailStore.getState().clear());
  afterEach(cleanup);

  it('renders nothing when no structural act has happened', () => {
    // A viewer, or anyone who has only scrolled, must not see an empty panel.
    const { container } = render(<SessionTrail />);
    expect(container).toBeEmptyDOMElement();
  });

  it('carries the count in the accessible name, not just the visible text', () => {
    useTrailStore.getState().record('p1', 'Permits indented under Mobilization.');
    render(<SessionTrail />);
    expect(
      screen.getByRole('button', { name: /1 structural change this session/i }),
    ).toBeInTheDocument();
  });

  it('pluralizes', () => {
    const { record } = useTrailStore.getState();
    record('p1', 'one');
    record('p1', 'two');
    render(<SessionTrail />);
    expect(screen.getByRole('button', { name: /2 structural changes/i })).toBeInTheDocument();
  });

  it('lists acts newest first', async () => {
    const user = userEvent.setup();
    const { record } = useTrailStore.getState();
    record('p1', 'older act');
    record('p1', 'newer act');
    render(<SessionTrail />);
    await user.click(screen.getByRole('button', { name: /2 structural changes/i }));
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toContain('newer act');
    expect(items[1]).toContain('older act');
  });

  it('says plainly that it is a record and not a way to reverse anything', async () => {
    // The honest half: there is no general structural undo in this tree, and an
    // Undo button here that silently did nothing would be worse than silence.
    const user = userEvent.setup();
    useTrailStore.getState().record('p1', 'Procurement deleted with 3 items under it.');
    render(<SessionTrail />);
    await user.click(screen.getByRole('button', { name: /1 structural change/i }));
    expect(screen.getByRole('dialog')).toHaveTextContent(/not a way to reverse it/i);
    expect(screen.queryByRole('button', { name: /^undo/i })).not.toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    useTrailStore.getState().record('p1', 'an act');
    render(<SessionTrail />);
    const trigger = screen.getByRole('button', { name: /1 structural change/i });
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
