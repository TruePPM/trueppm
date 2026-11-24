import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  StatusPill,
  OwnerAvatar,
  fmtDate,
  initials,
  statusRollupPhrase,
  isStatusComputed,
} from './ui';
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

  it('surfaces the full name via Tooltip on focus, not a bare title (#2454)', () => {
    render(<OwnerAvatar name="Alice Smith" />);
    const avatar = screen.getByLabelText('Alice Smith');
    expect(avatar).not.toHaveAttribute('title');
    fireEvent.focus(avatar);
    // describe={false}: the tooltip restates the aria-label, so the panel is
    // aria-hidden and must be queried directly rather than via getByRole.
    const panel = document.querySelector('[role="tooltip"]');
    expect(panel).toHaveTextContent('Alice Smith');
    expect(panel).toHaveAttribute('aria-hidden', 'true');
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

describe('rolled-up status (#3531)', () => {
  it('phrases the accessible name with an explicit ", " separator', () => {
    expect(statusRollupPhrase('IN_PROGRESS', 4)).toBe('In progress, rolled up from 4 tasks');
    expect(statusRollupPhrase('COMPLETE', 1)).toBe('Done, rolled up from 1 task');
  });

  it('derived pill: dashed, shows the word "rolled up", exposes the phrase, is not interactive', () => {
    render(<StatusPill status="IN_PROGRESS" source="derived" rollupCount={4} />);
    const pill = screen.getByTestId('status-pill-derived');
    expect(pill.className).toContain('border-dashed');
    expect(pill).toHaveTextContent('rolled up');
    expect(pill).toHaveTextContent('In progress, rolled up from 4 tasks');
    expect(pill).not.toHaveAttribute('tabindex');
    expect(pill).not.toHaveAttribute('aria-label');
    expect(pill.tagName).toBe('SPAN');
  });

  it('source "none" renders an em dash, never Not started', () => {
    render(<StatusPill status="NOT_STARTED" source="none" rollupCount={0} />);
    expect(screen.getByTestId('status-none')).toHaveTextContent('\u2014');
    expect(screen.queryByText('Not started')).not.toBeInTheDocument();
  });

  it('committed source keeps the plain pill', () => {
    render(<StatusPill status="REVIEW" source="committed" />);
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.queryByTestId('status-pill-derived')).not.toBeInTheDocument();
  });

  it('isStatusComputed gates on provenance, not is_phase', () => {
    expect(isStatusComputed({ statusSource: 'derived' })).toBe(true);
    expect(isStatusComputed({ statusSource: 'none' })).toBe(true);
    expect(isStatusComputed({ statusSource: 'committed' })).toBe(false);
    expect(isStatusComputed({})).toBe(false);
  });
});
