/**
 * A single read-only external work item on /me/work (#1422, ADR-0097 §4).
 *
 * Renders a connected Jira (or future-source) item in the same row grid as
 * `MyWorkTaskRow`, but deliberately **read-only**: no complete checkbox, no
 * timer, no log-time, no status picker. An external item is a personal cache
 * row, never a Task — so the only affordance is the deep link into the provider
 * plus an explicit "Read-only" chip, so the absence of actions reads as
 * intentional rather than broken (the trust-critical treatment).
 */
import type { ExternalStatusCategory, MyWorkExternalItem, MyWorkExternalSource } from '@/hooks/useMyWork';
import { SourceMark } from '@/features/integrations/SourceMark';

interface Props {
  item: MyWorkExternalItem;
  /** The item's source, for the label + site host line. May be undefined. */
  source?: MyWorkExternalSource;
}

// Status pill fill by coarse category — mirrors the native status-chip tokens
// (frontend/CLAUDE.md rule 8b): a pre-computed -bg with the matching full token
// for text and a 40% border. Static (never a button) — external status is not
// editable from TruePPM.
const CATEGORY_PILL_CLASSES: Record<ExternalStatusCategory, string> = {
  todo: 'bg-neutral-surface-sunken text-neutral-text-secondary border-neutral-border',
  in_progress: 'bg-brand-primary/10 text-brand-primary border-brand-primary/40',
  done: 'bg-semantic-on-track-bg text-semantic-on-track border-semantic-on-track/40',
};

const CATEGORY_LABEL: Record<ExternalStatusCategory, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
};

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Format an ISO date-only string as "Due Jul 12". Parsed from the string parts
 * (not `new Date(iso)`) so a `YYYY-MM-DD` value never shifts a day across the
 * viewer's timezone.
 */
function formatExternalDue(dueDate: string | null): { text: string; sr: string } | null {
  if (!dueDate) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate);
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  const day = Number(match[3]);
  return { text: `Due ${month} ${day}`, sr: `Due ${month} ${day}, ${match[1]}` };
}

export function ExternalWorkItemRow({ item, source }: Props) {
  const sourceLabel = source?.label ?? item.source_type;
  const siteUrl = source?.site_url ?? '';
  const statusLabel = item.external_status || CATEGORY_LABEL[item.status_category];
  const due = formatExternalDue(item.due_date);

  return (
    <li
      className="relative flex flex-col gap-1 px-3 py-3 border-b border-neutral-border/40
        md:flex-row md:items-center md:gap-3 md:py-2 md:min-h-11"
    >
      {/* Leading slot: source mark + provider key (no complete checkbox — the
          item cannot be completed from TruePPM). */}
      <div className="flex items-center gap-2 md:w-32 md:shrink-0">
        <SourceMark sourceType={item.source_type} label={sourceLabel} />
        <span className="tppm-mono text-xs text-neutral-text-secondary">{item.key}</span>
      </div>

      {/* Title (deep link into the provider, new tab) + source · host line. */}
      <div className="flex-1 min-w-0">
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex max-w-full items-center gap-1 text-sm font-medium
            text-neutral-text-primary leading-tight hover:underline
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1 rounded-control"
        >
          <span className="truncate">{item.title || item.key}</span>
          {/* External-link glyph — signals "opens in the provider". */}
          <svg
            width="11"
            height="11"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
            className="shrink-0 text-neutral-text-secondary"
          >
            <path
              d="M4.5 2.5H2.5v7h7v-2M7 2.5h2.5V5M9.5 2.5l-4 4"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
        <p className="mt-0.5 flex items-center gap-1 text-xs text-neutral-text-secondary truncate">
          <span>{sourceLabel}</span>
          {siteUrl && (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{siteUrl}</span>
            </>
          )}
        </p>
      </div>

      {/* Read-only chip — makes the absence of actions intentional, not broken. */}
      <div className="flex shrink-0 items-center">
        <span
          className="inline-flex items-center rounded-chip border border-neutral-border
            bg-neutral-surface-sunken px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide
            text-neutral-text-secondary"
        >
          Read-only
        </span>
      </div>

      {/* Status pill — static, read-only. */}
      <div className="md:w-32 md:shrink-0">
        <span
          className={[
            'inline-flex h-7 min-w-[7rem] items-center justify-center rounded-control',
            'border px-2 py-0.5 text-xs font-medium',
            CATEGORY_PILL_CLASSES[item.status_category],
          ].join(' ')}
          aria-label={`Status: ${statusLabel} (read-only)`}
        >
          {statusLabel}
        </span>
      </div>

      {/* Due date, right-aligned on md+ (no points — external items have none). */}
      <div className="flex items-center justify-end gap-3 md:w-56 md:shrink-0">
        {due && (
          <span className="tppm-mono text-xs text-neutral-text-secondary" aria-label={due.sr}>
            {due.text}
          </span>
        )}
      </div>
    </li>
  );
}
