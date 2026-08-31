import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  ROW_HEIGHT_COARSE,
  ROW_HEIGHT_FINE,
  UNIT_SEGMENT_SIZE_COARSE,
  UNIT_SEGMENT_SIZE_FINE,
  resolveUnitSegmentSize,
} from '../scheduleConstants';
import { DurationUnitPicker } from './DurationUnitPicker';

describe('DurationUnitPicker', () => {
  afterEach(cleanup);

  it('exposes a radiogroup with a full word per option, not a bare glyph', () => {
    // "d" announced on its own tells a screen reader user nothing.
    render(<DurationUnitPicker value="days" onChange={() => {}} />);
    expect(screen.getByRole('radiogroup', { name: 'Duration unit' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Days' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Hours' })).not.toBeChecked();
  });

  it('selects on click', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DurationUnitPicker value="days" onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: 'Hours' }));
    expect(onChange).toHaveBeenCalledWith('hours');
  });

  it('moves between options with arrow keys — the radiogroup contract', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DurationUnitPicker value="days" onChange={onChange} />);
    screen.getByRole('radio', { name: 'Days' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('hours');
  });

  it('wraps around rather than dead-ending at the edge', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DurationUnitPicker value="days" onChange={onChange} />);
    screen.getByRole('radio', { name: 'Days' }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenCalledWith('hours');
  });

  it('keeps only the selected option in the tab order', () => {
    render(<DurationUnitPicker value="hours" onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: 'Hours' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Days' })).toHaveAttribute('tabindex', '-1');
  });

  it('disables both options together', () => {
    render(<DurationUnitPicker value="days" onChange={() => {}} disabled />);
    expect(screen.getByRole('radio', { name: 'Days' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Hours' })).toBeDisabled();
  });
});

/**
 * #3212 — the segment size, MECHANISM only.
 *
 * jsdom computes no layout: `getBoundingClientRect()` is 0x0 for everything here
 * and `getComputedStyle().width` echoes back the literal `var(--unit-segment-size)`
 * without resolving it. So nothing in this file can assert that a radio *is*
 * 44px, and a test that appeared to would be asserting the source string back at
 * itself. What these pin is the wiring that makes the browser assertion possible:
 * the property is emitted, it carries the resolved number, and the class reads
 * that property rather than a baked-in literal. The measurement is in
 * `e2e/duration-drawer-edit.spec.ts` (web rule 330(c)).
 */
describe('DurationUnitPicker segment sizing (#3212)', () => {
  afterEach(cleanup);

  it('takes its sizes FROM the row-height owner rather than repeating 28 and 44', () => {
    // Identity, not equality-by-value. Two literals that happen to match are the
    // arrangement web rule 315 exists to forbid — they agree until one moves,
    // and a control that stopped growing with the touch floor looks fine in
    // every screenshot.
    expect(UNIT_SEGMENT_SIZE_FINE).toBe(ROW_HEIGHT_FINE);
    expect(UNIT_SEGMENT_SIZE_COARSE).toBe(ROW_HEIGHT_COARSE);
    expect(resolveUnitSegmentSize(true)).toBeGreaterThanOrEqual(44);
    expect(resolveUnitSegmentSize(false)).toBe(UNIT_SEGMENT_SIZE_FINE);
  });

  it('emits the resolved size as a custom property on the group', () => {
    render(<DurationUnitPicker value="days" onChange={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: 'Duration unit' });
    // jsdom's matchMedia stub answers `(pointer: coarse)` with false, so this is
    // the fine-pointer resolution — the value is asserted through the resolver
    // rather than as `'28px'`, so the test cannot outlive a change to the owner.
    expect(group.style.getPropertyValue('--unit-segment-size')).toBe(
      `${resolveUnitSegmentSize(false)}px`,
    );
  });

  it('sizes both radios from that property, in both axes, with no literal left', () => {
    render(<DurationUnitPicker value="days" onChange={() => {}} />);
    for (const name of ['Days', 'Hours']) {
      const radio = screen.getByRole('radio', { name });
      expect(radio.className).toContain('w-[var(--unit-segment-size)]');
      expect(radio.className).toContain('h-[var(--unit-segment-size)]');
      // The regression this guards: somebody "simplifying" the arbitrary value
      // back to a static class. A Tailwind class is fixed at build time, so a
      // literal here is a module-scope capture of a runtime value (rule 315(b))
      // and the control silently stops following the pointer class again.
      expect(radio.className).not.toMatch(/\b[hw]-\d/);
    }
  });

  it('does not size the radios by stretching them inside the group', () => {
    // Rule 330(a) / rule 315's `inset-y-0` corollary: the group carries a 1px
    // border inside its own border box, so a stretched child measures
    // `size - 2` — 42px against a 44px floor, which no jsdom assertion can see.
    render(<DurationUnitPicker value="days" onChange={() => {}} />);
    for (const name of ['Days', 'Hours']) {
      const radio = screen.getByRole('radio', { name });
      expect(radio.className).not.toMatch(/inset-y-0|self-stretch|h-full/);
    }
  });
});
