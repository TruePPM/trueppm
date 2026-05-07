import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BuildModeCheatsheet } from './BuildModeCheatsheet';

describe('BuildModeCheatsheet — visibility', () => {
  it('renders nothing when closed', () => {
    render(<BuildModeCheatsheet open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the dialog when open', () => {
    render(<BuildModeCheatsheet open={true} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Schedule shortcuts' })).toBeInTheDocument();
  });

  it('renders all five sections', () => {
    render(<BuildModeCheatsheet open={true} onClose={vi.fn()} />);
    expect(screen.getByText('Selecting rows')).toBeInTheDocument();
    expect(screen.getByText('Editing cells')).toBeInTheDocument();
    expect(screen.getByText('Structuring (the WBS tree)')).toBeInTheDocument();
    expect(screen.getByText('Creating & deleting')).toBeInTheDocument();
    expect(screen.getByText('Help')).toBeInTheDocument();
  });
});

describe('BuildModeCheatsheet — dismissal', () => {
  it('Esc closes', () => {
    const onClose = vi.fn();
    render(<BuildModeCheatsheet open={true} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('? closes (toggles)', () => {
    const onClose = vi.fn();
    render(<BuildModeCheatsheet open={true} onClose={onClose} />);
    fireEvent.keyDown(window, { key: '?' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('clicking the backdrop closes', () => {
    const onClose = vi.fn();
    render(<BuildModeCheatsheet open={true} onClose={onClose} />);
    // The backdrop is the role="presentation" wrapper; the dialog stops bubbling.
    const backdrop = document.querySelector('[role="presentation"]') as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('clicking inside the dialog does NOT close', () => {
    const onClose = vi.fn();
    render(<BuildModeCheatsheet open={true} onClose={onClose} />);
    fireEvent.click(screen.getByText('Schedule shortcuts'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Close button calls onClose', () => {
    const onClose = vi.fn();
    render(<BuildModeCheatsheet open={true} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('X button calls onClose', () => {
    const onClose = vi.fn();
    render(<BuildModeCheatsheet open={true} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close shortcuts'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
