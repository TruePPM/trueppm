import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders as render } from '@/test/utils';
import { VELOCITY_TEAM_PRIVATE_MESSAGE, VelocityTeamPrivateNote } from './VelocityTeamPrivateNote';

describe('VelocityTeamPrivateNote', () => {
  it('renders the shared sentence behind the standard suppressed testid', () => {
    render(<VelocityTeamPrivateNote />);
    const note = screen.getByTestId('velocity-suppressed');
    expect(note).toHaveTextContent(VELOCITY_TEAM_PRIVATE_MESSAGE);
    // Rule 242 / rule 6: a house SVG, decorative — the sentence carries meaning.
    expect(note.querySelector('svg')).not.toBeNull();
    expect(note.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

/**
 * #3472's acceptance is "Board and Sprints use ONE sentence for the suppressed
 * state", and a shared constant only holds that as long as the next surface
 * imports it rather than retyping the words. So the invariant under test is
 * *"the literal is written out once"*, not "this copy is correct" — the latter is
 * the component test above.
 *
 * **State what this cannot see (rule 300).** It matches a STRING, so it catches
 * re-typing and nothing else — and re-typing was never the failure mode here;
 * divergence was. A surface stating the same ADR-0104 velocity verdict in
 * different words passes this scan silently, and four already do:
 * `MultiTeamLens` ("Team-private", a deliberately compact per-row chip),
 * `HealthCluster`'s velocity-gated row ("Kept to the team"),
 * `MilestoneBridgeForecast` ("Hidden by this team's signal settings", whose own
 * docstring argues for that wording), and — with a different SUBJECT rather than
 * a different wording — `SprintForecastWidget` / `FlowAnalyticsPanel`. Making the
 * enforceable unit a shared `SignalPrivacyNote({ subject })` that every surface in
 * the family mounts is what would close that, and it is a wider refactor than this
 * bugfix: filed as #3507, not implied. Do not read a green run here as evidence the
 * family agrees.
 *
 * A source scan rather than a lint rule: what is forbidden is a *string*, and the
 * alternative — a hand-maintained list of surfaces to check — is the enumeration
 * that let the two readings drift apart in the first place.
 */
const here = dirname(fileURLToPath(import.meta.url)); // packages/web/src/features/sprints
const SRC = resolve(here, '../..'); // packages/web/src
const OWNER = resolve(SRC, 'features/sprints/VelocityTeamPrivateNote.tsx');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

const FILES = sourceFiles(SRC).filter((f) => f !== OWNER);

describe('the team-private velocity sentence has exactly one copy', () => {
  it('is written out only in features/sprints/VelocityTeamPrivateNote.tsx', () => {
    const offenders = FILES.filter((f) =>
      readFileSync(f, 'utf8').includes(VELOCITY_TEAM_PRIVATE_MESSAGE),
    );
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });

  it('scanned a meaningful number of files (the scan itself cannot go vacuous)', () => {
    // Without this a broken path would make the assertion above pass by finding
    // nothing — the failure mode of every source-scanning test (rule 300(a)).
    // Near the real count (1230 at the time of writing), not a token floor: a
    // path bug that halved the tree would sail past `> 200`, which is the
    // vacuity the guard exists to prevent. The two anchors below are the
    // load-bearing half.
    expect(FILES.length).toBeGreaterThan(1000);
    expect(FILES.some((f) => f.endsWith('features/board/SprintPanel.tsx'))).toBe(true);
    expect(FILES.some((f) => f.endsWith('features/sprints/VelocityPanel.tsx'))).toBe(true);
  });
});
