import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BuildModePill } from './BuildModePill';

describe('BuildModePill', () => {
  it('renders with accessible label', () => {
    render(<BuildModePill onShowCheatsheet={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: /Build mode active/i }),
    ).toBeInTheDocument();
  });

  it('stays a fixed size in the flex-nowrap toolbar (no zoom reflow, issue 1632)', () => {
    render(<BuildModePill onShowCheatsheet={vi.fn()} />);
    const pill = screen.getByTestId('build-mode-pill');
    expect(pill.className).toMatch(/\bshrink-0\b/);
    expect(pill.className).toMatch(/\bwhitespace-nowrap\b/);
  });

  it('clicking opens the cheatsheet', () => {
    const onShow = vi.fn();
    render(<BuildModePill onShowCheatsheet={onShow} />);
    fireEvent.click(screen.getByTestId('build-mode-pill'));
    expect(onShow).toHaveBeenCalledOnce();
  });
});
