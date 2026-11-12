import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DateFormatEcho } from './DateFormatEcho';

const fmtDateLong = vi.fn((iso: string | null | undefined) => `LONG(${iso})`);
vi.mock('@/hooks/useUserDateFormat', () => ({
  useUserDateFormat: () => ({ fmtDateLong }),
}));

describe('DateFormatEcho (#3623)', () => {
  it('renders nothing for an empty value', () => {
    const { container } = render(<DateFormatEcho value="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the date through the user date-format preference, hidden from AT', () => {
    render(<DateFormatEcho value="2026-08-27" />);
    const el = screen.getByTestId('date-format-echo');
    expect(el).toHaveTextContent('LONG(2026-08-27)');
    expect(el).toHaveAttribute('aria-hidden', 'true');
  });
});
