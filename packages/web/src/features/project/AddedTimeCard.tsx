import { Link } from 'react-router';

import { ForecastBasisHelp } from '@/features/schedule/ForecastBasisHelp';
import {
  ADDED_TIME_LABEL,
  ADDED_TIME_LABEL_QUALIFIED,
  addedTimeSpokenHeadline,
  formatEndpoint,
  type AddedTimePresentation,
  type AddedTimeNotRun,
  type AddedTimeUnmeasurable,
} from './addedTime';

/**
 * "Added time" on the project Overview — the gap between the computed (CPM) finish
 * and the P80 commitment date, rendered as the relationship it is (#2483).
 *
 * Why a relationship card rather than a number in the KPI row. A bare `+11d` is an
 * unverifiable delta: nothing on screen says what it is measured against, and the
 * natural wrong guess (that it is relative to the neighbouring card) makes a correct
 * figure look like a bug — the defect #2426 fixed on the schedule chip row. The gap
 * is also the product claim in full: *your plan says Oct 24; commit to Nov 4*. A
 * single number makes the reader reconstruct that sentence from memory. So both
 * dates render inside the card, each labelled with its role in the gap, and they are
 * the last thing to shed at any width.
 *
 * Severity carries no health hue. The Overview health cluster already spends
 * on-track / at-risk / critical on schedule health, late tasks and risks; a fourth
 * coloured signal turns the row into a traffic-light wall where nothing is loudest.
 * Magnitude reads through the proportion track and the crossed year boundary in the
 * P80 row instead, and operational states (not run, stale, unmeasurable) take neutral
 * secondary ink, which cannot be mistaken for a verdict.
 */

interface AddedTimeCardProps {
  presentation: AddedTimePresentation;
  /** Project-scoped base path, e.g. `/projects/{id}`. Omitted pre-load. */
  base?: string;
  /**
   * The server's forecast-staleness verdict, when the caller has it (#3140).
   *
   * `presentation.state === 'stale'` is age-only — `risk_premium_state` marks a run
   * stale after a week and knows nothing about the plan moving underneath it. Callers
   * that hold the forecast payload can pass the broader verdict here so the action
   * reads `Re-run forecast` in the case that most warrants it: a run superseded
   * minutes ago. It deliberately affects ONLY the link label, not the as-of layout,
   * so a caller that does not pass it renders exactly as before.
   */
  forecastStale?: boolean;
}

const CARD_BASE =
  'flex flex-col gap-2 p-5 rounded-card border bg-neutral-surface-raised min-w-0 overflow-hidden';

/**
 * Label + the contextual-help trigger. The card never explains itself inline; the
 * arithmetic behind the gap lives in one place, and this is the way in.
 *
 * The visible label is `aria-hidden`: the enclosing `<section>` is a landmark whose
 * `aria-label` already names it, and a landmark's name does not suppress its
 * descendants, so leaving both readable announces "Added time" twice (rule 171). The
 * responsive pair is the rule-161 abbreviation pattern — both spans are always in the
 * DOM, only one is displayed — which is a second reason the text cannot stay exposed.
 */
function CardTitle() {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span
        aria-hidden="true"
        className="text-xs font-medium uppercase tracking-wide text-neutral-text-secondary truncate"
      >
        {/* The qualifier drops below `md` where the column is too narrow to hold it;
            the term itself never changes, so the user learns one name (#2483). */}
        <span className="hidden md:inline">{ADDED_TIME_LABEL_QUALIFIED}</span>
        <span className="md:hidden">{ADDED_TIME_LABEL}</span>
      </span>
      <ForecastBasisHelp />
    </div>
  );
}

/**
 * The two endpoints of the gap, each named by its role.
 *
 * These never shed. A container too small to hold the number plus both rows does not
 * render this card at all — a card carrying a delta without its baseline is the
 * #2426 defect, and a link to the forecast is better than a misleading figure.
 */
function EndpointRows({
  cpmFinish,
  p80,
  p80Label,
  asOfLabel,
}: {
  cpmFinish: string;
  p80: string | null;
  p80Label: string;
  asOfLabel?: string;
}) {
  return (
    <dl className="flex flex-col gap-1 pt-2 border-t border-neutral-border">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-xs text-neutral-text-secondary">Computed finish</dt>
        <dd className="text-xs tppm-mono text-neutral-text-primary">
          {formatEndpoint(cpmFinish, cpmFinish)}
        </dd>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-xs text-neutral-text-secondary truncate">
          {p80Label}
          {/* On a stale card the run date is promoted into this label so the
              commitment date cannot be read as current (#2483 state 6). */}
          {asOfLabel && <span className="text-neutral-text-secondary"> · as of {asOfLabel}</span>}
        </dt>
        <dd
          className={`text-xs tppm-mono ${p80 ? 'text-neutral-text-primary' : 'text-neutral-text-secondary'}`}
        >
          {p80 ? formatEndpoint(p80, cpmFinish) : 'no forecast to compare'}
        </dd>
      </div>
    </dl>
  );
}

/**
 * Share of remaining duration, as a track plus its printed number.
 *
 * The track is decorative — the percentage is always written beside it, so the
 * proportion is never carried by a visual channel alone (rule 6). It renders only
 * for states that actually measured something.
 */
