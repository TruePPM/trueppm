import { describe, expect, it } from 'vitest';
import { createdProjectDestination } from './createdProjectDestination';

describe('createdProjectDestination', () => {
  it('lands on Overview when no intent is given', () => {
    expect(createdProjectDestination('p1')).toBe('/projects/p1/overview');
  });

  it('lands on Overview for a blank-project intent (empty object)', () => {
    expect(createdProjectDestination('p1', {})).toBe('/projects/p1/overview');
  });

  it('opens the CSV import wizard on the Schedule when importCsv is set', () => {
    expect(createdProjectDestination('p1', { importCsv: true })).toBe(
      '/projects/p1/schedule?import=csv',
    );
  });

  it('lands an AGILE template application on the seeding backlog (#2734)', () => {
    expect(
      createdProjectDestination('p1', { templateApplied: true, methodology: 'AGILE' }),
    ).toBe('/projects/p1/product-backlog?seeding=1');
  });

  it('lands a WATERFALL template application on Overview — not this issue’s branch', () => {
    expect(
      createdProjectDestination('p1', { templateApplied: true, methodology: 'WATERFALL' }),
    ).toBe('/projects/p1/overview');
  });

  it('lands a HYBRID template application on Overview — not this issue’s branch', () => {
    expect(
      createdProjectDestination('p1', { templateApplied: true, methodology: 'HYBRID' }),
    ).toBe('/projects/p1/overview');
  });

  it('does not route to the backlog when methodology is AGILE but no template was applied', () => {
    expect(createdProjectDestination('p1', { methodology: 'AGILE' })).toBe(
      '/projects/p1/overview',
    );
  });

  it('prefers importCsv over a template-applied agile landing if both were somehow set', () => {
    expect(
      createdProjectDestination('p1', {
        importCsv: true,
        templateApplied: true,
        methodology: 'AGILE',
      }),
    ).toBe('/projects/p1/schedule?import=csv');
  });
});
