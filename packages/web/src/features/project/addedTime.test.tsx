import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { AddedTimeCard } from './AddedTimeCard';
import { addedTimePresentation, addedTimeSpokenHeadline, type AddedTimeFacts } from './addedTime';

const MEASURED: AddedTimeFacts = {
  risk_premium_state: 'premium',
  risk_premium_days: 11,
  risk_premium_ratio: 0.09,
  risk_premium_band: null,
  risk_premium_as_of: '2026-07-27T09:12:00Z',
  risk_premium_reason: null,
  risk_premium_cpm_finish: '2026-10-24',
  risk_premium_p80: '2026-11-04',
};

function renderCard(facts: AddedTimeFacts | undefined) {
  return render(
    <MemoryRouter>
      <AddedTimeCard presentation={addedTimePresentation(facts)} base="/projects/p1" />
    </MemoryRouter>,
  );
}

function card() {
  return screen.getByRole('region', { name: /added time vs computed finish/i });
}

describe('addedTimePresentation', () => {
  it('maps a measured premium to a signed day count and a proportion', () => {
    const p = addedTimePresentation(MEASURED);
    expect(p.state).toBe('premium');
    expect(p).toMatchObject({ headline: '+11d', ratioPct: 9 });
  });

  it('states a zero premium in words — a signed "+0d" is not a reading (#2426)', () => {
    const p = addedTimePresentation({
      ...MEASURED,
      risk_premium_state: 'zero',
      risk_premium_days: 0,
    });
    expect(p).toMatchObject({ state: 'zero', headline: 'No added time' });
  });

  it('renders a negative premium with its sign intact', () => {
    const p = addedTimePresentation({
      ...MEASURED,
      risk_premium_state: 'negative',
      risk_premium_days: -4,
    });
    expect(p).toMatchObject({ state: 'negative', headline: '−4d' });
  });

  it('suppresses a stale band — a verdict cannot be stale and still be a verdict', () => {
    const p = addedTimePresentation({
      ...MEASURED,
      risk_premium_state: 'stale',
      risk_premium_band: 'Low',
    });
    expect(p).toMatchObject({ state: 'stale', band: null });
  });

  it('treats a payload with no state at all as not-run rather than guessing', () => {
    // An API older than #2483 has no `risk_premium_state`. Inferring one from the
    // absent fields would invent exactly the verdict this metric refuses to invent.
    expect(addedTimePresentation({}).state).toBe('notRun');
    expect(addedTimePresentation(undefined).state).toBe('notRun');
  });

  describe('the unmeasurable state', () => {
    const UNMEASURABLE: AddedTimeFacts = {
      ...MEASURED,
      risk_premium_state: 'unmeasurable',
      risk_premium_days: 0,
      risk_premium_ratio: null,
      risk_premium_reason: 'no_estimates',
      risk_premium_p80: null,
    };

    it('never resolves to the zero presentation, even though the premium is 0', () => {
      const p = addedTimePresentation(UNMEASURABLE);
      expect(p.state).toBe('unmeasurable');
      expect(p).not.toHaveProperty('headline');
    });

    it('refuses the reassuring reading before naming the fix', () => {
      const p = addedTimePresentation(UNMEASURABLE);
      const reason = 'reason' in p ? p.reason : '';
      // Order matters: a hurried reader who sees only the remedy first can take the
      // blank as "nothing to worry about yet".
      expect(reason.indexOf('it is no result')).toBeLessThan(reason.indexOf('Add PERT estimates'));
    });

    it('reuses the shared remedy copy per reason, never its own wording', () => {
      const p = addedTimePresentation({
        ...UNMEASURABLE,
        risk_premium_reason: 'no_velocity_history',
      });
      expect('reason' in p && p.reason).toContain('Close a sprint');
    });
  });
});

describe('addedTimeSpokenHeadline', () => {
  it('says the direction rather than leaving a screen reader to parse a sign', () => {
    expect(addedTimeSpokenHeadline('+11d')).toBe('11 days added');
    expect(addedTimeSpokenHeadline('−4d')).toBe('4 days earlier than the computed finish');
    expect(addedTimeSpokenHeadline('+1d')).toBe('1 day added');
  });

  it('leaves a worded headline alone', () => {
    expect(addedTimeSpokenHeadline('No added time')).toBe('No added time');
  });
});

