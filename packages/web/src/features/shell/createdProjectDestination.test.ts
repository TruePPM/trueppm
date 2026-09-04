import { describe, expect, it } from 'vitest';
import { createdProjectDestination } from './createdProjectDestination';

describe('createdProjectDestination', () => {
  it('lands on Overview when no intent is given', () => {
    expect(createdProjectDestination('p1')).toBe('/projects/p1/overview');
  });

  it('lands on Overview for an intent that asks for nothing (empty object)', () => {
    // The import way's non-CSV fallthrough. Blank no longer reaches here — it
    // carries its own flag (#3311) — so this pins the genuine default.
    expect(createdProjectDestination('p1', {})).toBe('/projects/p1/overview');
  });

  // #3311. The Blank card promised "straight into the outline" from the day the
  // Start sheet shipped; this function returned Overview from the day it was
  // introduced, one day apart. These pin the two together.
  it('lands a blank WATERFALL project on the Schedule outline (#3311)', () => {
    expect(createdProjectDestination('p1', { blank: true, methodology: 'WATERFALL' })).toBe(
      '/projects/p1/schedule',
    );
  });

  it('lands a blank HYBRID project on the Schedule outline (#3311)', () => {
    expect(createdProjectDestination('p1', { blank: true, methodology: 'HYBRID' })).toBe(
      '/projects/p1/schedule',
    );
  });

  it('lands a blank AGILE project on the product backlog, not the hidden Schedule', () => {
    // methodologyTabs.ts hides the Schedule for AGILE and the route answers a
    // direct URL with "Schedule isn't part of this project's workflow" (#2619) —
    // routing there would trade a wrong landing for a dead end.
    expect(createdProjectDestination('p1', { blank: true, methodology: 'AGILE' })).toBe(
      '/projects/p1/product-backlog',
    );
  });

  it('does not mark a blank backlog as seeding', () => {
    // `?seeding=1` tells ProductBacklogPage an empty backlog is still filling from
    // a template apply. Nothing is being applied on a blank create, so the genuine
    // empty state is the correct and only honest one.
    expect(createdProjectDestination('p1', { blank: true, methodology: 'AGILE' })).not.toContain(
      'seeding',
    );
  });

  it('prefers the CSV wizard over the blank landing if both were somehow set', () => {
    expect(
      createdProjectDestination('p1', { importCsv: true, blank: true, methodology: 'WATERFALL' }),
    ).toBe('/projects/p1/schedule?import=csv');
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

  it('lands a WATERFALL template application on the seeded Schedule (#2731)', () => {
    expect(
      createdProjectDestination('p1', {
        templateApplied: true,
        methodology: 'WATERFALL',
        templateApplicationId: 'app-1',
      }),
    ).toBe('/projects/p1/schedule?templateApplication=app-1');
  });

  it('lands a HYBRID template application on the seeded Schedule (#2731)', () => {
    expect(
      createdProjectDestination('p1', {
        templateApplied: true,
        methodology: 'HYBRID',
        templateApplicationId: 'app-2',
      }),
    ).toBe('/projects/p1/schedule?templateApplication=app-2');
  });

  it('falls back to Overview when the apply dispatch failed and left no id to poll', () => {
    // `templateApplied` without `templateApplicationId` is the 202-never-resolved
    // case: landing on the seed banner would show a poll that can never complete.
    expect(
      createdProjectDestination('p1', { templateApplied: true, methodology: 'WATERFALL' }),
    ).toBe('/projects/p1/overview');
  });

  it('keeps an AGILE template on the backlog even when an application id is present', () => {
    // The two seeded landings are gated on methodology, not on which field is set —
    // an agile template must not be routed to the schedule seed banner.
    expect(
      createdProjectDestination('p1', {
        templateApplied: true,
        methodology: 'AGILE',
        templateApplicationId: 'app-3',
      }),
    ).toBe('/projects/p1/product-backlog?seeding=1');
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
