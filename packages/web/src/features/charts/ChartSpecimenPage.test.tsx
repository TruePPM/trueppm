import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HEALTH_BAND_LABEL } from '../../lib/healthBand';
import * as charts from './index';
import { ChartSpecimenPage } from './ChartSpecimenPage';

describe('ChartSpecimenPage', () => {
  it('renders every specimen section with its chart', () => {
    render(<ChartSpecimenPage />);
    expect(screen.getByRole('heading', { name: 'Chart specimens' })).toBeInTheDocument();
    for (const id of ['specimen-scurve', 'specimen-burn', 'specimen-zones', 'specimen-heat']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it('labels the risk zones with the one health-band vocabulary', () => {
    render(<ChartSpecimenPage />);
    const zones = within(screen.getByTestId('specimen-zones'));
    for (const label of Object.values(HEALTH_BAND_LABEL)) {
      expect(zones.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(zones.queryByText('Watch')).not.toBeInTheDocument();
  });
});

describe('charts barrel', () => {
  it('exports the shared chart layer', () => {
    for (const name of [
      'SCurveChart',
      'StepBurnChart',
      'RiskZoneBand',
      'HeatCellBox',
      'HeatLegend',
      'heatCell',
      'assignLabelRows',
    ]) {
      expect(charts).toHaveProperty(name);
    }
  });
});
