import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NonHumanTile } from './NonHumanTile';

describe('NonHumanTile', () => {
  it.each(['bot', 'cpu', 'cog', 'hard-hat'] as const)(
    'draws a labeled square icon tile for %s, with no text and no circle',
    (kind) => {
      render(<NonHumanTile kind={kind} label={`Agent: ${kind}`} />);
      const tile = screen.getByRole('img', { name: `Agent: ${kind}` });
      expect(tile.textContent).toBe('');
      expect(tile.querySelector('svg')).not.toBeNull();
      expect(tile.className).not.toContain('rounded-full');
    },
  );
});