describe('AddedTimeCard', () => {
  it('renders the gap together with both dates it spans', () => {
    renderCard(MEASURED);
    const c = card();
    expect(within(c).getByText('+11d')).toBeInTheDocument();
    expect(within(c).getByText('Oct 24')).toBeInTheDocument();
    expect(within(c).getByText('Nov 4')).toBeInTheDocument();
    expect(within(c).getByText('9% of remaining duration')).toBeInTheDocument();
  });

  it('collapses the band entirely when there is no verdict — no placeholder, no dash', () => {
    renderCard(MEASURED);
    // The band ships null until calibrated thresholds exist (#2299); an empty chip or
    // an em dash would read as "unknown verdict" rather than "no verdict claimed".
    expect(within(card()).queryByText('—')).toBeNull();
  });

  it('carries a contextual-help trigger explaining how the dates are computed', () => {
    renderCard(MEASURED);
    expect(
      within(card()).getByRole('button', { name: /how these dates are computed/i }),
    ).toBeInTheDocument();
  });

  describe.each([
    [
      'unmeasurable',
      {
        ...MEASURED,
        risk_premium_state: 'unmeasurable' as const,
        risk_premium_days: 0,
        risk_premium_ratio: null,
        risk_premium_reason: 'no_estimates' as const,
        risk_premium_p80: null,
      },
    ],
    ['notRun', { ...MEASURED, risk_premium_state: 'not_run' as const }],
  ])('the %s state', (_name, facts) => {
    it('prints no digit anywhere — a 0 here would be a false all-clear', () => {
      renderCard(facts);
      expect(card().textContent).not.toMatch(/\d+d\b/);
    });

    it('renders neither a proportion track nor an as-of stamp', () => {
      renderCard(facts);
      const c = card();
      expect(within(c).queryByText(/of remaining duration/)).toBeNull();
      expect(within(c).queryByText(/^as of /)).toBeNull();
    });

    it('offers the fix that matches which blank it is', () => {
      renderCard(facts);
      const expected =
        facts.risk_premium_state === 'unmeasurable' ? /add estimates/i : /run forecast/i;
      expect(within(card()).getByRole('link', { name: expected })).toBeInTheDocument();
    });
  });

  it('keeps an unestimated project visually distinct from a measured zero', () => {
    // The two carry the same number and must not carry the same presentation: one
    // says "we measured no risk", the other "we could not measure".
    const { unmount } = renderCard({
      ...MEASURED,
      risk_premium_state: 'unmeasurable',
      risk_premium_days: 0,
      risk_premium_reason: 'no_estimates',
      risk_premium_p80: null,
    });
    expect(screen.getByText("Can't be measured yet")).toBeInTheDocument();
    expect(card().className).toContain('border-dashed');
    unmount();

    renderCard({
      ...MEASURED,
      risk_premium_state: 'zero',
      risk_premium_days: 0,
      risk_premium_ratio: 0,
    });
    expect(screen.getByText('No added time')).toBeInTheDocument();
    expect(card().className).not.toContain('border-dashed');
  });

  it('promotes the run date into the P80 row when the forecast is stale', () => {
    // So the commitment date cannot be read as current.
    renderCard({ ...MEASURED, risk_premium_state: 'stale' });
    expect(within(card()).getByText(/as of Jul 27/)).toBeInTheDocument();
    expect(within(card()).getByRole('link', { name: /re-run forecast/i })).toBeInTheDocument();
  });

  it('marks a P80 that crosses into the next year, so the gap cannot read as early', () => {
    // "Oct 24 → Jan 20" without a year reads as three months *earlier*, inverting an
    // 88-day slip. The year suffix is one of the two magnitude cues this card has.
    renderCard({ ...MEASURED, risk_premium_days: 88, risk_premium_p80: '2027-01-20' });
    expect(within(card()).getByText(/Jan 20 ’27/)).toBeInTheDocument();
  });

  it('keeps both date rows in every state that prints a number', () => {
    for (const state of ['premium', 'zero', 'negative', 'stale'] as const) {
      const { unmount } = renderCard({ ...MEASURED, risk_premium_state: state });
      expect(within(card()).getByText('Computed finish')).toBeInTheDocument();
      expect(within(card()).getByText(/P80 commit/)).toBeInTheDocument();
      unmount();
    }
  });
});
