import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Tooltip } from './Tooltip';

describe('Tooltip', () => {
  it('opens on hover and closes when the pointer leaves', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Waterfall workspace">
        <span>WF</span>
      </Tooltip>,
    );

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await user.hover(screen.getByText('WF'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Waterfall workspace');

    await user.unhover(screen.getByText('WF'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  it('opens on keyboard focus — the path a native `title` never served', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Work Breakdown Structure">
        <span>WBS</span>
      </Tooltip>,
    );

    await user.tab();
    expect(screen.getByText('WBS')).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Work Breakdown Structure');
  });

  it('gives a non-focusable trigger a tab stop so the keyboard path exists at all', () => {
    render(
      <Tooltip content="Waterfall workspace">
        <span role="img" aria-label="Waterfall workspace">
          WF
        </span>
      </Tooltip>,
    );
    expect(screen.getByRole('img')).toHaveAttribute('tabindex', '0');
  });

  it('leaves a natively focusable trigger`s own tab stop alone', () => {
    render(
      <Tooltip content="Copy link to this task">
        <button type="button">Copy</button>
      </Tooltip>,
    );
    expect(screen.getByRole('button')).not.toHaveAttribute('tabindex');
  });

  it('closes on blur', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Tooltip content="Schedule Performance Index">
          <span>SPI</span>
        </Tooltip>
        <button type="button">after</button>
      </>,
    );

    await user.tab();
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();

    await user.tab();
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  it('Escape dismisses without letting the key reach an outer handler', async () => {
    const user = userEvent.setup();
    const onOuterEscape = vi.fn();
    // A bubble-phase `document` listener is precisely how a modal focus trap
    // registers its Escape handler, so this is the real adversary the component's
    // capture-phase listener has to beat — not a JSX onKeyDown standing in for it.
    const outer = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOuterEscape();
    };
    document.addEventListener('keydown', outer);

    try {
      render(
        <Tooltip content="Work Breakdown Structure">
          <span>WBS</span>
        </Tooltip>,
      );

      await user.tab();
      expect(await screen.findByRole('tooltip')).toBeInTheDocument();

      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
      // A tooltip open inside a modal must peel off on its own — Escape closing
      // both the tooltip and the modal in one press is the rule-263f bug.
      expect(onOuterEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', outer);
    }
  });

  it('wires aria-describedby while open so the panel is announced as a description', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="80% of simulated runs finish on or before this date">
        <span>P80</span>
      </Tooltip>,
    );

    const trigger = screen.getByText('P80');
    expect(trigger).not.toHaveAttribute('aria-describedby');

    await user.hover(trigger);
    const panel = await screen.findByRole('tooltip');
    expect(trigger).toHaveAttribute('aria-describedby', panel.id);
    expect(panel).not.toHaveAttribute('aria-hidden');
  });

  it('does not double-announce when the content restates the trigger`s own label', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Waterfall workspace" describe={false}>
        <span role="img" aria-label="Waterfall workspace">
          WF
        </span>
      </Tooltip>,
    );

    const trigger = screen.getByRole('img');
    await user.hover(trigger);

    // Visible to sighted users; silent to assistive tech, which already hears
    // the same sentence from the aria-label. This is the #2389 inversion fixed.
    const panel = await screen.findByText('Waterfall workspace', { selector: 'div' });
    expect(panel).toHaveAttribute('aria-hidden', 'true');
    expect(trigger).not.toHaveAttribute('aria-describedby');
  });

  it('opens on tap, the path `group-hover` can never serve', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Work Breakdown Structure">
        <span>WBS</span>
      </Tooltip>,
    );

    const trigger = screen.getByText('WBS');
    await user.pointer({ target: trigger, keys: '[TouchA]' });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Work Breakdown Structure');

    // Tapping again dismisses — there is no pointer-leave on a touch device.
    await user.pointer({ target: trigger, keys: '[TouchA]' });
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  it('preserves the trigger`s own handlers instead of replacing them', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Tooltip content="Copy link to this task">
        <button type="button" onClick={onClick}>
          Copy
        </button>
      </Tooltip>,
    );

    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
