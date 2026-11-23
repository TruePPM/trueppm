import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { LEGEND_ENTRIES, ScheduleLegendV2 } from './ScheduleLegendV2';
import { COLOR, COLOR_DARK } from '../engine/GanttRenderer';

describe('ScheduleLegendV2 (#4796)', () => {
  it('lists Critical, Near-critical, Baseline and Today, each as swatch + word', () => {
    render(<ScheduleLegendV2 placement="bar" baselineShown />);
    const list = screen.getByRole('list', { name: 'Schedule legend' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Critical',
      'Near-critical',
      'Baseline',
      'Today',
    ]);
    for (const li of items) {
      expect(li.querySelector('[data-swatch]')).not.toBeNull();
      // No glyph is keyed until the canvas or a column prints one (#4796 G3).
      expect(li.querySelector('[data-glyph]')).toBeNull();
    }
  });

  it('keeps critical and near-critical distinguishable without hue (grayscale)', () => {
    const critical = LEGEND_ENTRIES.find((e) => e.key === 'critical')!;
    const near = LEGEND_ENTRIES.find((e) => e.key === 'near-critical')!;
    // Line pattern differs…
    expect(critical.swatch).toContain('border-solid');
    expect(near.swatch).toContain('border-dashed');
    // Both are frames, as on the canvas, where the bar's fill still shows its
    // state: a filled swatch would key a mark the canvas never draws.
    expect(critical.swatch).toContain('bg-transparent');
    expect(near.swatch).toContain('bg-transparent');
    expect(critical.swatch).not.toMatch(/\bbg-critical/);
  });

  it("draws its frames in the canvas renderer's own colors, light and dark", () => {
    render(<ScheduleLegendV2 placement="bar" baselineShown={false} />);
    const swatch = (key: string) =>
      document.querySelector<HTMLElement>(`[data-legend="${key}"] [data-swatch]`)!;
    expect(swatch('critical').style.getPropertyValue('--legend-light')).toBe(COLOR.barCritical);
    expect(swatch('critical').style.getPropertyValue('--legend-dark')).toBe(COLOR_DARK.barCritical);
    expect(swatch('near-critical').style.getPropertyValue('--legend-light')).toBe(
      COLOR.barNearCritical,
    );
    expect(swatch('near-critical').style.getPropertyValue('--legend-dark')).toBe(
      COLOR_DARK.barNearCritical,
    );
    expect(swatch('near-critical').className).toContain('border-[color:var(--legend-light)]');
    expect(swatch('near-critical').className).toContain('dark:border-[color:var(--legend-dark)]');
  });

  it('names only marks on screen: no Baseline entry when no baseline is drawn', () => {
    render(<ScheduleLegendV2 placement="timeline-header" baselineShown={false} />);
    const list = screen.getByRole('list', { name: 'Schedule legend' });
    expect(list).toHaveAttribute('data-placement', 'timeline-header');
    expect(within(list).queryByText('Baseline')).toBeNull();
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
  });
});
