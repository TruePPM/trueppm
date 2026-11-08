import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { HeatCellBox } from './HeatScale';
import { RiskZoneBand } from './RiskZoneBand';
import { SCurveChart, forecastToSCurveProps } from './SCurveChart';
import { StepBurnChart } from './StepBurnChart';
import { BURNDOWN, FORECAST, PROGRESS_SERIES } from './fixtures';

/** Pairs of <text> nodes whose boxes could overlap: same y and x within the label width. */
function overlappingLabels(container: HTMLElement): string[] {
  const texts = [...container.querySelectorAll('svg[role="img"] text')].filter(
    (t) => t.getAttribute('text-anchor') === 'middle' && t.getAttribute('font-weight'),
  );
  const out: string[] = [];
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i];
      const b = texts[j];
      const w = ((a.textContent ?? '').length + (b.textContent ?? '').length) * 3.5;
      if (
        a.getAttribute('y') === b.getAttribute('y') &&
        Math.abs(Number(a.getAttribute('x')) - Number(b.getAttribute('x'))) < w
      ) {
        out.push(`${a.textContent}/${b.textContent}`);
      }
    }
  }
  return out;
}

describe('SCurveChart from a provenance-shaped forecast', () => {
  it('renders the curve, band, markers and definition from the payload', async () => {
    const { container } = render(
      <SCurveChart {...forecastToSCurveProps(FORECAST, '2026-05-25')} />,
    );
    expect(screen.getByRole('img', { name: /Chance of finishing by date/ })).toBeInTheDocument();
    for (const l of ['P50', 'P80', 'P95', 'Commitment', 'Today']) {
      expect(
        within(container.querySelector('svg[role="img"]') as unknown as HTMLElement).getByText(l),
      ).toBeInTheDocument();
    }
    expect(container.querySelector('path[d^="M"]')).not.toBeNull();
    // Definition is the server's sentence, reachable by keyboard focus.
    const user = userEvent.setup();
    await user.tab();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      FORECAST.definitions?.p80 as string,
    );
  });

  it('draws no label on top of another at the sample data', () => {
    const { container } = render(
      <SCurveChart {...forecastToSCurveProps(FORECAST, '2026-05-25')} />,
    );
    expect(overlappingLabels(container)).toEqual([]);
  });

  it('degrades with an empty confidence curve (persisted history)', () => {
    const props = forecastToSCurveProps({ ...FORECAST, confidenceCurve: [] });
    const { container } = render(<SCurveChart {...props} />);
    expect(container.querySelectorAll('path.chart-line')).toHaveLength(1);
    expect(screen.getAllByText('P80').length).toBeGreaterThan(0);
  });

  it('omits the definition control when the payload has none, and carries a data table', () => {
    render(<SCurveChart {...forecastToSCurveProps({ ...FORECAST, definitions: undefined })} />);
    expect(screen.queryByRole('button', { name: /What is/ })).not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Chance of finishing by date' })).toBeInTheDocument();
  });

  it('renders planned vs actual with a legend entry per series', () => {
    render(<SCurveChart series={PROGRESS_SERIES} today="2026-05-25" />);
    expect(screen.getByText('Planned')).toBeInTheDocument();
    expect(screen.getByText('Actual')).toBeInTheDocument();
  });
});

describe('StepBurnChart', () => {
  it('draws only horizontal/vertical segments (no spline) and a marker per observation', () => {
    const { container } = render(<StepBurnChart observed={BURNDOWN} />);
    const d = container.querySelector('path.chart-line')?.getAttribute('d') ?? '';
    expect(d).toMatch(/^M[\d. ]+( [HV][\d.]+)+$/);
    expect(container.querySelectorAll('circle')).toHaveLength(BURNDOWN.length);
  });
  it('does not stack marker labels at the sample data', () => {
    const { container } = render(
      <StepBurnChart
        observed={BURNDOWN}
        markers={[
          { key: 'a', date: '2026-05-11', label: 'Review' },
          { key: 'b', date: '2026-05-12', label: 'Demo' },
        ]}
      />,
    );
    expect(overlappingLabels(container)).toEqual([]);
  });
});

describe('RiskZoneBand and heat cell', () => {
  it('names every zone as text and packs close markers onto separate rows', () => {
    const { container } = render(
      <RiskZoneBand
        zones={[
          { key: 'ok', label: 'On track', from: 0, to: 5, tone: 'ok' },
          { key: 'bad', label: 'At risk', from: 5, to: 10, tone: 'critical' },
        ]}
        markers={[
          { key: 'a', at: 2, label: 'P50' },
          { key: 'b', at: 2.1, label: 'P80' },
        ]}
      />,
    );
    expect(screen.getAllByText('On track').length).toBeGreaterThan(0);
    expect(screen.getAllByText('At risk').length).toBeGreaterThan(0);
    expect(overlappingLabels(container)).toEqual([]);
  });
  it('heat cell states the value and the band in its accessible name', () => {
    render(<HeatCellBox loadPct={130} label="Ana" />);
    expect(screen.getByRole('img', { name: /Ana: 130%.*over-allocated/ })).toBeInTheDocument();
  });
});
