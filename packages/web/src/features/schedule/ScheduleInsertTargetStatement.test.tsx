import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  ScheduleInsertTargetStatement,
  INSERT_TARGET_STATEMENT_ID,
} from './ScheduleInsertTargetStatement';

describe('ScheduleInsertTargetStatement', () => {
  it('states where the insert lands for a named row', () => {
    render(
      <ScheduleInsertTargetStatement
        target={{ kind: 'after', taskId: 't-23', wbs: '2.3', landsAfterWbs: '2.3' }}
        hasEditRights
      />,
    );
    expect(screen.getByTestId('schedule-insert-target')).toHaveTextContent(
      '⏎ adds a row after 2.3 · same level',
    );
  });

  it('states that ⏎ saves, not inserts, while the row is unnamed', () => {
    render(
      <ScheduleInsertTargetStatement
        target={{ kind: 'unnamed', taskId: 't-24', wbs: '2.4' }}
        hasEditRights
      />,
    );
    expect(screen.getByTestId('schedule-insert-target')).toHaveTextContent(
      '⏎ saves 2.4 · name it to add the next',
    );
  });

  it('renders nothing with no selection rather than inventing a landing place', () => {
    const { container } = render(
      <ScheduleInsertTargetStatement target={{ kind: 'none' }} hasEditRights />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('is absent for a reader with no edit rights — not dimmed (web rule 302)', () => {
    const { container } = render(
      <ScheduleInsertTargetStatement
        target={{ kind: 'after', taskId: 't-23', wbs: '2.3', landsAfterWbs: '2.3' }}
        hasEditRights={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('schedule-insert-target')).not.toBeInTheDocument();
  });

  it('is readable to a screen reader at every width — sr-only, never display:none', () => {
    // The toolbar has no room to DRAW the sentence below lg, which is not a
    // reason to take the button's own description out of the accessibility
    // tree. `hidden` would do exactly that (rule 316).
    render(
      <ScheduleInsertTargetStatement
        target={{ kind: 'after', taskId: 't-23', wbs: '2.3', landsAfterWbs: '2.3' }}
        hasEditRights
      />,
    );
    const el = screen.getByTestId('schedule-insert-target');
    expect(el.className).not.toMatch(/\bhidden\b/);
    // The width floor that stops a `truncate` span collapsing to zero inside a
    // `flex-nowrap` toolbar — present but invisible is the failure mode.
    expect(el.className).toContain('min-w-[8rem]');
  });

  // Since #3076 the *width* decision belongs to the fit ladder, not to a `lg:`
  // breakpoint — a viewport cannot see the rail being collapsed, the user's
  // pins, or whether this reader may author at all. What did NOT change is the
  // thing this file exists to hold: the sentence never leaves the accessibility
  // tree, whatever the ladder does to its ink.
  it('renders the FULL sentence sr-only once its ink is rationed away', () => {
    render(
      <ScheduleInsertTargetStatement
        target={{ kind: 'after', taskId: 't-23', wbs: '2.3', landsAfterWbs: '2.3' }}
        hasEditRights
        density="none"
      />,
    );
    const el = screen.getByTestId('schedule-insert-target');
    expect(el.className).toContain('sr-only');
    expect(el.className).not.toMatch(/\bhidden\b/);
    // Complete, not shortened: `+ Item` points `aria-describedby` here, so a
    // sentence that got quieter with the window would take the button's own
    // description with it.
    expect(el).toHaveTextContent('⏎ adds a row after 2.3 · same level');
  });

  it('keeps the full sentence readable to AT while DRAWING the short form', () => {
    render(
      <ScheduleInsertTargetStatement
        target={{ kind: 'after', taskId: 't-23', wbs: '2.3', landsAfterWbs: '2.3' }}
        hasEditRights
        density="short"
      />,
    );
    const el = screen.getByTestId('schedule-insert-target');
    // Drawn: the short form, hidden from AT so one claim is not read twice.
    const drawn = el.querySelector('[aria-hidden="true"]');
    expect(drawn).toHaveTextContent('after 2.3');
    // Spoken: the whole sentence, as real text — an `aria-label` on a bare
    // `<span>` produces no accessible name at all (generics are
    // name-prohibited), so this must be an `sr-only` node, not an attribute.
    const spoken = el.querySelector('.sr-only');
    expect(spoken).toHaveTextContent('⏎ adds a row after 2.3 · same level');
  });

  // #3134 `T5`. The two tests above each pin ONE density, which is how the
  // property they were protecting stayed true by coincidence: `full` had no
  // split at all and got away with it only because the drawn string and the
  // described string happened to be the same one. These two assert the property
  // itself — across every density the ladder can produce, in one comparison —
  // so a fourth rung that draws a third form fails here rather than shipping a
  // button whose description depends on the window.
  const DENSITIES = ['full', 'short', 'none'] as const;

  it("+ Item's accessible description is identical at every width (T5)", () => {
    const spoken = DENSITIES.map((density) => {
      const { unmount } = render(
        <ScheduleInsertTargetStatement
          target={{ kind: 'after', taskId: 't-23', wbs: '2.3', landsAfterWbs: '2.3' }}
          hasEditRights
          density={density}
        />,
      );
      const el = screen.getByTestId('schedule-insert-target');
      // What an AT client actually computes for `aria-describedby`: the text of
      // the referenced subtree with the `aria-hidden` parts removed. Reading
      // `textContent` instead would concatenate the drawn copy back in and pass
      // on markup that speaks the sentence twice.
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
      unmount();
      return (clone.textContent ?? '').trim();
    });

    expect(spoken[0]).toBe('⏎ adds a row after 2.3 · same level');
    expect(new Set(spoken).size).toBe(1);
  });

  it('draws exactly one copy of the claim, whatever the ladder left room for', () => {
    // The other half of the split. Without this a regression that dropped the
    // `aria-hidden` would still pass the description test above while showing
    // the sentence twice — and rule 171's point is that both halves are one
    // rule, not two.
    for (const density of DENSITIES) {
      const { unmount } = render(
        <ScheduleInsertTargetStatement
          target={{ kind: 'after', taskId: 't-23', wbs: '2.3', landsAfterWbs: '2.3' }}
          hasEditRights
          density={density}
        />,
      );
      const el = screen.getByTestId('schedule-insert-target');
      const drawn = Array.from(el.querySelectorAll('[aria-hidden="true"]'));
      // `none` is the rung where the ink runs out entirely — nothing drawn, the
      // description still there. Every other density draws exactly one copy.
      expect(drawn).toHaveLength(density === 'none' ? 0 : 1);
      // At `none` the whole element IS the sr-only node — there is no ink left
      // to hide from, so the split has one half rather than two.
      const spoken = density === 'none' ? el : el.querySelector('.sr-only');
      expect(spoken).toHaveTextContent('⏎ adds a row after 2.3 · same level');
      unmount();
    }
  });

  it('is the element the toolbar button describes itself with', () => {
    render(
      <ScheduleInsertTargetStatement
        target={{ kind: 'after', taskId: 't-23', wbs: '2.3', landsAfterWbs: '2.3' }}
        hasEditRights
      />,
    );
    expect(screen.getByTestId('schedule-insert-target')).toHaveAttribute(
      'id',
      INSERT_TARGET_STATEMENT_ID,
    );
  });

  it('carries no live-region semantics — it changes on every row move', () => {
    render(
      <ScheduleInsertTargetStatement
        target={{ kind: 'after', taskId: 't-23', wbs: '2.3', landsAfterWbs: '2.3' }}
        hasEditRights
      />,
    );
    const el = screen.getByTestId('schedule-insert-target');
    expect(el).not.toHaveAttribute('aria-live');
    expect(el).not.toHaveAttribute('role');
  });
});
