import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Stepper } from './Stepper';

function Harness({ start }: { start: number }) {
  const [value, setValue] = useState(start);
  return <Stepper label="Allocation" value={value} onChange={setValue} step={10} />;
}

describe('Stepper', () => {
  it('steps by the step and names both buttons', async () => {
    render(<Harness start={50} />);
    await userEvent.click(screen.getByRole('button', { name: 'Increase Allocation' }));
    expect(screen.getByRole('status')).toHaveTextContent('60%');
    await userEvent.click(screen.getByRole('button', { name: 'Decrease Allocation' }));
    await userEvent.click(screen.getByRole('button', { name: 'Decrease Allocation' }));
    expect(screen.getByRole('status')).toHaveTextContent('40%');
  });

  it('clamps at the bound and keeps focus on the now-inert button', async () => {
    render(<Harness start={95} />);
    const plus = screen.getByRole('button', { name: 'Increase Allocation' });
    await userEvent.click(plus);
    expect(screen.getByRole('status')).toHaveTextContent('100%');
    expect(plus).toHaveAttribute('aria-disabled', 'true');
    expect(plus).not.toBeDisabled();
    expect(plus).toHaveFocus();
  });

  it('does not call onChange when disabled', async () => {
    const onChange = vi.fn();
    render(<Stepper label="Allocation" value={50} onChange={onChange} disabled />);
    await userEvent.click(screen.getByRole('button', { name: 'Increase Allocation' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
