import { describe, it, expect } from 'vitest';
import type { QuietHoursTimezoneSource } from '@/api/types';
import { quietHoursTimezoneCopy } from './quietHoursTimezone';

/**
 * #3397 — the resolved quiet-hours timezone caption.
 *
 * Parametrized over the WHOLE `QuietHoursTimezoneSource` union rather than the
 * two tiers that occur in normal operation: `server` and `fallback` are the
 * degradation tiers, they are exactly the ones no fixture naturally produces,
 * and a tier the helper cannot describe silently renders nothing — which is
 * indistinguishable from the pre-#3397 page. The denominator is asserted so a
 * future tier added to the union without a case here fails loudly instead of
 * passing vacuously.
 */
const ALL_SOURCES: QuietHoursTimezoneSource[] = ['project', 'workspace', 'server', 'fallback'];

describe('quietHoursTimezoneCopy', () => {
  it('covers every tier of the union', () => {
    // Guards against a vacuous pass: if a tier is added to the union and not to
    // this list, the per-tier assertions below stop being exhaustive silently.
    expect(ALL_SOURCES).toHaveLength(4);
    expect(new Set(ALL_SOURCES).size).toBe(ALL_SOURCES.length);
  });

  it.each(ALL_SOURCES)('names the resolved zone for source=%s', (source) => {
    const copy = quietHoursTimezoneCopy('Asia/Tokyo', source);
    expect(copy).not.toBeNull();
    // The zone is the answer to the member's actual question ("20:00 where?"),
    // so it must survive on EVERY tier — including the degradation ones, where
    // the temptation is to suppress the line entirely.
    expect(copy).toContain('Asia/Tokyo');
  });

  it('attributes a project-set zone to the project', () => {
    expect(quietHoursTimezoneCopy('Asia/Tokyo', 'project')).toBe(
      "Times are in Asia/Tokyo — this project's timezone.",
    );
  });

  it('attributes an inherited zone to the workspace, so a member knows who to ask', () => {
    expect(quietHoursTimezoneCopy('Europe/Berlin', 'workspace')).toBe(
      'Times are in Europe/Berlin — the workspace default timezone. This project sets no usable timezone of its own.',
    );
  });

  it('says "no usable timezone", never "no timezone", for the scopes that lost', () => {
    // A scope that stores an UNPARSEABLE zone also loses its tier — the server
    // logs and walks to the next one — so "sets none" would be a false claim
    // about a project or workspace that did set a (broken) value.
    expect(quietHoursTimezoneCopy('Europe/Berlin', 'workspace')).toContain('no usable timezone');
    expect(quietHoursTimezoneCopy('UTC', 'server')).toContain('a usable timezone');
    expect(quietHoursTimezoneCopy('Europe/Berlin', 'workspace')).not.toMatch(
      /sets no timezone|sets none of its own/,
    );
  });

  it('describes the server tier without naming a lever the member cannot pull', () => {
    const copy = quietHoursTimezoneCopy('America/New_York', 'server');
    expect(copy).toBe(
      'Times are in America/New_York — the server default. Neither this project nor the workspace sets a usable timezone.',
    );
    // Rule 274's spirit: no in-app "fix it here" for a deploy-time value, and no
    // raw env-var name leaked onto a page every project member opens.
    expect(copy).not.toMatch(/TIME_ZONE|Django|settings\./);
  });

  it('describes the fallback tier as unread, not as a deliberate UTC choice', () => {
    expect(quietHoursTimezoneCopy('UTC', 'fallback')).toBe(
      'Times are in UTC — no project, workspace, or server timezone could be read.',
    );
  });

  it.each(ALL_SOURCES)('reads as prose, not a diagnostic dump, for source=%s', (source) => {
    // The tiers are wire vocabulary; a member-facing page states them in
    // English. `project` and `workspace` are legitimate words in that English,
    // so the invariant is the SHAPE — a full sentence — not the absence of a
    // substring. Rendering "source: fallback" would fail both clauses.
    const copy = quietHoursTimezoneCopy('Asia/Tokyo', source) ?? '';
    expect(copy.startsWith('Times are in Asia/Tokyo')).toBe(true);
    expect(copy.endsWith('.')).toBe(true);
    expect(copy).not.toMatch(/source|_|[{}[\]]/);
  });

  it('stays silent when the response predates #3377 rather than guessing UTC', () => {
    // A cached pre-#3377 document carries neither field. Rendering "(undefined)"
    // — or defaulting to UTC — would state a zone the server never claimed.
    expect(quietHoursTimezoneCopy(undefined, undefined)).toBeNull();
    expect(quietHoursTimezoneCopy(undefined, 'project')).toBeNull();
    expect(quietHoursTimezoneCopy('Asia/Tokyo', undefined)).toBeNull();
    expect(quietHoursTimezoneCopy('', 'project')).toBeNull();
  });

  it('claims nothing for a tier a newer server invented', () => {
    expect(
      quietHoursTimezoneCopy('Asia/Tokyo', 'region' as unknown as QuietHoursTimezoneSource),
    ).toBeNull();
  });
});
