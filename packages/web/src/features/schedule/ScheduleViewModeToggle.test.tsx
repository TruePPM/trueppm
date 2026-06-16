import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScheduleViewModeToggle } from './ScheduleViewModeToggle';
import { useScheduleStore } from '@/stores/scheduleStore';

describe('ScheduleViewModeToggle (#1221)', () => {
  beforeEach(() => {
    localStorage.removeItem('schedule.viewMode');
    useScheduleStore.setState({ viewMode: 'grid' });
  });

  it('renders both options as radios in a labeled radiogroup', () => {
    render(<ScheduleViewModeToggle />);
    expect(screen.getByRole('radiogroup', { name: 'Schedule layout' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Grid' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Timeline' })).toBeInTheDocument();
  });

  it('reflects the current store mode via aria-checked (Grid default)', () => {
    render(<ScheduleViewModeToggle />);
    expect(screen.getByRole('radio', { name: 'Grid' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Timeline' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('clicking Timeline switches the store mode and persists', () => {
    render(<ScheduleViewModeToggle />);
    fireEvent.click(screen.getByRole('radio', { name: 'Timeline' }));
    expect(useScheduleStore.getState().viewMode).toBe('timeline');
    expect(localStorage.getItem('schedule.viewMode')).toBe('timeline');
    expect(screen.getByRole('radio', { name: 'Timeline' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('only the selected radio is in the tab order (roving tabindex)', () => {
    render(<ScheduleViewModeToggle />);
    expect(screen.getByRole('radio', { name: 'Grid' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Timeline' })).toHaveAttribute('tabindex', '-1');
  });

  it('ArrowRight moves selection to the next option and commits it', () => {
    render(<ScheduleViewModeToggle />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Grid' }), { key: 'ArrowRight' });
    expect(useScheduleStore.getState().viewMode).toBe('timeline');
  });

  it('ArrowLeft from the first option wraps to the last', () => {
    render(<ScheduleViewModeToggle />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Grid' }), { key: 'ArrowLeft' });
    expect(useScheduleStore.getState().viewMode).toBe('timeline');
  });

  it('Home selects the first option, End the last', () => {
    useScheduleStore.setState({ viewMode: 'timeline' });
    render(<ScheduleViewModeToggle />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Timeline' }), { key: 'Home' });
    expect(useScheduleStore.getState().viewMode).toBe('grid');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Grid' }), { key: 'End' });
    expect(useScheduleStore.getState().viewMode).toBe('timeline');
  });
});
