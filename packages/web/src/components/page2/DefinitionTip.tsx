import { Tooltip } from '@/components/Tooltip';
import { formatRelative } from '@/lib/formatRelative';
import { FOCUS_RING, HIT_44 } from './classes';

export interface DefinitionTipProps {
  /** The visible label: a term, abbreviation or percentile ("P80", "Float"). */
  term: string;
  /**
   * The plain-English definition. Pass the SERVER's sentence where the payload
   * carries one (ADR-1314). Absent → the term renders as plain text, never as an
   * underlined trigger that opens an empty panel.
   */
  definition?: string;
  /** ISO timestamp the value was computed at; renders "as of …" beside the term. */
  asOf?: string;
}

/**
 * A dotted-underline term whose hover, keyboard focus or tap shows its
 * definition (rule 439), with an "as of" time nearby.
 *
 * Built on the shared `Tooltip` (rule 287), which already owns the three input
 * paths, Escape-to-dismiss and portaling — this component adds only the Pass 2
 * look (dotted underline, 44px target, offset focus ring) and the freshness
 * line, so a page cannot ship a definition that works by mouse alone.
 */
export function DefinitionTip({ term, definition, asOf }: DefinitionTipProps) {
  const freshness = asOf ? (
    <span className="text-p1-text-3">· as of {formatRelative(new Date(asOf))}</span>
  ) : null;
  if (!definition) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span>{term}</span>
        {freshness}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Tooltip content={definition}>
        <button
          type="button"
          className={`${HIT_44} cursor-help rounded border-b border-dotted border-p1-hairline-strong ${FOCUS_RING}`}
        >
          {term}
        </button>
      </Tooltip>
      {freshness}
    </span>
  );
}
