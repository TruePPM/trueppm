import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';

describe('Button', () => {
  it('defaults to a type="button" primary variant with the brand sage fill', () => {
    render(<Button>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn).toHaveAttribute('type', 'button');
    // brand btn-primary recipe: sage-500 fill + navy text + sage-600 boundary
    expect(btn.className).toContain('bg-sage-500');
    expect(btn.className).toContain('text-navy-900');
    expect(btn.className).toContain('border-sage-600');
  });

  it('always renders the rule-4 focus ring', () => {
    render(<Button>Go</Button>);
    // Standalone-trigger primitive uses `focus:` (not `focus-visible:`) so the
    // pointer-focused button shows a ring in Firefox/Safari (rule 214, WCAG 2.4.7).
    expect(screen.getByRole('button', { name: 'Go' }).className).toContain(
      'focus:ring-brand-primary',
    );
  });

  it('presses with a motion-safe active-translate on the brand ease (rule 178)', () => {
    render(<Button>Press</Button>);
    const btn = screen.getByRole('button', { name: 'Press' });
    // v2 fluidity: the press transform is motion-safe-gated (no movement for
    // reduced-motion users) and shares one `transition` with hover colors.
    expect(btn.className).toContain('motion-safe:active:translate-y-px');
    expect(btn.className).toContain('ease-brand');
    // never a drop shadow (rule 1)
    expect(btn.className).not.toMatch(/(^|\s)shadow-/);
  });

  it('applies the secondary variant without the sage fill', () => {
    render(<Button variant="secondary">Cancel</Button>);
    const btn = screen.getByRole('button', { name: 'Cancel' });
    expect(btn.className).toContain('border-neutral-border');
    expect(btn.className).not.toContain('bg-sage-500');
  });

  // #2196 — the danger fill is mode-aware (#B91C1C light / #F87171 dark), so
  // white ink drops to 2.77:1 in dark mode. `dark:text-navy-900` restores AA by
  // putting dark ink on the light-red dark fill (4.9:1), mirroring the primary
  // variant; light mode keeps white ink (6.47:1). Sibling of #2041.
  it('gives the danger variant dark ink in dark mode so it clears WCAG 1.4.3 (#2196)', () => {
    render(<Button variant="danger">Delete</Button>);
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect(btn.className).toContain('bg-semantic-critical');
    expect(btn.className).toContain('text-white');
    // the fix: dark mode swaps white ink for navy ink on the lighter dark fill
    expect(btn.className).toContain('dark:text-navy-900');
  });

  // #2196 — navy-900 on sage-600 is only 4.46:1 (marginally under the 4.5:1 AA
  // floor). Hover now brightens to sage-400 (the AA-safe pair the dark recipe
  // already ships) instead of darkening to sage-600.
  it('brightens the primary hover to the AA-safe sage-400 fill, never darkens to sage-600 (#2196)', () => {
    render(<Button>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn.className).toContain('hover:bg-sage-400');
    expect(btn.className).not.toContain('hover:bg-sage-600');
  });

  it('forwards size, custom className, disabled, and onClick', async () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button size="sm" className="w-full" onClick={onClick}>
        Click
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Click' });
    expect(btn.className).toContain('h-7');
    expect(btn.className).toContain('w-full');
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();

    rerender(
      <Button disabled onClick={onClick}>
        Click
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Click' })).toBeDisabled();
  });
});
