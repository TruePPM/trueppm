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
    expect(el.className).toContain('sr-only');
    expect(el.className).toContain('lg:not-sr-only');
    // The width floor that stops a `truncate` span collapsing to zero inside a
    // `flex-nowrap` toolbar — present but invisible is the failure mode.
    expect(el.className).toContain('lg:min-w-[8rem]');
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
