/**
 * The merged mode control (#3263).
 *
 * These are the properties the merge is *for*: one control answering "am I
 * allowed to edit this", stating the answer without being opened, and carrying
 * the retired `BuildModePill`'s way in to the cheatsheet.
 */
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { formatChord } from '@/lib/platform';
import { ScheduleModeChip } from './ScheduleModeChip';

afterEach(cleanup);

function renderChip(mode: 'read' | 'author' = 'author') {
  const onToggleMode = vi.fn();
  const onShowCheatsheet = vi.fn();
  render(
    <ScheduleModeChip
      mode={mode}
      onToggleMode={onToggleMode}
      onShowCheatsheet={onShowCheatsheet}
    />,
  );
  return { onToggleMode, onShowCheatsheet };
}

describe('ScheduleModeChip', () => {
  it('states the mode on the trigger, without being opened', () => {
    renderChip('author');
    expect(screen.getByTestId('schedule-mode-chip')).toHaveTextContent('Author');
    cleanup();
    renderChip('read');
    expect(screen.getByTestId('schedule-mode-chip')).toHaveTextContent('Read');
  });

  it('names the consequence and the chord, not just the state', () => {
    // "Read" alone does not tell a screen-reader user that their edits are
    // blocked, and Alt+A is the one-keystroke way out that the pointer path
    // costs two clicks.
    renderChip('read');
    expect(screen.getByTestId('schedule-mode-chip')).toHaveAccessibleName(
      'Mode: Read — edits are blocked. Alt+A switches to Author.',
    );
  });

  it('says nothing about build mode (#3263)', () => {
    // The half of the old value that could never change. `buildModeActive` is
    // `!isMobile` wherever this renders, so "Build off" was unreachable text
    // presenting a constant as a mode the user had chosen.
    renderChip('author');
    expect(screen.getByTestId('schedule-mode-chip')).not.toHaveTextContent(/Build/);
  });

  it('toggles the mode from a checkbox that carries the current answer', async () => {
    const user = userEvent.setup();
    const { onToggleMode } = renderChip('author');
    await user.click(screen.getByTestId('schedule-mode-chip'));
    const item = screen.getByRole('menuitemcheckbox', { name: /Author mode/ });
    expect(item).toHaveAttribute('aria-checked', 'true');
    expect(item).toHaveAttribute('aria-keyshortcuts', 'Alt+A');
    await user.click(item);
    expect(onToggleMode).toHaveBeenCalledTimes(1);
  });

  it('closes the popover on the toggle — two interactions, not three', async () => {
    // The whole trade #3263 accepts is one extra click on a per-session posture.
    // A popover that stays open makes it two extra AND leaves the trigger — whose
    // value just changed — covered by the thing that changed it.
    const user = userEvent.setup();
    renderChip('author');
    await user.click(screen.getByTestId('schedule-mode-chip'));
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Author mode/ }));
    expect(screen.queryByRole('menuitemcheckbox', { name: /Author mode/ })).toBeNull();
  });

  it('carries the chord on the trigger, and derives it rather than spelling it', () => {
    // Rule 343(f): a control keeps its name AND its `aria-keyshortcuts`. On a
    // value-bearing trigger the chord would otherwise live only on a row inside
    // the popover — undiscoverable from the control itself.
    //
    // And rules 326(b)/339(b): a hard-coded "Alt+A" in the accessible name would
    // have a Mac user HEAR "Alt+A" while READING "⌥A" from the menu row, for one
    // binding. Asserted against `formatChord`, not a literal, so the test cannot
    // pass on a platform where the product is wrong.
    renderChip('read');
    const trigger = screen.getByTestId('schedule-mode-chip');
    expect(trigger).toHaveAttribute('aria-keyshortcuts', 'Alt+A');
    expect(trigger.getAttribute('aria-label')).toContain(formatChord('alt+a'));
  });

  it('is the way in to the cheatsheet — the retired BuildModePill’s only act', async () => {
    const user = userEvent.setup();
    const { onShowCheatsheet } = renderChip('author');
    await user.click(screen.getByTestId('schedule-mode-chip'));
    await user.click(screen.getByRole('menuitem', { name: /Keyboard shortcuts/ }));
    expect(onShowCheatsheet).toHaveBeenCalledTimes(1);
  });
});
