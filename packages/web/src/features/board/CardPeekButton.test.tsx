/**
 * CardPeekButton — reusable coarse-pointer tap-to-peek disclosure (#1947,
 * web-rule 256). Verifies the extracted rule-253 mechanics: portal, toggle,
 * Escape/outside close semantics, focus return, and stopPropagation.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CardPeekButton } from './CardPeekButton';

function renderPeek(extra?: Partial<Parameters<typeof CardPeekButton>[0]>) {
  return render(
    <CardPeekButton
      ariaLabel="Blocked. What does this mean?"
      peekAriaLabel="Blocked — explanation"
      triggerContent={<span aria-hidden="true">⛔</span>}
      {...extra}
    >
      Blocked, 2 dependencies
    </CardPeekButton>,
  );
}

describe('CardPeekButton (#1947)', () => {
  it('renders a collapsed disclosure trigger — no popover until tapped', () => {
    renderPeek();
    const trigger = screen.getByRole('button', { name: /what does this mean/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('click toggles the popover open and closed', async () => {
    const user = userEvent.setup();
    renderPeek();
    const trigger = screen.getByRole('button', { name: /what does this mean/i });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('note')).toHaveTextContent('Blocked, 2 dependencies');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('portals the popover under document.body, not inside the trigger wrapper', async () => {
    const user = userEvent.setup();
    const { container } = renderPeek();
    await user.click(screen.getByRole('button', { name: /what does this mean/i }));
    const note = screen.getByRole('note');
    // The portaled note is not a descendant of the component's own subtree.
    expect(container.contains(note)).toBe(false);
    expect(document.body.contains(note)).toBe(true);
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderPeek();
    const trigger = screen.getByRole('button', { name: /what does this mean/i });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes on "Got it" and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderPeek();
    const trigger = screen.getByRole('button', { name: /what does this mean/i });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('honors a custom close label', async () => {
    const user = userEvent.setup();
    renderPeek({ closeLabel: 'Close' });
    await user.click(screen.getByRole('button', { name: /what does this mean/i }));
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('closes on outside pointerdown WITHOUT stealing focus', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">outside</button>
        <CardPeekButton
          ariaLabel="Blocked. What does this mean?"
          peekAriaLabel="Blocked — explanation"
          triggerContent={<span aria-hidden="true">⛔</span>}
        >
          Blocked, 2 dependencies
        </CardPeekButton>
      </div>,
    );
    const trigger = screen.getByRole('button', { name: /what does this mean/i });
    await user.click(trigger);
    const outside = screen.getByRole('button', { name: 'outside' });
    await user.click(outside);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    // Outside close does not yank focus back to the trigger.
    expect(trigger).not.toHaveFocus();
  });

  it('stops propagation so the host card onClick never fires', async () => {
    const user = userEvent.setup();
    const onParentClick = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
      <div onClick={onParentClick}>
        <CardPeekButton
          ariaLabel="Blocked. What does this mean?"
          peekAriaLabel="Blocked — explanation"
          triggerContent={<span aria-hidden="true">⛔</span>}
        >
          Blocked, 2 dependencies
        </CardPeekButton>
      </div>,
    );
    await user.click(screen.getByRole('button', { name: /what does this mean/i }));
    expect(onParentClick).not.toHaveBeenCalled();
    expect(screen.getByRole('note')).toBeInTheDocument();
  });

  it('uses a neutral popover surface — never a semantic tone (rule 253a)', async () => {
    const user = userEvent.setup();
    renderPeek({ triggerClassName: 'bg-semantic-critical-bg text-semantic-critical' });
    await user.click(screen.getByRole('button', { name: /what does this mean/i }));
    const note = screen.getByRole('note');
    expect(note.className).toContain('bg-neutral-surface-raised');
    expect(note.className).not.toContain('semantic-critical');
    expect(note.className).not.toContain('semantic-at-risk');
  });
});
