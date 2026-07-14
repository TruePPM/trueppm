import { act, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAnchoredPopover, type AnchoredPopoverOptions } from './useAnchoredPopover';

// jsdom's getBoundingClientRect returns all-zeros and offsetHeight is 0, so the
// hook's flip decision falls back to `estimatedHeight` — deterministic. We drive
// the trigger's rect and the viewport size explicitly per test.

type HarnessProps = Omit<AnchoredPopoverOptions, 'open'>;

function Harness(props: HarnessProps) {
  const [open, setOpen] = useState(false);
  const { triggerRef, popoverRef, popoverStyle } = useAnchoredPopover<
    HTMLButtonElement,
    HTMLDivElement
  >({ open, ...props });
  return (
    <div>
      <button ref={triggerRef} onClick={() => setOpen((o) => !o)}>
        trigger
      </button>
      {open && popoverStyle && (
        <div ref={popoverRef} data-testid="panel" style={popoverStyle}>
          panel
        </div>
      )}
      <button type="button" data-testid="outside">
        outside
      </button>
    </div>
  );
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

function mockTriggerRect(rect: Partial<DOMRect>) {
  const full: DOMRect = {
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...rect,
  } as DOMRect;
  vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockReturnValue(full);
}

async function open(props: HarnessProps, rect: Partial<DOMRect>) {
  mockTriggerRect(rect);
  const user = userEvent.setup();
  render(<Harness {...props} />);
  await user.click(screen.getByRole('button', { name: 'trigger' }));
  return screen.getByTestId('panel');
}

function style(el: HTMLElement) {
  return {
    position: el.style.position,
    top: el.style.top,
    left: el.style.left,
    width: el.style.width,
  };
}

describe('useAnchoredPopover', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setViewport(1024, 768);
  });

  it('renders nothing until open', () => {
    render(<Harness width={200} estimatedHeight={100} />);
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
  });

  it('positions the panel fixed, below the trigger, left-aligned', async () => {
    setViewport(1024, 768);
    const panel = await open(
      { width: 200, estimatedHeight: 100 },
      { top: 100, bottom: 120, left: 50, right: 150, width: 100 },
    );
    // below = bottom(120) + gap(4) = 124; no flip (124 + 100 < 760)
    expect(style(panel)).toEqual({ position: 'fixed', top: '124px', left: '50px', width: '200px' });
  });

  it('flips above the trigger when there is no room below', async () => {
    setViewport(1024, 768);
    const panel = await open(
      { width: 200, estimatedHeight: 100 },
      { top: 700, bottom: 720, left: 50, right: 150, width: 100 },
    );
    // below = 724; 724 + 100 = 824 > (768 - 8) → flip: top = 700 - 100 - 4 = 596
    expect(panel.style.top).toBe('596px');
  });

  it('clamps horizontally so a wide panel never leaves the right edge', async () => {
    setViewport(1024, 768);
    const panel = await open(
      { width: 200, estimatedHeight: 100 },
      { top: 100, bottom: 120, left: 900, right: 1000, width: 100 },
    );
    // rawLeft = 900; clamp to min(900, 1024 - 200 - 8 = 816) = 816
    expect(panel.style.left).toBe('816px');
  });

  it('right-aligns the panel to the trigger when align="right"', async () => {
    setViewport(1024, 768);
    const panel = await open(
      { width: 120, estimatedHeight: 100, align: 'right' },
      { top: 100, bottom: 120, left: 800, right: 1000, width: 200 },
    );
    // rawLeft = right(1000) - width(120) = 880; fits (880 <= 896)
    expect(panel.style.left).toBe('880px');
  });

  it('matches the trigger width when width="trigger", capped to the viewport', async () => {
    setViewport(320, 640); // phone
    const panel = await open(
      { width: 'trigger', estimatedHeight: 100 },
      { top: 40, bottom: 60, left: 8, right: 300, width: 292 },
    );
    // resolvedWidth = min(292, 320 - 16 = 304) = 292
    expect(panel.style.width).toBe('292px');
  });

  it('caps a fixed width wider than the viewport (phone-safe)', async () => {
    setViewport(320, 640);
    const panel = await open(
      { width: 260, estimatedHeight: 100 },
      { top: 40, bottom: 60, left: 150, right: 250, width: 100 },
    );
    // resolvedWidth = min(260, 304) = 260; left clamp = min(150, 320 - 260 - 8 = 52) = 52
    expect(panel.style.width).toBe('260px');
    expect(panel.style.left).toBe('52px');
  });

  it('calls onDismiss on an outside pointer-down, but not inside trigger or panel', async () => {
    const onDismiss = vi.fn();
    await open(
      { width: 200, estimatedHeight: 100, onDismiss },
      { top: 100, bottom: 120, left: 50, right: 150, width: 100 },
    );

    fireEvent.pointerDown(screen.getByTestId('panel'));
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'trigger' }));
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not attach an outside listener when onDismiss is omitted', async () => {
    await open(
      { width: 200, estimatedHeight: 100 },
      { top: 100, bottom: 120, left: 50, right: 150, width: 100 },
    );
    // No throw / no dismissal path — the panel stays mounted after an outside click.
    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(screen.getByTestId('panel')).toBeInTheDocument();
  });

  it('repositions on viewport resize (a fixed panel cannot track its anchor)', async () => {
    setViewport(1024, 768);
    const rect = { top: 100, bottom: 120, left: 50, right: 150, width: 100 };
    const spy = vi
      .spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ ...rect, height: 20, x: 50, y: 100, toJSON: () => ({}) } as DOMRect);

    const user = userEvent.setup();
    render(<Harness width={200} estimatedHeight={100} />);
    await user.click(screen.getByRole('button', { name: 'trigger' }));
    expect(screen.getByTestId('panel').style.top).toBe('124px');

    // The trigger moved (e.g. the page scrolled/reflowed): next measure returns a
    // new rect, and a resize event must re-derive coords.
    spy.mockReturnValue({
      top: 300,
      bottom: 320,
      left: 50,
      right: 150,
      width: 100,
      height: 20,
      x: 50,
      y: 300,
      toJSON: () => ({}),
    } as DOMRect);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.getByTestId('panel').style.top).toBe('324px');
  });
});
