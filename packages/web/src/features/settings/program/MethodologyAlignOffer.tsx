/**
 * MethodologyAlignOffer — the post-save "Align the N" offer on Program → General (#3293).
 *
 * Setting a program's methodology does **not** re-shape the projects already in it:
 * `methodology` is NOT-NULL at every scope, so `resolve_effective_methodology`
 * short-circuits on the project's own value and the program tier never flows down at
 * read time (`apps/projects/methodology.py`). The hint beside the picker now says so.
 * This component is the other half — after a successful save it states the *resolved*
 * consequence ("9 of 12 run as Waterfall; 3 do not") and hands the admin the one
 * surface that can change the three.
 *
 * Two rulings shape it, and both are load-bearing:
 *
 * - **It navigates; it never writes** (D19). "Align the 3", not "Apply to the 3". A
 *   write button here would be a bulk apply with no impact preview (#3296) needing its
 *   own confirmation, its own failure path and a second place for counts to go stale.
 *   The link stages nothing, so Apply is disabled on arrival and the admin's own press
 *   is still what commits.
 * - **It states the reality even when there is nothing to offer** (D20). All-match and
 *   no-projects both render. The all-match sentence is the only one that licenses the
 *   claim "the program is standardized", which is exactly why it is worth a line.
 *
 * The counts are a client-side partition of `useProgramProjects`, which already returns
 * every project with its methodology. No new endpoint and no server change.
 */
import { type ReactNode, useEffect, useMemo } from 'react';
import { Link } from 'react-router';

import { useProgramProjects } from '@/hooks/useProgramProjects';
import { BULK_FIELDS_MAX_ROWS } from '../components/BulkFieldsMatrix';
import { METHODOLOGY_LABEL } from '@/features/programs/MethodologyFilter';
import type { Methodology } from '@/types';

/**
 * Canonical arrival contract for the bulk matrix (D41). The Projects settings section
 * reads both keys once on mount and strips them with `replace: true`, so a refresh or a
 * Back never re-arms a selection the admin did not ask for a second time.
 */
export function alignMatrixHref(programId: string): string {
  return `/programs/${programId}/settings?bulk=methodology&only=deviating#projects`;
}

/**
 * The matrix caps a single Apply, and this button must never out-promise it. Imported
 * rather than restated: three independent `200` literals (here, the matrix, and the
 * Projects section's arrival announcement) is how one of them goes stale silently.
 */
const APPLY_CAP = BULK_FIELDS_MAX_ROWS;

interface Props {
  programId: string;
  /** The methodology the save just committed at program scope. */
  methodology: Methodology;
  /**
   * Id for the panel, so the methodology radiogroup can point `aria-describedby` here.
   *
   * This is the belt-and-braces, NOT the announcement — the distinction matters and an
   * earlier revision of this file got it backwards. The save is committed from the
   * shell's save bar, which unmounts the instant `dirty` flips false, dropping focus to
   * `document.body`; focus is therefore never on a radio when the offer appears, so a
   * description hanging off the radiogroup is only encountered by someone who navigates
   * back to it. The announcement rides `onAnnounce` instead (see below).
   */
  id: string;
  /**
   * Speak this offer's sentence on a region that was ALREADY in the accessibility tree.
   *
   * `role="status"` announces *mutations* of an existing region (web-rule 335), and this
   * panel MOUNTS — with the projects roster usually already in cache from the Projects
   * section of the same consolidated page, the whole sentence lands in the same commit
   * as the container, which AT announces inconsistently or not at all. So the panel is a
   * plain `<div>` and the caller owns a permanently-mounted, permanently-empty live
   * region that this writes into. Same shape `BulkFieldsMatrix` already uses for its own
   * announcements.
   */
  onAnnounce: (sentence: string) => void;
}

