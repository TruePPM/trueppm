import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReasonRadioGroup } from './ReasonRadioGroup';

describe('ReasonRadioGroup', () => {
  it('names each radio by its label, describes it by its hint, and reports the choice', async () => {
    const onChange = vi.fn();
    render(
      <ReasonRadioGroup
        legend="Why did it move?"
        name="reason"
        value={null}
        onChange={onChange}
        options={[
          { value: 'scope', label: 'Scope added', hint: 'New work arrived' },
          { value: 'estimate', label: 'Estimate was wrong' },
        ]}
      />,
    );
    expect(screen.getByRole('group', { name: 'Why did it move?' })).toBeInTheDocument();
    const scope = screen.getByRole('radio', { name: 'Scope added' });
    expect(scope).toHaveAccessibleDescription('New work arrived');
    expect(scope).not.toBeChecked();
    await userEvent.click(screen.getByText('Estimate was wrong'));
    expect(onChange).toHaveBeenCalledWith('estimate');
  });
});
