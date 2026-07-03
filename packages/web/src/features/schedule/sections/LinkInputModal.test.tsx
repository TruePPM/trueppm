import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { LinkInputModal } from './LinkInputModal';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LinkInputModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <LinkInputModal open={false} onClose={vi.fn()} onSubmit={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the dialog and focuses the URL input when opened', () => {
    render(<LinkInputModal open onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: /Pin a link/ })).toBeTruthy();
    expect(screen.getByPlaceholderText('https://figma.com/…')).toHaveFocus();
  });

  it('traps Tab inside the dialog — wraps from the last control back to the URL input', () => {
    render(<LinkInputModal open onClose={vi.fn()} onSubmit={vi.fn()} />);
    // "Pin link" is disabled (and so not a Tab stop) until the URL field has a
    // value — fill it so the last focusable in the trap is the real one.
    fireEvent.change(screen.getByPlaceholderText('https://figma.com/…'), {
      target: { value: 'https://figma.com/x' },
    });
    const pinLink = screen.getByRole('button', { name: 'Pin link' });
    pinLink.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByPlaceholderText('https://figma.com/…')).toHaveFocus();
  });

  it('traps Shift+Tab inside the dialog — wraps from the URL input to the last control', () => {
    render(<LinkInputModal open onClose={vi.fn()} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('https://figma.com/…'), {
      target: { value: 'https://figma.com/x' },
    });
    const urlInput = screen.getByPlaceholderText('https://figma.com/…');
    urlInput.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Pin link' })).toHaveFocus();
  });

  it('restores focus to the trigger that opened it on close', () => {
    function Wrapper() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            + Pin link
          </button>
          <LinkInputModal open={open} onClose={() => setOpen(false)} onSubmit={vi.fn()} />
        </>
      );
    }
    render(<Wrapper />);
    const trigger = screen.getByRole('button', { name: '+ Pin link' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByPlaceholderText('https://figma.com/…')).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger).toHaveFocus();
  });

  it('shows an inline error when the URL field is empty on submit', () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <LinkInputModal open onClose={vi.fn()} onSubmit={onSubmit} />,
    );
    const form = container.querySelector('form')!;
    fireEvent.submit(form);
    expect(screen.getByRole('alert').textContent).toContain('URL is required');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects non-http(s) URLs with an inline error', () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <LinkInputModal open onClose={vi.fn()} onSubmit={onSubmit} />,
    );
    const urlInput = container.querySelector<HTMLInputElement>('input[type="url"]')!;
    fireEvent.change(urlInput, { target: { value: 'javascript:alert(1)' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(screen.getByRole('alert').textContent).toContain('Only http(s)');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits with trimmed URL and title on valid input', () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <LinkInputModal open onClose={vi.fn()} onSubmit={onSubmit} />,
    );
    const urlInput = container.querySelector<HTMLInputElement>('input[type="url"]')!;
    const titleInput = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    fireEvent.change(urlInput, { target: { value: '  https://figma.com/x  ' } });
    fireEvent.change(titleInput, { target: { value: '  Design  ' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(onSubmit).toHaveBeenCalledWith('https://figma.com/x', 'Design');
  });

  it('closes when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<LinkInputModal open onClose={onClose} onSubmit={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes when the Cancel button is clicked', () => {
    const onClose = vi.fn();
    render(<LinkInputModal open onClose={onClose} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('disables both buttons and shows "Pinning…" while submitting', () => {
    const { container } = render(
      <LinkInputModal open onClose={vi.fn()} onSubmit={vi.fn()} submitting />,
    );
    const urlInput = container.querySelector<HTMLInputElement>('input[type="url"]')!;
    fireEvent.change(urlInput, { target: { value: 'https://x' } });
    expect(screen.getByText('Pinning…')).toBeDisabled();
    expect(screen.getByText('Cancel')).toBeDisabled();
  });
});
