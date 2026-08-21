/**
 * The import wizard's **Dates** block — the date-order control and its evidence
 * (#2926, design handoff `handoff-2909-2926` cases 06–07).
 *
 * Encoding, delimiter and decimal separator are all resolved from the file's own
 * evidence and reported as facts. Date order was the one locale decision that was
 * *guessed and then mentioned* — a passive read-only notice under the preview
 * whose only remedy was "re-export your file and start over". The fix is
 * structural, not cosmetic: a control sits **above the preview it governs**,
 * because the order is meaningless before Start/Finish are mapped and unfixable
 * after the preview has been read as truth.
 *
 * Three things here are load-bearing and should not be softened:
 *
 * 1. **Every confirming sentence names a row, a value and a reason.** "Dates were
 *    interpreted as M/D/Y" is unfalsifiable by the reader; "row 14 is 13/04/2026,
 *    so it can only be day-first" is checkable against the file in five seconds.
 *    The server sends that evidence rather than a rendered sentence.
 * 2. **The ambiguous file is never blocked.** Blocking a commit on an ambiguity
 *    the server cannot resolve strands anyone whose export genuinely is
 *    ambiguous. Instead the wizard's primary button names the convention it is
 *    about to accept, so "continue" cannot be pressed without reading the
 *    decision (see {@link ambiguousContinueLabel}).
 * 3. **Never colour alone** (WCAG 1.4.1). The ambiguous state signals through a
 *    warning glyph, the text badge "Needs a decision", an Auto chip reading
 *    `Auto · M/D/Y?` with a question mark, and the primary button's own copy.
 *    Remove all colour and every one of those survives.
 *
 * The word "ambiguous" deliberately never reaches the user: "Auto cannot tell"
 * is what actually happened, and the operator's job is to say which convention
 * their own export uses.
 */
import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import {
  CSV_DATE_ORDERS,
  CSV_DATE_ORDER_NAMES,
  type CsvDateOrder,
  type CsvDateReading,
  type CsvPreview,
} from '@/hooks/useCsvImport';
import { WarningIcon } from '@/components/Icons';

