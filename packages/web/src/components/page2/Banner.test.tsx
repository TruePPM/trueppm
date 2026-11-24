import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Banner } from './Banner';

describe('Banner', () => {
  it('a critical banner is an alert with a glyph and words', () => {
    render(<Banner tone="critical">Update 7 didn’t post</Banner>);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('▲Update 7 didn’t post');
  });

  it('other tones are polite status and carry one action', () => {
    render(
      <Banner tone="info" action={<button type="button">Retry</button>}>
        Saved
      </Banner>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
