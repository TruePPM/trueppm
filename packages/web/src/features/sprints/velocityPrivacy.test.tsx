import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders as render } from '@/test/utils';
import { VELOCITY_TEAM_PRIVATE_MESSAGE, VelocityTeamPrivateNote } from './velocityPrivacy';

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
 * imports it rather than retyping the words. The Board and the Sprints panel each
 * had their own reading of the same server verdict before this change, which is
 * exactly how they came to disagree — so the invariant under test is *"there is
 * only one copy of the sentence"*, not "this copy is correct".
 *
 * A source scan rather than a lint rule: what is forbidden is a *string*, and the
 * alternative — a hand-maintained list of surfaces to check — is the enumeration
 * that let the two readings drift apart in the first place.
 */
const here = dirname(fileURLToPath(import.meta.url)); // packages/web/src/features/sprints
const SRC = resolve(here, '../..'); // packages/web/src
const OWNER = resolve(SRC, 'features/sprints/velocityPrivacy.tsx');

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
  it('is written out only in features/sprints/velocityPrivacy.tsx', () => {
    const offenders = FILES.filter((f) =>
      readFileSync(f, 'utf8').includes(VELOCITY_TEAM_PRIVATE_MESSAGE),
    );
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });

  it('scanned a meaningful number of files (the scan itself cannot go vacuous)', () => {
    // Without this a broken path would make the assertion above pass by finding
    // nothing — the failure mode of every source-scanning test (rule 300(a)).
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES.some((f) => f.endsWith('features/board/SprintPanel.tsx'))).toBe(true);
    expect(FILES.some((f) => f.endsWith('features/sprints/VelocityPanel.tsx'))).toBe(true);
  });
});
