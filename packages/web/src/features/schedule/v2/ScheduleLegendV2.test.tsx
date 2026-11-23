import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { LEGEND_ENTRIES, ScheduleLegendV2 } from './ScheduleLegendV2';

describe('ScheduleLegendV2 (#4796)', () => {
  it('lists Critical, Near-critical, Baseline and Today, each as swatch + glyph + word', () => {
    render(<ScheduleLegendV2 placement="bar" baselineShown />);
    const list = screen.getByRole('list', { name: 'Schedule legend' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      '▲Critical',
      '◆Near-critical',
      '▭Baseline',
      '│Today',
    ]);
    for (const li of items) {
      expect(li.querySelector('[data-swatch]')).not.toBeNull();
      expect(li.querySelector('[data-glyph]')?.textContent).not.toBe('');
    }
  });

  it('keeps critical and near-critical distinguishable without hue (grayscale)', () => {
    const critical = LEGEND_ENTRIES.find((e) => e.key === 'critical')!;
    const near = LEGEND_ENTRIES.find((e) => e.key === 'near-critical')!;
    // Line pattern differs…
    expect(critical.swatch).toContain('border-solid');
    expect(near.swatch).toContain('border-dashed');
    // …fill differs…
    expect(critical.swatch).toMatch(/\bbg-critical/);
    expect(near.swatch).toContain('bg-transparent');
    // …and the glyph differs.
    expect(critical.glyph).not.toBe(near.glyph);
  });

  it('names only marks on screen: no Baseline entry when no baseline is drawn', () => {
    render(<ScheduleLegendV2 placement="timeline-header" baselineShown={false} />);
    const list = screen.getByRole('list', { name: 'Schedule legend' });
    expect(list).toHaveAttribute('data-placement', 'timeline-header');
    expect(within(list).queryByText('Baseline')).toBeNull();
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
  });
});
