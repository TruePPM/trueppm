import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { MethodologyFlipWarningDialog, type FlipImpact } from './MethodologyFlipWarningDialog';
import { iterationLabelForms } from '@/lib/iterationLabel';
import { hiddenViewsForMethodology } from '@/features/shell/methodologyTabs';
import { VIEW_TAB_META } from '@/features/shell/viewMeta';

/**
 * The dialog's own spec (#3294). It had none: every assertion about its copy
 * lived in `ProjectMethodologyPage.test.tsx`, which reaches it through a save
 * flow — so the pluralization, the unknown-count branch and the view names it
 * renders were only ever exercised for the one combination that page test set
 * up. The composition rules are this component's, and are tested here.
 */

const SPRINT = iterationLabelForms('Sprint');
const PI = iterationLabelForms('PI');

function renderDialog(
  props: Partial<ComponentProps<typeof MethodologyFlipWarningDialog>> = {},
) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  const utils = render(
    <MethodologyFlipWarningDialog
      target="WATERFALL"
      impacts={[{ kind: 'sprints', count: 2 }]}
      itl={SPRINT}
      pending={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { ...utils, onCancel, onConfirm };
}

function body(): HTMLElement {
  const dialog = screen.getByRole('alertdialog');
  const paragraph = within(dialog).getByText(/hides the/);
  return paragraph;
}

describe('MethodologyFlipWarningDialog', () => {
  // The dialog looks its view names up in VIEW_TAB_META and falls back to the raw
  // route key. That fallback would print `product-backlog` as user-facing copy, so
  // it must stay unreachable: every key the matrix hides needs a label. This is the
  // tripwire for a fifth entry added to HIDDEN_FOR_METHODOLOGY.
  it('has a display label for every view the matrix hides', () => {
    for (const methodology of ['WATERFALL', 'AGILE', 'HYBRID'] as const) {
      for (const view of hiddenViewsForMethodology(methodology)) {
        expect(VIEW_TAB_META[view]?.label).toBeTruthy();
      }
    }
  });

  describe('what the flip hides', () => {
    it('names the two views WATERFALL hides, from the methodology matrix', () => {
      renderDialog();
      expect(
        screen.getByRole('heading', { name: 'Switch to Waterfall?', level: 2 }),
      ).toBeInTheDocument();
      expect(body()).toHaveTextContent('Waterfall hides the Sprints and Backlog views from the nav');
    });

    it('names the two views AGILE hides', () => {
      renderDialog({ target: 'AGILE', impacts: [{ kind: 'tasks', count: 5 }] });
      expect(
        screen.getByRole('heading', { name: 'Switch to Agile?', level: 2 }),
      ).toBeInTheDocument();
      expect(body()).toHaveTextContent('Agile hides the Schedule and Calendar views from the nav');
    });

    it('keeps the not-deleted / still-reachable frame on both targets', () => {
      const { unmount } = renderDialog();
      expect(body()).toHaveTextContent(
        /nothing is deleted and they stay reachable by direct URL, but no one will see them from the sidebar/,
      );
      unmount();
      renderDialog({ target: 'AGILE', impacts: [{ kind: 'dependencies', count: 1 }] });
      expect(body()).toHaveTextContent(
        /nothing is deleted and they stay reachable by direct URL, but no one will see them from the sidebar/,
      );
    });

    it('substitutes the configured iteration term for the sprints view', () => {
      renderDialog({ itl: PI, impacts: [{ kind: 'sprints', count: 3 }] });
      // Both the count clause and the view name follow the workspace's term —
      // a Program Increment shop is never told it has committed "sprints".
      expect(body()).toHaveTextContent('This project has 3 PIs already committed.');
      expect(body()).toHaveTextContent('hides the PIs and Backlog views');
    });
  });

  describe('naming the counts', () => {
    it.each<[FlipImpact, string]>([
      [{ kind: 'sprints', count: 1 }, 'This project has 1 sprint already committed.'],
      [{ kind: 'sprints', count: 4 }, 'This project has 4 sprints already committed.'],
      [{ kind: 'backlog', count: 1 }, 'This project has 1 item in the product backlog.'],
      [{ kind: 'backlog', count: 180 }, 'This project has 180 items in the product backlog.'],
      [{ kind: 'tasks', count: 1 }, 'This project has 1 task on the schedule.'],
      [{ kind: 'tasks', count: 64 }, 'This project has 64 tasks on the schedule.'],
      [{ kind: 'dependencies', count: 1 }, 'This project has 1 dependency link.'],
      [{ kind: 'dependencies', count: 17 }, 'This project has 17 dependency links.'],
    ])('renders %o as its singular/plural clause', (impact, expected) => {
      renderDialog({
        target: impact.kind === 'sprints' || impact.kind === 'backlog' ? 'WATERFALL' : 'AGILE',
        impacts: [impact],
      });
      expect(body()).toHaveTextContent(expected);
    });

    it('joins two counts into one sentence', () => {
      renderDialog({
        impacts: [
          { kind: 'sprints', count: 3 },
          { kind: 'backlog', count: 42 },
        ],
      });
      expect(body()).toHaveTextContent(
        'This project has 3 sprints already committed and 42 items in the product backlog.',
      );
    });
  });

  describe('a count that could not be read', () => {
    // A failed read is "cannot rule it out", not "none" (#3313). The dialog still
    // warns — the safe direction — but must not print a number it cannot stand
    // behind, and must not imply zero either.
    it('says the number is unknown rather than printing one', () => {
      renderDialog({ impacts: [{ kind: 'backlog', count: null }] });
      expect(body()).toHaveTextContent(
        'This project may have items in the product backlog. That read failed, so the number could not be checked.',
      );
      expect(body()).not.toHaveTextContent('This project has');
    });

    it('agrees in number when two reads failed', () => {
      // Two separate queries failed, so two numbers are unknown. The singular
      // "That read failed … the number" was a sentence about one of them.
      renderDialog({
        impacts: [
          { kind: 'sprints', count: null },
          { kind: 'backlog', count: null },
        ],
      });
      expect(body()).toHaveTextContent(
        'This project may have sprints already committed and items in the product backlog. Those reads failed, so the numbers could not be checked.',
      );
    });

    it('mixes a known count with an unknown one', () => {
      renderDialog({
        impacts: [
          { kind: 'sprints', count: 4 },
          { kind: 'backlog', count: null },
        ],
      });
      expect(body()).toHaveTextContent('This project has 4 sprints already committed.');
      expect(body()).toHaveTextContent(
        'This project may also have items in the product backlog. That read failed',
      );
    });
  });

  describe('the confirm phase', () => {
    it('labels the confirm button for the target and reports both answers', async () => {
      const user = userEvent.setup();
      const { onCancel, onConfirm } = renderDialog({
        target: 'AGILE',
        impacts: [{ kind: 'tasks', count: 5 }],
      });
      const dialog = screen.getByRole('alertdialog');

      await user.click(within(dialog).getByRole('button', { name: 'Switch to Agile' }));
      expect(onConfirm).toHaveBeenCalledTimes(1);

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    // #3298 — `pending` is a phase, not a styling flag. Both controls go dead so
    // the flip cannot be re-fired or abandoned mid-write.
    it('disables both controls and announces progress while pending', () => {
      renderDialog({ pending: true });
      const dialog = screen.getByRole('alertdialog');
      expect(within(dialog).getByRole('button', { name: 'Switching…' })).toBeDisabled();
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
      // Focus stays inside the modal even with no focusable child (useFocusTrap
      // falls back to the container, which carries the label and description).
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby', 'methodology-flip-title');
      expect(dialog).toHaveAttribute('aria-describedby', 'methodology-flip-body');
    });

    // Re-seating focus re-announces the dialog's NAME and DESCRIPTION, and both
    // are otherwise unchanged across the phase swap — so without a sentence in
    // the described node the write starting is announced to nobody, while the
    // code looks like it handled announcement.
    it('writes the pending phase into the described node, not just the button', () => {
      const { rerender } = renderDialog({ impacts: [{ kind: 'sprints', count: 2 }] });
      expect(body()).not.toHaveTextContent('Switching to Waterfall now.');

      rerender(
        <MethodologyFlipWarningDialog
          target="WATERFALL"
          impacts={[{ kind: 'sprints', count: 2 }]}
          itl={SPRINT}
          pending
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );
      const described = document.getElementById('methodology-flip-body');
      expect(described).toHaveTextContent('Switching to Waterfall now.');
      // And it is the node aria-describedby actually points at.
      expect(screen.getByRole('alertdialog')).toHaveAttribute(
        'aria-describedby',
        'methodology-flip-body',
      );
    });

    it('does not cancel on a backdrop press while pending', async () => {
      const user = userEvent.setup();
      const { onCancel } = renderDialog({ pending: true });
      await user.click(screen.getByRole('alertdialog'));
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('cancels on a backdrop press when idle', async () => {
      const user = userEvent.setup();
      const { onCancel } = renderDialog();
      await user.click(screen.getByRole('alertdialog'));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });
});
