import { describe, expect, it } from 'vitest';
import {
  LINK_TYPES,
  LINK_TYPE_DIRECTIONAL_LABEL,
  LINK_TYPE_HELP,
  describeLink,
  linkTypeOptionsFor,
} from './linkTypes';

describe('linkTypeOptionsFor', () => {
  it('keeps the canonical order in both directions', () => {
    // Order is load-bearing elsewhere (`depFlag` sorts by it, `⌥→` cycles it).
    for (const direction of ['successor', 'predecessor'] as const) {
      expect(linkTypeOptionsFor(direction).map((o) => o.value)).toEqual([...LINK_TYPES]);
    }
  });

  it('words every type differently in the two directions', () => {
    // The whole point of #3113: "Finish → Start" means opposite things on the
    // two sides, and the old direction-blind labels said neither. If any pair
    // ever matches, a planner is back to guessing which reading is live.
    for (const t of LINK_TYPES) {
      expect(LINK_TYPE_DIRECTIONAL_LABEL.successor[t]).not.toBe(
        LINK_TYPE_DIRECTIONAL_LABEL.predecessor[t],
      );
    }
  });

  it('has a help entry for every type, so the ? can never be partial', () => {
    expect(LINK_TYPE_HELP.map((h) => h.type)).toEqual([...LINK_TYPES]);
  });
});

describe('describeLink', () => {
  const base = { sourceName: 'Foundation', pickedName: 'Framing', lag: 0 } as const;

  it('puts the source first when it is the predecessor', () => {
    expect(describeLink({ ...base, direction: 'successor', type: 'FS' })).toBe(
      '“Foundation” must finish before “Framing” starts.',
    );
  });

  it('reverses the roles when the picked task is the predecessor', () => {
    // Same two names, same type, opposite sentence — this is the ambiguity the
    // arrow labels could not express.
    expect(describeLink({ ...base, direction: 'predecessor', type: 'FS' })).toBe(
      '“Framing” must finish before “Foundation” starts.',
    );
  });

  it.each([
    ['SS', '“Foundation” must start before “Framing” starts.'],
    ['FF', '“Foundation” must finish before “Framing” finishes.'],
    ['SF', '“Foundation” must start before “Framing” finishes.'],
  ] as const)('states %s in plain language', (type, expected) => {
    expect(describeLink({ ...base, direction: 'successor', type })).toBe(expected);
  });

  it('names the gap rather than vanishing before a row is picked', () => {
    // A summary that disappears exactly while the user is deciding is one
    // nobody reads — and direction and type are both set before the pick.
    expect(
      describeLink({ ...base, pickedName: null, direction: 'successor', type: 'FS' }),
    ).toBe('“Foundation” must finish before the task you pick starts.');
  });

  it('reads a positive lag as a wait and a negative one as an overlap', () => {
    expect(describeLink({ ...base, direction: 'successor', type: 'FS', lag: 3 })).toBe(
      '“Foundation” must finish before “Framing” starts, plus 3 days.',
    );
    expect(describeLink({ ...base, direction: 'successor', type: 'FS', lag: -2 })).toBe(
      '“Foundation” must finish before “Framing” starts, overlapping by 2 days.',
    );
  });

  it('singularizes one day', () => {
    expect(describeLink({ ...base, direction: 'successor', type: 'FS', lag: 1 })).toContain(
      'plus 1 day.',
    );
  });
});
