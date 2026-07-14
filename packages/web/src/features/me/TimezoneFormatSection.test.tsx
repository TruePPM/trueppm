import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimezoneFormatSection } from './TimezoneFormatSection';

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: vi.fn(() => ({
    user: { timezone: 'auto', date_format: 'auto' },
    isLoading: false,
  })),
}));

const tzMutate = vi.fn();
const dfMutate = vi.fn();
vi.mock('@/hooks/useUpdateDisplayPrefs', () => ({
  useUpdateTimezone: vi.fn(() => ({ mutate: tzMutate, isError: false })),
  useUpdateDateFormat: vi.fn(() => ({ mutate: dfMutate, isError: false })),
}));

import { useCurrentUser } from '@/hooks/useCurrentUser';
const mockUseCurrentUser = useCurrentUser as ReturnType<typeof vi.fn>;

describe('TimezoneFormatSection (#1953)', () => {
  beforeEach(() => {
    // Only fake Date so the live samples are deterministic; leave timers real so
    // the "Saved." toast timeout doesn't need manual advancing.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-14T12:00:00Z'));
    tzMutate.mockReset();
    dfMutate.mockReset();
    mockUseCurrentUser.mockReturnValue({
      user: { timezone: 'auto', date_format: 'auto' },
      isLoading: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the timezone trigger and the four date-format radios', () => {
    render(<TimezoneFormatSection />);
    expect(screen.getByRole('button', { name: /Timezone:/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Automatic/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /ISO 8601/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /US/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /European/i })).toBeInTheDocument();
  });

  it('shows the auto trigger label with the detected browser zone', () => {
    render(<TimezoneFormatSection />);
    expect(
      screen.getByRole('button', { name: /Timezone: Automatic — detected:/i }),
    ).toBeInTheDocument();
  });

  it('opens the popover and filters by city so "london" surfaces Europe/London', () => {
    render(<TimezoneFormatSection />);
    fireEvent.click(screen.getByRole('button', { name: /Timezone:/i }));
    const search = screen.getByRole('combobox', { name: /Search timezones/i });
    fireEvent.change(search, { target: { value: 'london' } });
    expect(screen.getByRole('option', { name: /Europe\/London/i })).toBeInTheDocument();
    // Unrelated zones are filtered out.
    expect(screen.queryByRole('option', { name: /Asia\/Tokyo/i })).not.toBeInTheDocument();
  });

  it('selecting a zone calls the timezone mutation with the IANA id', () => {
    render(<TimezoneFormatSection />);
    fireEvent.click(screen.getByRole('button', { name: /Timezone:/i }));
    fireEvent.change(screen.getByRole('combobox', { name: /Search timezones/i }), {
      target: { value: 'london' },
    });
    fireEvent.pointerDown(screen.getByRole('option', { name: /Europe\/London/i }));
    expect(tzMutate).toHaveBeenCalledWith('Europe/London', expect.anything());
  });

  it('renders each date-format radio with its distinct live sample', () => {
    render(<TimezoneFormatSection />);
    expect(screen.getByText('2026-07-14')).toBeInTheDocument(); // iso
    // us ("July 14, 2026") — the auto sample coincides with US in an en-US
    // runtime, so this string may appear more than once.
    expect(screen.getAllByText('July 14, 2026').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('14 July 2026')).toBeInTheDocument(); // eu
  });

  it('selecting a date-format radio calls the date_format mutation', () => {
    render(<TimezoneFormatSection />);
    fireEvent.click(screen.getByRole('radio', { name: /ISO 8601/i }));
    expect(dfMutate).toHaveBeenCalledWith('iso', expect.anything());
  });

  it('reverts the optimistic timezone selection on error', () => {
    tzMutate.mockImplementation((_value: string, opts: { onError?: () => void }) => {
      opts.onError?.();
    });
    render(<TimezoneFormatSection />);
    fireEvent.click(screen.getByRole('button', { name: /Timezone:/i }));
    fireEvent.change(screen.getByRole('combobox', { name: /Search timezones/i }), {
      target: { value: 'london' },
    });
    fireEvent.pointerDown(screen.getByRole('option', { name: /Europe\/London/i }));
    // The mutation failed, so the trigger reverts to the stored "auto" value.
    expect(
      screen.getByRole('button', { name: /Timezone: Automatic — detected:/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Europe\/London/i }),
    ).not.toBeInTheDocument();
  });
});
