import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { MoreMenu } from './ContextHeader2';
import type { ContextTabsModel } from './contextTabs';

/**
 * The More menu seats focus inside the menu on the SAME commit that opens it, so a key
 * typed straight after Enter reaches the menu. A deferred `setTimeout(0)` focus left the
 * trigger focused for one task and dropped that key (#3715 soak: Enter, End landed on
 * the first item). These tests dispatch with `fireEvent`, which runs no timers between
 * the open and the next key, so a deferred focus fails them.
 */

const model: ContextTabsModel = {
  tabs: [],
  more: [
    { view: 'today', label: 'Today', to: '/projects/ATL/today', active: false },
    { view: 'risk', label: 'Risk', to: '/projects/ATL/risk', active: false },
  ],
  hidden: [],
  off: [{ view: 'assets', label: 'Assets', to: '/projects/ATL/assets', active: false }],
};

function renderMenu() {
  render(
    <MemoryRouter>
      <MoreMenu model={model} onCustomize={vi.fn()} />
    </MemoryRouter>,
  );
  return screen.getByRole('button', { name: 'More' });
}

describe('MoreMenu focus', () => {
  it('moves focus to the first item synchronously when it opens', () => {
    fireEvent.click(renderMenu());
    expect(screen.getByRole('menuitem', { name: 'Today' })).toHaveFocus();
  });

  it('handles a key typed straight after opening (Enter, End)', () => {
    fireEvent.click(renderMenu());
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(screen.getByRole('menuitem', { name: 'Customize views…' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' });
    const off = screen.getByRole('menuitem', { name: /Assets is off/ });
    expect(off).toHaveFocus();
    expect(off).toHaveAttribute('aria-disabled', 'true');
  });

  it('opens from ArrowDown on the closed trigger and focuses the first item', () => {
    fireEvent.keyDown(renderMenu(), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Today' })).toHaveFocus();
  });
});
