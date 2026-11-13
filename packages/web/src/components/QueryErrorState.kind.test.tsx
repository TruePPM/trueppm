import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { QueryErrorState } from './QueryErrorState';
import { classifyQueryError } from '@/lib/queryErrorKind';

function httpError(status: number, headers: Record<string, string> = {}): AxiosError {
  const config = { headers: {} } as InternalAxiosRequestConfig;
  return new AxiosError(
    'x',
    'ERR',
    config,
    {},
    {
      status,
      statusText: '',
      data: {},
      headers,
      config,
    },
  );
}

afterEach(() => vi.useRealTimers());

describe('classifyQueryError', () => {
  it('reads 403, 429 (with Retry-After) and everything else', () => {
    expect(classifyQueryError(httpError(403)).kind).toBe('forbidden');
    expect(classifyQueryError(httpError(429, { 'retry-after': '7' }))).toEqual({
      kind: 'throttled',
      retryAfterSeconds: 7,
    });
    expect(classifyQueryError(httpError(429)).retryAfterSeconds).toBe(5);
    expect(classifyQueryError(httpError(429, { 'retry-after': '9999' })).retryAfterSeconds).toBe(
      60,
    );
    expect(classifyQueryError(httpError(500)).kind).toBe('other');
    expect(classifyQueryError(new Error('network')).kind).toBe('other');
    expect(classifyQueryError(undefined).kind).toBe('other');
  });
});

describe('QueryErrorState status-aware variants (#3874, #3621)', () => {
  it('403: distinct copy and NO Retry button', () => {
    render(
      <QueryErrorState
        variant="inline"
        message="Couldn't load labels."
        error={httpError(403)}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText(/don't have access/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn't load labels/i)).not.toBeInTheDocument();
  });

  it('500 keeps the caller message and the Retry button', () => {
    const onRetry = vi.fn();
    render(
      <QueryErrorState
        variant="inline"
        message="Couldn't load labels."
        error={httpError(500)}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText(/couldn't load labels/i)).toBeInTheDocument();
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('429: counts down and retries itself exactly once at zero', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    render(<QueryErrorState error={httpError(429, { 'retry-after': '2' })} onRetry={onRetry} />);
    expect(screen.getByText(/Retrying in 2s/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.getByText(/Retrying in 1s/)).toBeInTheDocument();
    expect(onRetry).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1000));
    expect(onRetry).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(5000));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it.each(['fill', 'page'] as const)(
    '429 (%s): a repeat 429 with the same Retry-After restarts the countdown',
    (variant) => {
      vi.useFakeTimers();
      const onRetry = vi.fn();
      const props =
        variant === 'page'
          ? ({ variant: 'page', stillWorks: 'Other pages work.', supportCode: 'ABC' } as const)
          : ({ variant: 'fill' } as const);
      const { rerender } = render(
        <QueryErrorState
          {...props}
          error={httpError(429, { 'retry-after': '1' })}
          onRetry={onRetry}
        />,
      );
      act(() => void vi.advanceTimersByTime(1000));
      expect(onRetry).toHaveBeenCalledTimes(1);
      rerender(
        <QueryErrorState
          {...props}
          error={httpError(429, { 'retry-after': '1' })}
          onRetry={onRetry}
        />,
      );
      expect(screen.getByText(/Retrying in 1s/)).toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(1000));
      expect(onRetry).toHaveBeenCalledTimes(2);
    },
  );

  it('429 without an onRetry never auto-reloads the page', () => {
    vi.useFakeTimers();
    render(<QueryErrorState error={httpError(429, { 'retry-after': '1' })} />);
    expect(screen.getByText(/Wait a moment/)).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(3000));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('page variant: 403 drops Retry and keeps the support code', () => {
    render(
      <QueryErrorState
        variant="page"
        stillWorks="The rest of the app works."
        supportCode="AB12"
        error={httpError(403)}
      />,
    );
    expect(screen.getByText(/don't have access/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.getByText('AB12')).toBeInTheDocument();
  });
});
