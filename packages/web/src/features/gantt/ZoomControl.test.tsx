import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { useGanttStore } from '@/stores/ganttStore';
import { ZoomControl } from './ZoomControl';

describe('ZoomControl', () => {
  beforeEach(() => {
    useGanttStore.setState({ zoomLevel: 'week' });
  });

  it('renders all four zoom levels', () => {
    renderWithProviders(<ZoomControl />);
    expect(screen.getByRole('button', { name: 'Day' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Week' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Month' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quarter' })).toBeInTheDocument();
  });

  it('Week button is pressed by default', () => {
    renderWithProviders(<ZoomControl />);
    expect(screen.getByRole('button', { name: 'Week' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Day' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking Month updates the store', async () => {
    renderWithProviders(<ZoomControl />);
    await userEvent.click(screen.getByRole('button', { name: 'Month' }));
    expect(useGanttStore.getState().zoomLevel).toBe('month');
  });
});
