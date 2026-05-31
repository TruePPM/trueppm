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
    expect(screen.getByRole('button', { name: 'Go' }).className).toContain(
      'focus-visible:ring-brand-primary',
    );
  });

  it('applies the secondary variant without the sage fill', () => {
    render(<Button variant="secondary">Cancel</Button>);
    const btn = screen.getByRole('button', { name: 'Cancel' });
    expect(btn.className).toContain('border-neutral-border');
    expect(btn.className).not.toContain('bg-sage-500');
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
