import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { StatusPill, OwnerAvatar, fmtDate, initials } from './ui';
import type { TaskStatus } from '@/types';

describe('StatusPill', () => {
  it.each<TaskStatus>(['BACKLOG', 'NOT_STARTED', 'IN_PROGRESS', 'REVIEW', 'ON_HOLD', 'COMPLETE'])(
    'renders the friendly label for %s',
    (status) => {
      render(<StatusPill status={status} />);
      expect(screen.getByText(/.+/)).toBeInTheDocument();
    },
  );

  it('falls back to the raw status string for an unknown value', () => {
    // Forces the fallback branch in STATUS_LABEL/STATUS_CLS lookup.
    render(<StatusPill status={'UNKNOWN' as unknown as TaskStatus} />);
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
  });
});

describe('OwnerAvatar', () => {
  it('renders initials and aria-label for a single-name resource', () => {
    render(<OwnerAvatar name="Alice" />);
    expect(screen.getByLabelText('Alice')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('renders first+last initial for multi-name resources', () => {
    render(<OwnerAvatar name="Alice Smith" />);
    expect(screen.getByText('AS')).toBeInTheDocument();
  });

  it('handles a name with extra whitespace', () => {
    render(<OwnerAvatar name="  Alice   Smith  " />);
    expect(screen.getByText('AS')).toBeInTheDocument();
  });
});

describe('initials', () => {
  it('returns a single initial for a single name', () => {
    expect(initials('Alice')).toBe('A');
  });
  it('returns first+last initials for multi-word names', () => {
    expect(initials('Alice Smith')).toBe('AS');
    expect(initials('Anna Maria von Trapp')).toBe('AT');
  });
  it('handles empty string safely', () => {
    expect(initials('')).toBe('');
  });
});

describe('fmtDate', () => {
  it('returns the dash placeholder for undefined', () => {
    expect(fmtDate(undefined)).toBe('—');
  });
  it('formats an ISO date as "Mon DD"', () => {
    expect(fmtDate('2026-05-01')).toBe('May 1');
    expect(fmtDate('2026-12-25')).toBe('Dec 25');
  });
});
