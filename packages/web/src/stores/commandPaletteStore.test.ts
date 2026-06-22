/**
 * Tests for the ⌘K command-palette open/close store (v2 design system; #784).
 *
 * Multiple triggers (global hotkey, context-bar search, the v2 rail) all drive
 * this single overlay state, so toggle/setOpen must behave predictably from any
 * starting point — a sticky `open` flag would trap the palette on screen.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { useCommandPaletteStore } from './commandPaletteStore';

describe('useCommandPaletteStore', () => {
  beforeEach(() => {
    useCommandPaletteStore.getState().setOpen(false);
  });

  it('starts closed', () => {
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it('setOpen drives the flag directly', () => {
    useCommandPaletteStore.getState().setOpen(true);
    expect(useCommandPaletteStore.getState().open).toBe(true);
    useCommandPaletteStore.getState().setOpen(false);
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it('toggle flips from closed to open and back', () => {
    useCommandPaletteStore.getState().toggle();
    expect(useCommandPaletteStore.getState().open).toBe(true);
    useCommandPaletteStore.getState().toggle();
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });
});
