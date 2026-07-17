import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChainVerifyBadge } from './ChainVerifyBadge';

const writeText = vi.fn().mockResolvedValue(undefined);

describe('ChainVerifyBadge', () => {
  beforeEach(() => {
    writeText.mockClear();
    Object.assign(navigator, { clipboard: { writeText } });
  });

  it('renders the honest "Verify locally" state (never a false green)', () => {
    render(<ChainVerifyBadge />);
    expect(screen.getByRole('button', { name: /Chain verification/i })).toHaveTextContent(
      /Verify locally/i,
    );
  });

  it('opens a popover that names the audit_verify command and copies it', async () => {
    render(<ChainVerifyBadge />);
    fireEvent.click(screen.getByRole('button', { name: /Chain verification/i }));
    const dialog = await screen.findByRole('dialog', { name: /Chain verification/i });
    expect(dialog).toHaveTextContent('manage.py audit_verify');
    fireEvent.click(screen.getByRole('button', { name: /^Copy$/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('python manage.py audit_verify'));
  });
});
