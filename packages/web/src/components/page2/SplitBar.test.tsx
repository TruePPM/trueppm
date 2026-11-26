import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SplitBar } from './SplitBar';

const segment = (c: HTMLElement, name: string) =>
  c.querySelector<HTMLElement>(`[data-segment="${name}"]`)!.style.width;

describe('SplitBar', () => {
  it('names every share in text and hides the bar', () => {
    const { container } = render(<SplitBar thisProject={50} otherProjects={30} unbooked={20} />);
    expect(
      screen.getByText('This project 50% · Other projects 30% · Unbooked 20%'),
    ).toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(segment(container, 'this')).toBe('50%');
    expect(segment(container, 'other')).toBe('30%');
  });

  it('scales segments when over-booked but prints the real numbers', () => {
    const { container } = render(<SplitBar thisProject={100} otherProjects={60} unbooked={0} />);
    expect(segment(container, 'this')).toBe('62.5%');
    expect(screen.getByText(/This project 100% · Other projects 60%/)).toBeInTheDocument();
  });
});
