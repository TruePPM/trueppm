import { describe, expect, it } from 'vitest';
import { isTypingInInput } from './useGlobalShortcut';

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
