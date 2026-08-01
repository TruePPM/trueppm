import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ForecastHorizonHelp } from './ForecastHorizonHelp';
import { findMissingForecastHorizonMounts } from './forecastHorizonMountGate';

/**
 * #2495 — the affordance that keeps a clamped Monte Carlo percentile from reading as
 * an unbiased one. The assertions that matter are about *copy direction*: the caveat
 * has to say the number is a floor (true value is later, never earlier). A test that
 * only checked "some help text renders" would pass on copy that said the opposite.
 */
describe('ForecastHorizonHelp', () => {
  it('is collapsed until invoked, so it never competes with the figure it annotates', () => {
    render(<ForecastHorizonHelp basis="velocity" />);
    expect(screen.getByRole('button', { name: /forecast horizon/i })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says the velocity percentile is a floor, and which direction the bias runs', async () => {
    const user = userEvent.setup();
    render(<ForecastHorizonHelp basis="velocity" />);
    await user.click(screen.getByRole('button', { name: /forecast horizon/i }));

    const dialog = screen.getByRole('dialog');
    const text = dialog.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(text).toContain('floor');
    // The direction is the whole point — an "approximate" hedge would be wrong.
    expect(text).toContain('this date or later, never earlier');
    // Names the clamp as the cause rather than vaguely blaming uncertainty.
    expect(text).toMatch(/stops at a fixed sprint horizon/i);
    // Gives the reader a way out, not just a warning.
    expect(text).toMatch(/three-point \(PERT\)/i);
  });

  it('speaks flow vocabulary on the throughput basis and never claims sprints', async () => {
    const user = userEvent.setup();
    render(<ForecastHorizonHelp basis="throughput" />);
    await user.click(screen.getByRole('button', { name: /forecast horizon/i }));

    const text = screen.getByRole('dialog').textContent?.replace(/\s+/g, ' ') ?? '';
    expect(text).toMatch(/weekly throughput/i);
    expect(text).toMatch(/stops at a fixed week horizon/i);
    // web-rule 176: a flow-basis surface never borrows sprint vocabulary.
    expect(text).not.toMatch(/sprint/i);
  });

  it('links out to the docs section that substantiates the claim', async () => {
    const user = userEvent.setup();
    render(<ForecastHorizonHelp basis="velocity" />);
    await user.click(screen.getByRole('button', { name: /forecast horizon/i }));

    const link = screen.getByRole('link', { name: /why this is a floor/i });
    expect(link.getAttribute('href')).toContain(
      'features/monte-carlo/#velocity-and-throughput-forecasts-are-a-floor',
    );
    // Opens out of the app; rel must accompany target (no reverse-tabnabbing).
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});

/**
 * Mount gate (#2495 mount list, #2643, #2653). Both prior misses were sites that
 * read a clamped-sampler forecast (`useSprintForecast`) and rendered its
 * percentiles without importing this component — nothing caught either until a
 * VoC panel went looking by hand. `findMissingForecastHorizonMounts` is the
 * predicate; see its doc comment for exactly which hook is the signal and why
 * `useProjectForecast`'s `sprints_to_complete_*` is deliberately out of scope.
 */
describe('ForecastHorizonHelp mount gate (#2653)', () => {
  it('flags a synthetic file that reads useSprintForecast() without mounting the caveat', () => {
    const offenders = findMissingForecastHorizonMounts({
      'features/example/BadForecastCard.tsx': `
        export function BadForecastCard({ projectId }) {
          const { data } = useSprintForecast(projectId);
          return <p>P50 {data.p50_date}</p>;
        }
      `,
    });
    expect(offenders).toEqual(['features/example/BadForecastCard.tsx']);
  });

  it('does not flag a synthetic file that mounts the caveat alongside useSprintForecast()', () => {
    const offenders = findMissingForecastHorizonMounts({
      'features/example/GoodForecastCard.tsx': `
        export function GoodForecastCard({ projectId }) {
          const { data } = useSprintForecast(projectId);
          return (
            <>
              <p>P50 {data.p50_date}</p>
              <ForecastHorizonHelp basis="velocity" />
            </>
          );
        }
      `,
    });
    expect(offenders).toEqual([]);
  });

  it('does not flag a synthetic file that never calls useSprintForecast()', () => {
    const offenders = findMissingForecastHorizonMounts({
      'features/example/UnrelatedCard.tsx': `
        export function UnrelatedCard({ projectId }) {
          const { data } = useProjectForecast(projectId);
          return <p>{data.sprints_to_complete_low}</p>;
        }
      `,
    });
    expect(offenders).toEqual([]);
  });

  it('every real source file calling useSprintForecast() also mounts ForecastHorizonHelp', () => {
    const modules = import.meta.glob('../../**/*.tsx', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const sourceFiles: Record<string, string> = {};
    for (const [path, source] of Object.entries(modules)) {
      if (typeof source === 'string') sourceFiles[path] = source;
    }
    expect(findMissingForecastHorizonMounts(sourceFiles)).toEqual([]);
  });

  it('mounts exactly the known set of forecast-caveat sites — a new one must be a deliberate edit here', () => {
    const modules = import.meta.glob('../../**/*.tsx', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    // import.meta.glob keys are relative to this file's own directory
    // (features/sprints/), e.g. './SprintForecastChips.tsx' for a sibling and
    // '../board/FlowAnalyticsPanel.tsx' for a cousin feature directory.
    const mounted = Object.entries(modules)
      .filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && /<ForecastHorizonHelp\b/.test(entry[1]),
      )
      .map(([path]) => path)
      .sort();
    expect(mounted).toEqual(
      [
        '../board/FlowAnalyticsPanel.tsx',
        '../project/SprintForecastWidget.tsx',
        './SprintForecastChips.tsx',
      ].sort(),
    );
  });
});
