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

  it('clicking opens the cheatsheet', () => {
    const onShow = vi.fn();
    render(<BuildModePill onShowCheatsheet={onShow} />);
    fireEvent.click(screen.getByTestId('build-mode-pill'));
    expect(onShow).toHaveBeenCalledOnce();
  });
});
