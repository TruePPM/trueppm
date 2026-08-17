import { describe, expect, it } from 'vitest';
import {
  claimUndoShortcut,
  isTypingInInput,
  isUndoShortcutClaimed,
} from './useGlobalShortcut';

/** Build an element, optionally nested inside a parent, and return the child. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

describe('isTypingInInput', () => {
  it('returns true for <input>, <textarea>, and <select>', () => {
    expect(isTypingInInput(el('input'))).toBe(true);
    expect(isTypingInInput(el('textarea'))).toBe(true);
    expect(isTypingInInput(el('select'))).toBe(true);
  });

  it('returns true for the contenteditable attribute in all valid forms', () => {
    expect(isTypingInInput(el('div', { contenteditable: 'true' }))).toBe(true);
    expect(isTypingInInput(el('div', { contenteditable: '' }))).toBe(true);
    expect(isTypingInInput(el('div', { contenteditable: 'plaintext-only' }))).toBe(true);
  });

  it('returns true when the live isContentEditable property is set', () => {
    // jsdom does not always flip isContentEditable from the attribute, so the
    // helper checks the live property independently. Force it here to exercise
    // that branch without relying on jsdom reflection.
    const div = el('div');
    Object.defineProperty(div, 'isContentEditable', { value: true, configurable: true });
    expect(isTypingInInput(div)).toBe(true);
  });

  it('returns true for an element inside an ARIA combobox', () => {
    const combobox = el('div', { role: 'combobox' });
    const inner = el('span');
    combobox.appendChild(inner);
    expect(isTypingInInput(combobox)).toBe(true);
    expect(isTypingInInput(inner)).toBe(true);
  });

  it('returns false for non-editable elements', () => {
    expect(isTypingInInput(el('div'))).toBe(false);
    expect(isTypingInInput(el('button'))).toBe(false);
    expect(isTypingInInput(el('div', { contenteditable: 'false' }))).toBe(false);
  });

  it('returns false for null and non-HTMLElement targets', () => {
    expect(isTypingInInput(null)).toBe(false);
    expect(isTypingInInput(document)).toBe(false);
    expect(isTypingInInput(window)).toBe(false);
  });
});

/**
 * ⌘Z arbitration (#2892). Three surfaces on the Schedule view bind ⌘Z to a
 * *different* destructive undo and are independently mountable siblings, so
 * without a claim one keypress ran two of them — reverting a template apply and a
 * CSV import at once. A per-component test cannot see that class: it mounts one
 * surface, and the collision needs two. This is the seam where it can be tested.
 */
describe('claimUndoShortcut', () => {
  it('is unclaimed by default, so an outer handler runs', () => {
    expect(isUndoShortcutClaimed()).toBe(false);
  });

  it('reports a claim while a nearer surface holds it, and releases it', () => {
    const release = claimUndoShortcut();
    expect(isUndoShortcutClaimed()).toBe(true);
    release();
    expect(isUndoShortcutClaimed()).toBe(false);
  });

  it('nests — an outer handler stays yielded until the last claim releases', () => {
    const first = claimUndoShortcut();
    const second = claimUndoShortcut();
    first();
    expect(isUndoShortcutClaimed()).toBe(true);
    second();
    expect(isUndoShortcutClaimed()).toBe(false);
  });

  it('is idempotent per release, so a double cleanup cannot unclaim a live holder', () => {
    // React can invoke an effect cleanup more than once; without the guard the
    // counter would go negative and a genuinely-claimed chord would read as free.
    const live = claimUndoShortcut();
    const stale = claimUndoShortcut();
    stale();
    stale();
    stale();
    expect(isUndoShortcutClaimed()).toBe(true);
    live();
    expect(isUndoShortcutClaimed()).toBe(false);
  });

  it('never goes negative', () => {
    const release = claimUndoShortcut();
    release();
    release();
    expect(isUndoShortcutClaimed()).toBe(false);
    const next = claimUndoShortcut();
    expect(isUndoShortcutClaimed()).toBe(true);
    next();
  });
});