export function MethodologyAlignOffer({ programId, methodology, id, onAnnounce }: Props) {
  const { data: projects, isPending, isError, refetch, isFetching } = useProgramProjects(programId);

  const label = METHODOLOGY_LABEL[methodology];

  /**
   * `useUpdateProgram` invalidates `['programs']`, which prefix-matches the roster query
   * — so at the moment this mounts the refetch is IN FLIGHT and every cached row's
   * `inherited_methodology` still names the program's PREVIOUS methodology.
   *
   * The partition itself is safe either way (it compares each project's own stored
   * value, which the program save did not touch), but the matrix this links to computes
   * its "deviates" cohort from `inherited_methodology`. Offering the link over stale
   * rows sends "Align the 3" to a cohort of a different size — often the complement.
   * So the offer waits for the roster to settle rather than racing it: `isFetching`
   * covers the invalidation refetch, the cold load, and a Retry alike.
   */
  const resolving = isPending || isFetching;

  const partition = useMemo(() => {
    if (!projects) return null;
    const differing = projects.filter((p) => p.methodology !== methodology);
    return { total: projects.length, differing, matching: projects.length - differing.length };
  }, [projects, methodology]);

  const body = isError
    ? { kind: 'error' as const }
    : resolving || !partition
      ? { kind: 'resolving' as const }
      : partition.total === 0
        ? { kind: 'empty' as const }
        : partition.differing.length === 0
          ? { kind: 'match' as const, total: partition.total }
          : {
              kind: 'differs' as const,
              total: partition.total,
              matching: partition.matching,
              differing: partition.differing.map((p) => ({ id: p.id, name: p.name })),
            };

  // Announce only the settled outcomes. "Checking…" is chrome for a state that resolves
  // on its own; speaking it would put a placeholder ahead of the answer.
  const sentence = announcementFor(body, label);
  useEffect(() => {
    if (sentence) onAnnounce(sentence);
  }, [sentence, onAnnounce]);

  return (
    <div
      id={id}
      data-testid="methodology-align-offer"
      className="mt-2 rounded-card border border-neutral-border bg-neutral-surface-sunken px-3 py-2 text-[12px] text-neutral-text-secondary"
    >
      {/* D18 — every state opens with "Saved.", rendered before the counts resolve, so a
          committed write never reads as provisional while the partition is still coming. */}
      <span className="font-medium text-neutral-text-primary">Saved.</span>{' '}
      {body.kind === 'error' ? (
        <ErrorBody programId={programId} onRetry={() => void refetch()} retrying={isFetching} />
      ) : body.kind === 'resolving' ? (
        <span>Checking the projects in this program…</span>
      ) : body.kind === 'empty' ? (
        <span>This program has no projects yet.</span>
      ) : body.kind === 'match' ? (
        <AllMatchBody total={body.total} label={label} />
      ) : (
        <DiffersBody
          programId={programId}
          label={label}
          total={body.total}
          matching={body.matching}
          differing={body.differing}
        />
      )}
    </div>
  );
}

type OfferBody =
  | { kind: 'error' }
  | { kind: 'resolving' }
  | { kind: 'empty' }
  | { kind: 'match'; total: number }
  | { kind: 'differs'; total: number; matching: number; differing: { id: string; name: string }[] };

/**
 * The spoken form of each settled state — a full sentence, not the visual fragments.
 * A screen-reader user hears this instead of reading the panel, so it has to carry the
 * same three things the panel does: the save landed, what it did not reach, and what to
 * do about it. `null` means "nothing settled yet, say nothing".
 */
function announcementFor(body: OfferBody, label: string): string | null {
  switch (body.kind) {
    case 'resolving':
      return null;
    case 'error':
      return 'Saved. This save changed the program default only — existing projects keep their own methodology. We could not check which of them differ.';
    case 'empty':
      return 'Saved. This program has no projects yet.';
    case 'match':
      return body.total === 1
        ? `Saved. The 1 project in this program already runs as ${label}.`
        : `Saved. All ${body.total} projects in this program already run as ${label}.`;
    case 'differs': {
      const n = body.differing.length;
      const which = n === 1 ? `${body.differing[0].name} does not` : `${n} do not`;
      const action =
        n === 1
          ? `Use the Align ${body.differing[0].name} link to change it.`
          : `Use the Align the ${n} link to change them.`;
      return `Saved. ${body.matching} of ${body.total} ${body.total === 1 ? 'project' : 'projects'} in this program ${body.total === 1 ? 'runs' : 'run'} as ${label}; ${which}. Existing projects keep their own methodology. ${action}`;
    }
  }
}

