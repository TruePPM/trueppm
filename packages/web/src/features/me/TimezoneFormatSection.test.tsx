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
import { useUpdateTimezone, useUpdateDateFormat } from '@/hooks/useUpdateDisplayPrefs';
const mockUseCurrentUser = useCurrentUser as ReturnType<typeof vi.fn>;
const mockUseUpdateTimezone = useUpdateTimezone as ReturnType<typeof vi.fn>;
const mockUseUpdateDateFormat = useUpdateDateFormat as ReturnType<typeof vi.fn>;

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value });
}

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
    mockUseUpdateTimezone.mockReturnValue({ mutate: tzMutate, isError: false });
    mockUseUpdateDateFormat.mockReturnValue({ mutate: dfMutate, isError: false });
    setOnline(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    setOnline(true);
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

  it('shows the loading skeleton (no trigger) while the user is still resolving', () => {
    mockUseCurrentUser.mockReturnValue({ user: undefined, isLoading: true });
    const { container } = render(<TimezoneFormatSection />);
    // The timezone control is replaced by an aria-busy pulse placeholder.
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Timezone:/i })).not.toBeInTheDocument();
  });

  it('when offline, disables both controls and shows the reconnect note', () => {
    setOnline(false);
    render(<TimezoneFormatSection />);
    expect(screen.getByRole('button', { name: /Timezone:/i })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /ISO 8601/i })).toBeDisabled();
    expect(screen.getByText(/You.?re offline — reconnect/i)).toBeInTheDocument();
  });

  it('announces "Saved." and updates the trigger after a successful timezone save', () => {
    tzMutate.mockImplementation((_v: string, opts: { onSuccess?: () => void }) => {
      opts.onSuccess?.();
    });
    render(<TimezoneFormatSection />);
    fireEvent.click(screen.getByRole('button', { name: /Timezone:/i }));
    fireEvent.change(screen.getByRole('combobox', { name: /Search timezones/i }), {
      target: { value: 'london' },
    });
    fireEvent.pointerDown(screen.getByRole('option', { name: /Europe\/London/i }));
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
    expect(
      screen.getByRole('button', { name: /Timezone: Europe\/London/i }),
    ).toBeInTheDocument();
  });

  it('shows the error message in the status line when a mutation is in error', () => {
    mockUseUpdateTimezone.mockReturnValue({ mutate: tzMutate, isError: true });
    render(<TimezoneFormatSection />);
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't save. Try again.");
  });

  it('shows the default idle status when nothing has been saved yet', () => {
    render(<TimezoneFormatSection />);
    expect(screen.getByRole('status')).toHaveTextContent('Changes save automatically.');
  });

  it('reverts the optimistic date-format selection on error', () => {
    dfMutate.mockImplementation((_v: string, opts: { onError?: () => void }) => {
      opts.onError?.();
    });
    render(<TimezoneFormatSection />);
    fireEvent.click(screen.getByRole('radio', { name: /ISO 8601/i }));
    // Failed → reverts to the stored "auto" style.
    expect(screen.getByRole('radio', { name: /Automatic/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /ISO 8601/i })).not.toBeChecked();
  });

  it('announces "Saved." after a successful date-format save', () => {
    dfMutate.mockImplementation((_v: string, opts: { onSuccess?: () => void }) => {
      opts.onSuccess?.();
    });
    render(<TimezoneFormatSection />);
    fireEvent.click(screen.getByRole('radio', { name: /European/i }));
    expect(screen.getByRole('radio', { name: /European/i })).toBeChecked();
    expect(screen.getByText('Saved.')).toBeInTheDocument();
  });

  it('shows the empty-result note when no timezone matches the query', () => {
    render(<TimezoneFormatSection />);
    fireEvent.click(screen.getByRole('button', { name: /Timezone:/i }));
    fireEvent.change(screen.getByRole('combobox', { name: /Search timezones/i }), {
      target: { value: 'zzzznotazone' },
    });
    expect(screen.getByText(/No timezones match/i)).toBeInTheDocument();
    // Auto is exempt from the filter and stays visible.
    expect(screen.getByRole('option', { name: /Automatic/i })).toBeInTheDocument();
  });

  it('opens the popover with ArrowDown from the trigger', () => {
    render(<TimezoneFormatSection />);
    const trigger = screen.getByRole('button', { name: /Timezone:/i });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('combobox', { name: /Search timezones/i })).toBeInTheDocument();
  });

  it('commits the active option with ArrowDown + Enter from the search box', () => {
    render(<TimezoneFormatSection />);
    fireEvent.click(screen.getByRole('button', { name: /Timezone:/i }));
    const search = screen.getByRole('combobox', { name: /Search timezones/i });
    fireEvent.change(search, { target: { value: 'london' } });
    // Options are [auto, Europe/London]; ArrowDown moves to Europe/London, Enter commits.
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(tzMutate).toHaveBeenCalledWith('Europe/London', expect.anything());
  });

  it('Escape first clears the query, then closes the popover on the second press', () => {
    render(<TimezoneFormatSection />);
    fireEvent.click(screen.getByRole('button', { name: /Timezone:/i }));
    const search = screen.getByRole('combobox', { name: /Search timezones/i });
    fireEvent.change(search, { target: { value: 'london' } });
    expect(search).toHaveValue('london');
    fireEvent.keyDown(search, { key: 'Escape' });
    // Query cleared but popover stays open.
    expect(screen.getByRole('combobox', { name: /Search timezones/i })).toHaveValue('');
    fireEvent.keyDown(screen.getByRole('combobox', { name: /Search timezones/i }), {
      key: 'Escape',
    });
    expect(screen.queryByRole('combobox', { name: /Search timezones/i })).not.toBeInTheDocument();
  });

  it('selecting the already-current zone is a no-op that just closes the popover', () => {
    render(<TimezoneFormatSection />);
    fireEvent.click(screen.getByRole('button', { name: /Timezone:/i }));
    fireEvent.pointerDown(screen.getByRole('option', { name: /Automatic/i }));
    expect(tzMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('reflects a non-auto stored timezone on the trigger and marks it selected', () => {
    mockUseCurrentUser.mockReturnValue({
      user: { timezone: 'Europe/Paris', date_format: 'auto' },
      isLoading: false,
    });
    render(<TimezoneFormatSection />);
    expect(
      screen.getByRole('button', { name: /Timezone: Europe\/Paris/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Timezone: Europe\/Paris/i }));
    expect(
      screen.getByRole('option', { name: /Europe\/Paris/i, selected: true }),
    ).toBeInTheDocument();
  });

  it('closes the popover when pointer-down lands outside the trigger and popover', () => {
    render(<TimezoneFormatSection />);
    fireEvent.click(screen.getByRole('button', { name: /Timezone:/i }));
    expect(screen.getByRole('combobox', { name: /Search timezones/i })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('combobox', { name: /Search timezones/i })).not.toBeInTheDocument();
  });
});