/** Mapped date column names as prose — "Start and Finish", never a count. */
export function joinColumns(names: string[]): string {
  if (names.length === 0) return 'the mapped date columns';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Short label for a resolved order, for chips and inline mentions. */
function shortName(order: string): string {
  return CSV_DATE_ORDERS.find((o) => o.value === order)?.label ?? order.toUpperCase();
}

/**
 * The wizard's primary-button copy while an ambiguous file is unconfirmed.
 *
 * Exported because the button lives in the wizard footer, not in this block, and
 * the two must not drift: the whole no-hard-block argument rests on the button
 * naming the convention it accepts.
 */
export function ambiguousContinueLabel(resolved: string): string {
  return `Confirm ${shortName(resolved)} and continue`;
}

const REASON_CLAUSE: Record<string, string> = {
  no_thirteenth_month: 'there is no 13th month, so the file can only be day-first',
  second_part_exceeds_twelve:
    'the second part exceeds 12, so the file can only be month-first',
};

function Segments({
  value,
  autoLabel,
  disabled,
  onChange,
}: {
  value: CsvDateOrder;
  autoLabel: string;
  disabled: boolean;
  onChange: (v: CsvDateOrder) => void;
}) {
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: ReactKeyboardEvent, idx: number) {
    const n = CSV_DATE_ORDERS.length;
    let next: number;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (idx + 1) % n;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (idx - 1 + n) % n;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = n - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const opt = CSV_DATE_ORDERS[next];
    // Selection commits on move (rule 179) — the control stays live during a
    // refetch, so a third change simply supersedes the second.
    onChange(opt.value);
    btnRefs.current[next]?.focus();
  }

  const selectedIdx = CSV_DATE_ORDERS.findIndex((o) => o.value === value);
  return (
    <div
      role="radiogroup"
      aria-label="Date order"
      // A 2x2 grid below 640px so every cell keeps a 44px touch target rather
      // than four segments crushed onto one line.
      className="grid grid-cols-2 gap-0.5 rounded-control border border-neutral-border
                 bg-neutral-surface-sunken p-0.5 sm:inline-flex sm:gap-0"
    >
      {CSV_DATE_ORDERS.map((opt, i) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-disabled={disabled || undefined}
            disabled={disabled}
            tabIndex={i === selectedIdx ? 0 : -1}
            onClick={() => !disabled && onChange(opt.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={[
              'min-h-[44px] rounded-[5px] px-3 py-2 text-xs font-medium transition-colors sm:min-h-0',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface',
              selected
                ? 'bg-brand-primary text-neutral-text-inverse'
                : disabled
                  ? 'cursor-not-allowed text-neutral-text-disabled'
                  : 'bg-neutral-surface text-neutral-text-secondary hover:bg-neutral-surface-raised',
            ].join(' ')}
          >
            {opt.value === 'auto' ? autoLabel : opt.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Both readings, as a real `<table>` with the convention as each row header.
 *
 * A table rather than two cards because it *is* a comparison: a screen reader in
 * table mode can put the two durations beside each other, and a stacked pair of
 * cards a scroll apart turns the comparison into a list.
 */
function TwoReadings({
  readings,
  chosen,
  onChoose,
}: {
  readings: CsvDateReading[];
  chosen: string;
  onChoose: (v: CsvDateOrder) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[20rem] text-xs">
        <caption className="sr-only">
          The same file read under each convention, with the duration each produces
        </caption>
        <thead>
          <tr className="text-left text-neutral-text-secondary">
            <th scope="col" className="px-2 py-1 font-medium">
              Reading
            </th>
            <th scope="col" className="px-2 py-1 font-medium">
              First dated row
            </th>
            <th scope="col" className="px-2 py-1 font-medium">
              Duration
            </th>
            <th scope="col" className="px-2 py-1 font-medium">
              Rows that parse
            </th>
            <th scope="col" className="sr-only">
              Choose
            </th>
          </tr>
        </thead>
        <tbody>
          {readings.map((r) => {
            const total = r.values_matched + r.values_failed;
            return (
              <tr key={r.order} className="border-t border-neutral-border align-top">
                <th scope="row" className="whitespace-nowrap px-2 py-2 text-left font-medium">
                  {shortName(r.order)}
                  {r.order === chosen && (
                    <span className="ml-1 font-normal text-neutral-text-secondary">
                      — Auto&rsquo;s guess
                    </span>
                  )}
                </th>
                <td className="whitespace-nowrap px-2 py-2">
                  {r.start && r.finish ? `${r.start} → ${r.finish}` : '—'}
                </td>
                <td className="whitespace-nowrap px-2 py-2 font-medium">
                  {r.duration_days === null ? '—' : `${r.duration_days} days`}
                </td>
                <td className="whitespace-nowrap px-2 py-2">
                  {r.values_failed === 0
                    ? `all ${total}`
                    : `${r.values_matched} of ${total} — ${r.rows_unparseable} row${
                        r.rows_unparseable === 1 ? '' : 's'
                      } unreadable`}
                </td>
                <td className="px-2 py-2">
                  <button
                    type="button"
                    onClick={() => onChoose(r.order)}
                    className="min-h-[44px] rounded-control border border-neutral-border px-2 py-1 text-xs
                               font-medium text-brand-primary hover:bg-neutral-surface-raised sm:min-h-0
                               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                  >
                    Use {shortName(r.order)}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export interface DateOrderBlockProps {
  preview: CsvPreview;
  value: CsvDateOrder;
  onChange: (order: CsvDateOrder) => void;
  /** A preview refetch is in flight — the statement says so; the control stays live. */
  busy: boolean;
  /** Headers of the columns currently mapped to a date field. */
  dateColumnNames: string[];
}

export function DateOrderBlock({
  preview,
  value,
  onChange,
  busy,
  dateColumnNames,
}: DateOrderBlockProps) {
  const resolved = preview.date_order_resolved ?? 'mdy';
  const autoResolved = preview.date_order_auto ?? 'mdy';
  const ambiguous = Boolean(preview.date_order_ambiguous);
  const evidence = preview.date_order_evidence ?? null;
  const matched = preview.values_matched ?? 0;
  const failed = preview.values_failed ?? 0;
  const columns = joinColumns(dateColumnNames);
  const inert = preview.date_order_has_columns === false;
  const overridden = value !== 'auto';

  // The Auto chip always reports what it resolved to, so the control never reads
  // as "no opinion" — and carries a question mark when that resolution is a
  // coin flip, which is one of the four non-colour ambiguity signals.
  const autoLabel = inert
    ? 'Auto'
    : ambiguous
      ? `Auto · ${shortName(autoResolved)}?`
      : `Auto · ${shortName(autoResolved)}`;

  let statement: ReactNode;
  if (inert) {
    statement = (
      <>
        Nothing is mapped to <b>Start date</b> or <b>Finish date</b>, so no dates will be imported
        and this setting has nothing to act on. Map a date column and the control becomes live.
      </>
    );
  } else if (busy) {
    statement = (
      <b>
        Re-reading {preview.row_count} rows as {shortName(resolved)}…
      </b>
    );
  } else if (ambiguous) {
    statement = (
      <>
        <b>Auto cannot tell.</b> Every value in <b>{columns}</b> is valid read either way, so
        nothing in this file identifies its own convention. Auto will read it as{' '}
        <b>{CSV_DATE_ORDER_NAMES[autoResolved]}</b>. If this export came from a European tool,
        choose <b>D/M/Y</b>.
      </>
    );
  } else if (overridden) {
    statement = (
      <>
        <b>Set by you: {CSV_DATE_ORDER_NAMES[resolved] ?? shortName(resolved)}.</b> Auto would have
        read this file as {shortName(autoResolved)}.
        {evidence && (
          <>
            {' '}
            Row {evidence.row} &ldquo;{evidence.value}&rdquo; now reads {shortName(resolved)}.
          </>
        )}
      </>
    );
  } else if (evidence && evidence.reason === 'non_slash_layout') {
    statement = (
      <>
        <b>Auto read this file as ISO 8601 (YYYY-MM-DD).</b> All {matched} values in{' '}
        <b>{columns}</b> match that pattern.
      </>
    );
  } else if (evidence) {
    statement = (
      <>
        <b>Auto read this file as {CSV_DATE_ORDER_NAMES[resolved] ?? shortName(resolved)}.</b> Row{' '}
        {evidence.row} is &ldquo;{evidence.value}&rdquo; — {REASON_CLAUSE[evidence.reason] ?? 'it can only be read one way'}.
        All {matched} values in <b>{columns}</b> fit that reading.
      </>
    );
  } else {
    statement = (
      <>
        <b>Reading dates in {columns} as {shortName(resolved)}.</b>
      </>
    );
  }

  const firstFailure = (preview.date_preview ?? []).find((r) => r.unreadable);

  return (
    <section
      aria-label="Date order"
      className={[
        'rounded-card border p-3',
        ambiguous && !inert
          ? 'border-semantic-at-risk bg-semantic-at-risk-bg'
          : 'border-neutral-border',
      ].join(' ')}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-neutral-text-primary">Date order</h3>
        {inert ? (
          <span className="rounded-control border border-neutral-border px-2 py-0.5 text-xs text-neutral-text-secondary">
            Not needed
          </span>
        ) : ambiguous ? (
          // Glyph + words, so the state survives with all colour removed.
          <span className="inline-flex items-center gap-1 text-xs font-medium text-semantic-at-risk">
            <WarningIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            Needs a decision
          </span>
        ) : (
          <span className="text-xs text-neutral-text-secondary">
            {overridden ? 'Set by you' : 'Evidence found'}
          </span>
        )}
        {!inert && dateColumnNames.length > 0 && (
          <span className="ml-auto text-xs text-neutral-text-secondary">{columns}</span>
        )}
      </div>

      <div className={inert ? 'opacity-60' : undefined}>
        <Segments value={value} autoLabel={autoLabel} disabled={inert} onChange={onChange} />
      </div>

      {/* Polite, so a change is announced without stealing focus from the control
          that caused it. Mounted unconditionally: a live region added at the same
          moment its text appears is not reliably announced. */}
      <p
        aria-live="polite"
        className="mt-2 text-sm leading-relaxed text-neutral-text-secondary"
      >
        {statement}
      </p>

      {!inert && !busy && failed > 0 && (
        <p className="mt-2 text-sm text-semantic-at-risk">
          <b>
            {failed} of {matched + failed} date values cannot be read as {shortName(resolved)}.
          </b>{' '}
          They will import without dates and are listed in the preview.
          {firstFailure && ` Row ${firstFailure.row} is “${firstFailure.raw_start || firstFailure.raw_finish}”.`}
        </p>
      )}

      {ambiguous && !busy && (preview.date_order_readings?.length ?? 0) > 0 && (
        <div className="mt-3">
          <TwoReadings
            readings={preview.date_order_readings ?? []}
            chosen={autoResolved}
            onChoose={onChange}
          />
          <p className="mt-2 text-xs text-neutral-text-secondary">
            The same file, two readings. Continuing without choosing counts as accepting{' '}
            <b>{shortName(autoResolved)}</b> — the button below says so.
          </p>
        </div>
      )}
    </section>
  );
}