/** D20 — the sentence that licenses "this program is standardized". */
function AllMatchBody({ total, label }: { total: number; label: string }) {
  return total === 1 ? (
    <span>
      The <Num>1</Num> project in this program already runs as {label}.
    </span>
  ) : (
    <span>
      All <Num>{total}</Num> projects in this program already run as {label}.
    </span>
  );
}

function DiffersBody({
  programId,
  label,
  total,
  matching,
  differing,
}: {
  programId: string;
  label: string;
  total: number;
  matching: number;
  differing: { id: string; name: string }[];
}) {
  const n = differing.length;
  const single = n === 1 ? differing[0] : undefined;
  const overCap = n > APPLY_CAP;

  // Visible text stays short; the accessible name says what "the 3" are, and contains
  // the visible label verbatim (WCAG 2.5.3 Label in Name).
  const linkText = single
    ? `Align ${single.name}`
    : overCap
      ? `Align the first ${APPLY_CAP}`
      : `Align the ${n}`;
  const linkName = single
    ? `Align ${single.name}, the project that differs`
    : overCap
      ? // D21 — naming the cap is what stops "200 of 240 checked" reading as a silent
        // truncation on arrival. The matrix caps the selection, not the list.
        `Align the first ${APPLY_CAP} of ${n} projects that differ`
      : `Align the ${n} projects that differ`;

  return (
    <>
      <span>
        {/* Literal numerals, never a bar/dot/ring — the count is the claim (1.4.1). */}
        <Num>{matching}</Num> of <Num>{total}</Num>{' '}
        {total === 1 ? 'project' : 'projects'} in this program{' '}
        {total === 1 ? 'runs' : 'run'} as {label};{' '}
        {single ? (
          <>
            {single.name} does not.
          </>
        ) : (
          <>
            <Num>{n}</Num> do not.
          </>
        )}{' '}
        Existing projects keep their own methodology.
      </span>{' '}
      <Link
        to={alignMatrixHref(programId)}
        aria-label={linkName}
        data-testid="methodology-align-link"
        className="font-medium text-brand-primary underline underline-offset-2 hover:text-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-control"
      >
        {linkText}
      </Link>
    </>
  );
}

/**
 * A failed count must not retract the save and must not invent a zero — the write
 * landed and only the partition is unknown. No skeleton persists: the reader is told
 * the check failed and handed both a Retry and the unfiltered matrix.
 */
function ErrorBody({
  programId,
  onRetry,
  retrying,
}: {
  programId: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <>
      <span>
        This save changed the program default only — existing projects keep their own
        methodology. We couldn&apos;t check which of them differ.
      </span>{' '}
      <button
        type="button"
        // `aria-disabled` + an early return, never `disabled`: a focused button that
        // becomes `disabled` is blurred by the browser under the user's own keypress,
        // dropping a keyboard user to `document.body` in the middle of a live region.
        onClick={() => {
          if (!retrying) onRetry();
        }}
        aria-disabled={retrying}
        data-testid="methodology-align-retry"
        className="font-medium text-brand-primary underline underline-offset-2 hover:text-brand-primary-dark aria-disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-control"
      >
        {retrying ? 'Retrying…' : 'Retry'}
      </button>{' '}
      <span aria-hidden="true">·</span>{' '}
      <Link
        to={`/programs/${programId}/settings#projects`}
        className="font-medium text-brand-primary underline underline-offset-2 hover:text-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-control"
      >
        Open the projects matrix
      </Link>
    </>
  );
}

function Num({ children }: { children: ReactNode }) {
  return <span className="tppm-mono text-neutral-text-primary">{children}</span>;
}
