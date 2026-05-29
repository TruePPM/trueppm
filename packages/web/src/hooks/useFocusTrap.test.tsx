import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useFocusTrap } from './useFocusTrap';

afterEach(cleanup);

function Trap({ active, onEscape }: { active: boolean; onEscape?: () => void }) {
  const ref = useFocusTrap<HTMLDivElement>(active, onEscape);
  return (
    <div>
      <button type="button">outside-before</button>
      <div ref={ref} tabIndex={-1} data-testid="trap">
        <button type="button">first</button>
        <button type="button">last</button>
      </div>
    </div>
  );
}

describe('useFocusTrap', () => {
  it('focuses the first focusable element when activated', () => {
    render(<Trap active />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'first' }));
  });

  it('wraps Tab from the last focusable back to the first', () => {
    render(<Trap active />);
    const last = screen.getByRole('button', { name: 'last' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'first' }));
  });

  it('wraps Shift+Tab from the first focusable to the last', () => {
    render(<Trap active />);
    const first = screen.getByRole('button', { name: 'first' });
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'last' }));
  });

  it('invokes onEscape when Escape is pressed', () => {
    let escaped = false;
    render(<Trap active onEscape={() => (escaped = true)} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(escaped).toBe(true);
  });

  it('does nothing when inactive', () => {
    const before = screen.queryByRole('button', { name: 'outside-before' });
    render(<Trap active={false} />);
    // No focusable was force-focused by the trap.
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'first' }));
    expect(before).toBeNull();
  });
});
