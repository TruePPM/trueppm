import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HEALTH_BAND_LABEL } from '@/lib/healthBand';
import { HealthBandChip, STATUS_GLYPH, StatusChip, type StatusTone } from './StatusChip';

const TONES: StatusTone[] = ['critical', 'blocked', 'risk', 'ok', 'info', 'neutral'];

describe('StatusChip (rule 440)', () => {
  it.each(TONES)('%s carries a glyph beside its word', (tone) => {
    render(<StatusChip tone={tone} label="Word" data-testid="chip" />);
    const chip = screen.getByTestId('chip');
    expect(chip).toHaveTextContent(`${STATUS_GLYPH[tone]}Word`);
    expect(chip.querySelector('[aria-hidden="true"]')).toHaveTextContent(STATUS_GLYPH[tone]);
  });

  it('red is critical and blocked only; amber is risk', () => {
    const cls = (tone: StatusTone) => {
      const { unmount } = render(<StatusChip tone={tone} label="x" data-testid={tone} />);
      const c = screen.getByTestId(tone).className;
      unmount();
      return c;
    };
    expect(cls('critical')).toContain('text-p1-critical');
    expect(cls('blocked')).toContain('text-p1-critical');
    for (const t of ['risk', 'ok', 'info', 'neutral'] as const) {
      expect(cls(t)).not.toContain('critical');
    }
    expect(cls('risk')).toContain('text-p1-risk-text');
  });

  it('never wears the brand color', () => {
    for (const tone of TONES) {
      const { unmount } = render(<StatusChip tone={tone} label="x" data-testid="c" />);
      expect(screen.getByTestId('c').className).not.toMatch(/brand/);
      unmount();
    }
  });
});

describe('HealthBandChip (rule 442)', () => {
  it.each([
    ['critical', 'critical'],
    ['at_risk', 'risk'],
    ['on_track', 'ok'],
  ] as const)('presents the server band %s as the %s tone with the shared word', (band, tone) => {
    render(<HealthBandChip band={band} data-testid="h" />);
    const chip = screen.getByTestId('h');
    expect(chip).toHaveAttribute('data-tone', tone);
    expect(chip).toHaveTextContent(HEALTH_BAND_LABEL[band]);
  });
});
