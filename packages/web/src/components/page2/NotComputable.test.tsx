import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NotComputable } from './NotComputable';

describe('NotComputable (rule 439, narrows rule 119)', () => {
  it('is one dashed-top line naming the metric, the missing input and the fix', () => {
    render(
      <NotComputable
        label="Schedule variance"
        missing="no baseline is set"
        fix={<button type="button">Set a baseline</button>}
      />,
    );
    const line = screen.getByTestId('not-computable');
    expect(line.tagName).toBe('P');
    expect(line).toHaveClass('border-t', 'border-dashed');
    expect(line).toHaveTextContent(
      'Schedule variance can’t be computed: no baseline is set. Set a baseline',
    );
    expect(screen.getByRole('button', { name: 'Set a baseline' })).toBeInTheDocument();
  });
});
