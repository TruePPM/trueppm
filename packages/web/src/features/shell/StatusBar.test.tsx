import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { StatusBar } from './StatusBar';

describe('StatusBar', () => {
  it('renders task count from fixture', () => {
    renderWithProviders(<StatusBar />);
    expect(screen.getByText(/42 tasks/i)).toBeInTheDocument();
  });

  it('renders critical path count', () => {
    renderWithProviders(<StatusBar />);
    expect(screen.getByText(/3 on critical path/i)).toBeInTheDocument();
  });

  it('renders a time element for last saved', () => {
    renderWithProviders(<StatusBar />);
    expect(document.querySelector('time')).toBeInTheDocument();
  });

  it('renders Gantt legend with correct items', () => {
    renderWithProviders(<StatusBar />);
    expect(screen.getByLabelText(/gantt legend/i)).toBeInTheDocument();
    expect(screen.getByText('Complete')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('Critical path')).toBeInTheDocument();
    expect(screen.getByText('Milestone')).toBeInTheDocument();
  });
});
