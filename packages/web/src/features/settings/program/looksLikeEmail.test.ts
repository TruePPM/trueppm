import { describe, expect, it } from 'vitest';
import { looksLikeEmail } from './StakeholderEditRow';

describe('looksLikeEmail (#2566)', () => {
  it('accepts ordinary addresses', () => {
    expect(looksLikeEmail('dana@client.example')).toBe(true);
    expect(looksLikeEmail('dana.client+tag@mail.corp.example')).toBe(true);
    expect(looksLikeEmail("o'brien@sub.domain.co.uk")).toBe(true);
  });

  it('rejects the shapes that cannot possibly be an address', () => {
    expect(looksLikeEmail('nope')).toBe(false);
    expect(looksLikeEmail('dana@@nope')).toBe(false);
    expect(looksLikeEmail('dana@nodot')).toBe(false);
    expect(looksLikeEmail('@client.example')).toBe(false);
    expect(looksLikeEmail('dana@client.example ')).toBe(false);
    expect(looksLikeEmail('da na@client.example')).toBe(false);
    expect(looksLikeEmail('dana@client.')).toBe(false);
    expect(looksLikeEmail('dana@.example')).toBe(false);
  });

  // Behavior change from the pre-#2566 pattern: excluding `.` from the domain-label
  // classes is what makes the decomposition unambiguous, and it also means an empty
  // label no longer slips through. `b..c` is not a deliverable domain either way.
  it('rejects an empty domain label, which the old pattern accepted', () => {
    expect(looksLikeEmail('dana@client..example')).toBe(false);
  });

  // The S8786 shape: many dots, then a character that cannot end the address. With `.`
  // inside both label classes the engine tries every dot as the `\.` anchor and
  // backtracks the tail one character at a time from each — O(n²), which at this size
  // does not return. Linear, it is immediate.
  it('answers immediately on the input that made the old pattern super-linear', () => {
    expect(looksLikeEmail(`a@${'x.'.repeat(50_000)}@`)).toBe(false);
  });
});