function ProportionTrack({ pct, label }: { pct: number; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div
        aria-hidden="true"
        className="h-1 flex-1 rounded-chip bg-neutral-surface-sunken overflow-hidden"
      >
        <div
          className="h-full bg-neutral-text-secondary"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
      <span className="text-xs text-neutral-text-secondary tppm-mono shrink-0">{label}</span>
    </div>
  );
}

/**
 * The two "no number yet" states.
 *
 * Structurally distinct from a measured zero, not just worded differently: no
 * digit, no track, no as-of stamp, and a dashed frame. That is what stops "we
 * have not measured this" from reading as "we measured no risk". Each state
 * offers the one action that would produce a number — estimates or a forecast
 * run.
 */
function AddedTimeEmptyCard({
  presentation,
  base,
}: {
  // Narrowed to the two empty variants: the caller has already tested `state`,
  // and only these carry `reason`.
  presentation: AddedTimeUnmeasurable | AddedTimeNotRun;
  base: string | undefined;
}) {
  const isUnmeasurable = presentation.state === 'unmeasurable';
  const action = isUnmeasurable
    ? { label: 'Add estimates', to: base ? `${base}/grid` : undefined }
    : { label: 'Run forecast', to: base ? `${base}/schedule` : undefined };

  return (
    <section
      aria-label={ADDED_TIME_LABEL_QUALIFIED}
      className={`${CARD_BASE} border-dashed border-neutral-border`}
    >
      <CardTitle />
      <p className="text-sm font-semibold text-neutral-text-primary">
        {isUnmeasurable ? "Can't be measured yet" : 'Not run yet'}
      </p>
      {/* The reason sentence is the content here — there is no number to explain,
          and it never truncates at any width (#2483 D3). */}
      <p className="text-xs text-neutral-text-secondary">{presentation.reason}</p>
      {presentation.endpoints && (
        <EndpointRows
          cpmFinish={presentation.endpoints.cpmFinish}
          p80={presentation.endpoints.p80}
          p80Label="P80 commit"
        />
      )}
      {action.to && (
        <Link
          to={action.to}
          className="mt-auto inline-flex items-center min-h-[44px] text-xs font-medium text-brand-primary
            underline-offset-2 hover:underline rounded-control
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          {action.label} →
        </Link>
      )}
    </section>
  );
}

export function AddedTimeCard({ presentation, base, forecastStale }: AddedTimeCardProps) {
  // Empty states are structurally distinct from a measured zero, not just worded
  // differently: no digit, no track, no as-of stamp, and a dashed frame. That is what
  // stops "we have not measured this" from reading as "we measured no risk".
  if (presentation.state === 'notRun' || presentation.state === 'unmeasurable') {
    return <AddedTimeEmptyCard presentation={presentation} base={base} />;
  }

  const { headline, endpoints, ratioPct, ratioLabel, asOf, band, state } = presentation;
  const isStale = state === 'stale';
  // The link's own predicate — see `forecastStale` on the props. Broader than
  // `isStale`, and only ever used for the label.
  const offerRerun = isStale || forecastStale === true;
  const isNumeric = headline !== 'No added time';
  const spoken = addedTimeSpokenHeadline(headline);

  return (
    <section
      aria-label={ADDED_TIME_LABEL_QUALIFIED}
      className={`${CARD_BASE} border-neutral-border`}
    >
      <CardTitle />

      <div className="flex items-baseline gap-2 flex-wrap">
        <span
          className={`font-semibold leading-tight ${isNumeric ? 'tppm-mono text-2xl' : 'text-lg'} ${
            // Stale drops to secondary ink with a dotted underline: the number is
            // still true, but it describes a schedule that has since had time to move.
            isStale
              ? 'text-neutral-text-secondary underline decoration-dotted underline-offset-4'
              : 'text-neutral-text-primary'
          }`}
        >
          {/* A signed count needs a spoken alternative — the sign is the meaning, and
              some readers drop it from "−11d" (rule 6). A worded headline already
              reads correctly, so it renders once: swapping in an identical sr-only
              copy would announce it twice for no gain. */}
          {spoken === headline ? (
            headline
          ) : (
            <>
              <span aria-hidden="true">{headline}</span>
              <span className="sr-only">{spoken}</span>
            </>
          )}
        </span>
        {band && (
          <span className="text-xs font-medium px-2 py-0.5 rounded-chip bg-neutral-surface-sunken text-neutral-text-primary">
            {band}
          </span>
        )}
      </div>

      {state === 'negative' && (
        <p className="text-xs text-neutral-text-secondary">P80 lands before the computed finish.</p>
      )}

      <EndpointRows
        cpmFinish={endpoints.cpmFinish}
        p80={endpoints.p80}
        p80Label="P80 commit"
        asOfLabel={isStale && asOf ? formatEndpoint(asOf, asOf) : undefined}
      />

      {ratioPct != null && ratioLabel && <ProportionTrack pct={ratioPct} label={ratioLabel} />}

      <div className="flex items-center justify-between gap-3 mt-auto">
        {!isStale && asOf && (
          <span className="text-xs text-neutral-text-secondary">
            as of {formatEndpoint(asOf, asOf)}
          </span>
        )}
        {base && (
          <Link
            to={`${base}/schedule`}
            className="ml-auto inline-flex items-center min-h-[44px] text-xs font-medium text-brand-primary
              underline-offset-2 hover:underline rounded-control
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            {offerRerun ? 'Re-run forecast' : 'Forecast'} →
          </Link>
        )}
      </div>
    </section>
  );
}
