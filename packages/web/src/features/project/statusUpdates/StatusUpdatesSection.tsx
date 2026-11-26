import { mintIdempotencyKey } from '../../../lib/mintIdempotencyKey';
import { useId, useRef, useState } from 'react';
import { Banner } from '@/components/page2/Banner';
import { FOCUS_RING } from '@/components/page2/classes';
import { SectionHeading } from '@/components/page2/PageTitle';
import { RagRadio } from '@/components/page2/RagRadio';
import { SnapshotPanel, type SnapshotRow } from '@/components/page2/SnapshotPanel';
import { HealthBandChip, StatusChip, BAND_TONE } from '@/components/page2/StatusChip';
import { QueryErrorState } from '@/components/QueryErrorState';
import type { StatusUpdate } from '@/api/types';
import { useMinWidth } from '@/features/shell2/useMinWidth';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useUserDateFormat } from '@/hooks/useUserDateFormat';
import { fmtUtcMedium } from '@/lib/formatUtcDate';
import { RAG_BAND, asHealthBand, ragLabel, type Rag } from '@/lib/ragBand';
import {
  NARRATIVE_MAX,
  clearDraft,
  currentComputedHealth,
  firstLine,
  loadDraft,
  milestoneNow,
  saveDraft,
  snapshotRows,
} from './statusUpdateModel';
import { isAxiosError } from 'axios';
import {
  downloadStatusUpdatePdf,
  useCreateStatusUpdateShareLink,
  usePostStatusUpdate,
  useStatusUpdates,
  type StatusUpdatePdfSize,
  type StatusUpdateShareLink,
} from './useStatusUpdates';

const BUTTON = `inline-flex min-h-[44px] items-center justify-center rounded-lg px-4 text-sm font-medium ${FOCUS_RING}`;
const PRIMARY = `${BUTTON} bg-p1-brand text-p1-on-brand disabled:cursor-not-allowed disabled:opacity-50`;
const SECONDARY = `${BUTTON} border border-p1-hairline bg-p1-surface-1 text-p1-text-1`;

/** The PM's call as a chip: the band's glyph and word (one vocabulary, `ragBand`). */
export function CallChip({ rag, testId }: { rag: Rag; testId?: string }) {
  return <StatusChip tone={BAND_TONE[RAG_BAND[rag]]} label={ragLabel(rag)} data-testid={testId} />;
}

interface ComposerProps {
  projectId: string;
  userId: string;
  /** The band the plan reads now (the API's), shown beside the call; null when unknown. */
  computedBand: string | null;
  /** The number the next update will get, for the error line. */
  nextSeq: number;
  /** Figures the server will freeze, from their owners, already formatted. */
  liveRows: SnapshotRow[];
  onClose: () => void;
}

/**
 * The composer (#4804): the PM's call, a plain-text narrative, and the live
 * snapshot beside it. No generated draft: the words are the PM's. The draft is
 * saved on this device on every change (one per project per author), so a reload,
 * a failed post or going offline never loses it.
 */
export function StatusUpdateComposer({
  projectId,
  userId,
  computedBand,
  nextSeq,
  liveRows,
  onClose,
}: ComposerProps) {
  const initial = loadDraft(projectId, userId);
  const [rag, setRag] = useState<Rag | null>(initial?.rag ?? null);
  const [narrative, setNarrative] = useState(initial?.narrative ?? '');
  const [failed, setFailed] = useState(false);
  const online = useOnlineStatus();
  const wide = useMinWidth(640);
  const post = usePostStatusUpdate(projectId);
  // One key per draft: stable across retries of the same call, new once the content changes.
  const idempotencyKey = useRef<string | null>(null);
  const narrativeId = useId();
  const counterId = useId();
  const band = asHealthBand(computedBand);

  const update = (next: { rag?: Rag | null; narrative?: string }) => {
    const r = next.rag !== undefined ? next.rag : rag;
    const n = next.narrative ?? narrative;
    if (next.rag !== undefined) setRag(next.rag);
    if (next.narrative !== undefined) setNarrative(next.narrative);
    saveDraft(projectId, userId, { rag: r, narrative: n });
    idempotencyKey.current = null;
  };

  const submit = () => {
    if (!rag || !online) return;
    setFailed(false);
    post.mutate(
      { rag, narrative, idempotencyKey: (idempotencyKey.current ??= mintIdempotencyKey()) },
      {
        onSuccess: () => {
          idempotencyKey.current = null;
          clearDraft(projectId, userId);
          onClose();
        },
        onError: () => {
          saveDraft(projectId, userId, { rag, narrative });
          setFailed(true);
        },
      },
    );
  };

  const snapshot = (
    <SnapshotPanel mode="live" rows={liveRows} heading="Snapshot">
      <p className="text-xs text-p1-text-2">
        The server takes the full snapshot (milestones, risks, counts since the last update) when
        you post.
      </p>
    </SnapshotPanel>
  );

  return (
    <section
      aria-labelledby="su-composer-h"
      className="flex flex-col gap-4 rounded-lg border border-p1-hairline bg-p1-surface-1 p-4"
      data-testid="status-composer"
    >
      <h3 id="su-composer-h" className="text-sm font-semibold text-p1-text-1">
        Post a status update
      </h3>
      {failed && (
        <Banner tone="critical" data-testid="status-composer-error">
          Update {nextSeq} didn’t post; your call and narrative are kept as a draft.
        </Banner>
      )}
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <RagRadio
            legend="Your call"
            name={`su-rag-${projectId}`}
            value={rag}
            onChange={(r) => update({ rag: r })}
            aside={
              band ? (
                <span
                  className="inline-flex items-center gap-1 text-xs text-p1-text-2"
                  data-testid="status-composer-computed"
                >
                  Computed: <HealthBandChip band={band} />
                </span>
              ) : undefined
            }
          />
          <div className="flex flex-col gap-1">
            <label htmlFor={narrativeId} className="text-xs text-p1-text-2">
              Narrative <span className="text-p1-text-3">(the first line is the summary)</span>
            </label>
            <textarea
              id={narrativeId}
              aria-describedby={counterId}
              maxLength={NARRATIVE_MAX}
              rows={6}
              value={narrative}
              onChange={(e) => update({ narrative: e.target.value })}
              className={`rounded-lg border border-p1-hairline bg-p1-surface-1 p-3 text-sm text-p1-text-1 ${FOCUS_RING}`}
              data-testid="status-composer-narrative"
            />
            <div className="flex flex-wrap justify-between gap-2 text-xs text-p1-text-2">
              <span data-testid="status-composer-first-line">
                First line: {firstLine(narrative) || '—'}
              </span>
              <span id={counterId} className="font-mono tabular-nums">
                {narrative.length} / {NARRATIVE_MAX}
              </span>
            </div>
          </div>
          {!online && (
            <p className="text-xs text-p1-text-2" data-testid="status-composer-offline">
              Posts when you reconnect; the snapshot freezes then.
            </p>
          )}
          <div className="flex flex-wrap gap-2 max-sm:flex-col-reverse">
            <button
              type="submit"
              className={`${PRIMARY} max-sm:w-full`}
              disabled={!rag || !online || post.isPending}
            >
              {post.isPending ? 'Posting…' : 'Post update'}
            </button>
            <button
              type="button"
              className={SECONDARY}
              onClick={() => {
                saveDraft(projectId, userId, { rag, narrative });
                onClose();
              }}
            >
              Save draft
            </button>
            <button
              type="button"
              className={SECONDARY}
              onClick={() => {
                clearDraft(projectId, userId);
                onClose();
              }}
            >
              Cancel
            </button>
          </div>
        </form>
        {wide ? (
          snapshot
        ) : (
          <details
            className="rounded-lg border border-p1-hairline"
            data-testid="status-composer-snapshot-row"
          >
            <summary
              className={`flex min-h-[44px] cursor-pointer items-center px-3 text-sm ${FOCUS_RING}`}
            >
              Snapshot
            </summary>
            {snapshot}
          </details>
        )}
      </div>
    </section>
  );
}

function FrozenSnapshot({ update }: { update: StatusUpdate }) {
  const { formatInstant } = useUserDateFormat();
  const ms = update.snapshot.milestones ?? [];
  return (
    <SnapshotPanel
      mode="frozen"
      heading={`Snapshot of update ${update.seq}`}
      asOf={formatInstant(update.posted_at)}
      rows={snapshotRows(update.snapshot, update.live_diff)}
    >
      {!update.snapshot_verified && (
        <Banner tone="critical">
          This update no longer matches the record taken when it was posted.
        </Banner>
      )}
      {ms.length > 0 && (
        <div>
          <h4 className="text-xs text-p1-text-2">Milestones</h4>
          <ul className="flex flex-col gap-1">
            {ms.map((m) => {
              const now = milestoneNow(update.live_diff, m.task_id);
              return (
                <li
                  key={m.task_id}
                  className="flex flex-wrap items-baseline gap-x-2 text-sm text-p1-text-1"
                >
                  <span aria-hidden="true">◆</span>
                  <span>{m.name}</span>
                  <span className="font-mono text-xs">
                    {m.cpm_finish ? fmtUtcMedium(m.cpm_finish) : 'no finish'}
                  </span>
                  {now && (
                    <span
                      className="rounded-full border border-p1-hairline px-2 text-xs text-p1-text-2"
                      data-testid="snapshot-now-milestone"
                    >
                      now {now}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </SnapshotPanel>
  );
}

const EXPIRY_DAYS = [7, 30, 90] as const;

/** Mint a read-only link to ONE update and reveal it once (#4805). Admin+ only. */
function ShareLinkPanel({ projectId, update }: { projectId: string; update: StatusUpdate }) {
  const mint = useCreateStatusUpdateShareLink(projectId);
  const formId = useId();
  const [days, setDays] = useState<number>(30);
  const [showRisks, setShowRisks] = useState(false);
  const [showDecisions, setShowDecisions] = useState(false);
  const [link, setLink] = useState<StatusUpdateShareLink | null>(null);
  const [copied, setCopied] = useState(false);
  const { formatInstantDate } = useUserDateFormat();

  if (link) {
    const url = `${window.location.origin}${link.share_path}`;
    return (
      <div className="flex flex-col gap-2" data-testid="status-update-share-reveal">
        <label htmlFor={`${formId}-url`} className="text-xs text-p1-text-2">
          Read-only link to update {update.seq}
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id={`${formId}-url`}
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
            className={`min-h-[44px] min-w-0 flex-1 rounded-lg border border-p1-hairline bg-p1-surface-2 px-3 font-mono text-xs text-p1-text-1 ${FOCUS_RING}`}
          />
          <button
            type="button"
            className={SECONDARY}
            onClick={() => {
              void navigator.clipboard?.writeText(url).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
        <p className="text-xs text-p1-text-2" role="status">
          Copy it now: the link is shown only once.
          {link.expires_at
            ? ` It stops working on ${formatInstantDate(link.expires_at, 'medium')}.`
            : ''}
        </p>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-2"
      data-testid="status-update-share-form"
      onSubmit={(e) => {
        e.preventDefault();
        mint.mutate(
          { updateId: update.id, expiresInDays: days, showRisks, showDecisions },
          { onSuccess: setLink },
        );
      }}
    >
      <p className="text-xs text-p1-text-2">
        Anyone with the link can read this update’s frozen snapshot without signing in. People’s
        names are not shown.
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <label className="flex min-h-[44px] items-center gap-2 text-sm text-p1-text-1">
          Expires after
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className={`min-h-[44px] rounded-lg border border-p1-hairline bg-p1-surface-1 px-2 ${FOCUS_RING}`}
          >
            {EXPIRY_DAYS.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-h-[44px] items-center gap-2 text-sm text-p1-text-1">
          <input
            type="checkbox"
            checked={showRisks}
            onChange={(e) => setShowRisks(e.target.checked)}
          />
          Include top risks
        </label>
        <label className="flex min-h-[44px] items-center gap-2 text-sm text-p1-text-1">
          <input
            type="checkbox"
            checked={showDecisions}
            onChange={(e) => setShowDecisions(e.target.checked)}
          />
          Include open decisions
        </label>
      </div>
      {mint.isError && (
        <p className="text-sm text-p1-text-1" role="alert">
          {isAxiosError(mint.error) && mint.error.response?.status === 403
            ? 'Public sharing is turned off for this project, so a link can’t be created.'
            : 'The link wasn’t created. Try again.'}
        </p>
      )}
      <button type="submit" className={`${PRIMARY} self-start`} disabled={mint.isPending}>
        {mint.isPending ? 'Creating…' : 'Create link'}
      </button>
    </form>
  );
}

/** PDF and Share link actions for one history row (#4805). */
function UpdateActions({
  projectId,
  projectCode,
  update,
  canShare,
}: {
  projectId: string;
  projectCode: string | null;
  update: StatusUpdate;
  canShare: boolean;
}) {
  const [busy, setBusy] = useState<StatusUpdatePdfSize | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  const download = (size: StatusUpdatePdfSize) => {
    setBusy(size);
    setPdfError(null);
    downloadStatusUpdatePdf(projectId, update, size, projectCode)
      .catch((err: unknown) => {
        setPdfError(
          isAxiosError(err) && err.response?.status === 409
            ? 'This update no longer matches its record, so it isn’t printed.'
            : 'The PDF didn’t download. Try again.',
        );
      })
      .finally(() => setBusy(null));
  };

  return (
    <div className="flex flex-col gap-2" data-testid="status-update-actions">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={SECONDARY}
          disabled={busy != null}
          onClick={() => download('letter')}
          data-testid="status-update-pdf-letter"
        >
          {busy === 'letter' ? 'Preparing PDF…' : 'PDF (Letter)'}
        </button>
        <button
          type="button"
          className={SECONDARY}
          disabled={busy != null}
          onClick={() => download('a4')}
          data-testid="status-update-pdf-a4"
        >
          {busy === 'a4' ? 'Preparing PDF…' : 'PDF (A4)'}
        </button>
        {canShare && (
          <button
            type="button"
            className={SECONDARY}
            aria-expanded={sharing}
            onClick={() => setSharing((v) => !v)}
            data-testid="status-update-share"
          >
            Share link
          </button>
        )}
      </div>
      {pdfError && (
        <p className="text-sm text-p1-text-1" role="alert">
          {pdfError}
        </p>
      )}
      {sharing && canShare && <ShareLinkPanel projectId={projectId} update={update} />}
    </div>
  );
}

interface SectionProps {
  projectId: string;
  /** The signed-in user, for the per-author draft; null while loading. */
  userId: string | null;
  /** Project Admin+ may post (the API's gate); everyone else reads. */
  canPost: boolean;
  /** An archived project is history: the API refuses a post, so none is offered. */
  archived?: boolean;
  /** The project's code, for the downloaded PDF's file name. */
  projectCode?: string | null;
  liveRows: SnapshotRow[];
  /**
   * status-summary's band when the counts decided it (never a manual report), so the
   * first update's composer still shows the plan's reading. Null when unknown.
   */
  derivedBand?: string | null;
}

/**
 * Status updates on the Project Overview (#4804): the history, newest first, and
 * the composer for a Project Manager. Selecting a row shows that update's frozen
 * snapshot with "now …" tags from the API's live diff; nothing is recomputed here.
 */
export function StatusUpdatesSection({
  projectId,
  userId,
  canPost,
  archived = false,
  projectCode = null,
  liveRows,
  derivedBand = null,
}: SectionProps) {
  const history = useStatusUpdates(projectId);
  const { formatInstantDate } = useUserDateFormat();
  const [composing, setComposing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const updates = history.data?.results ?? [];
  const latest = updates[0];
  const hasDraft = userId != null && loadDraft(projectId, userId) != null;
  const canCompose = canPost && !archived && userId != null;

  const openComposer = (
    <button type="button" className={SECONDARY} onClick={() => setComposing(true)}>
      {hasDraft ? 'Resume draft' : 'Post update'}
    </button>
  );

  return (
    <section aria-labelledby="su-h" className="flex flex-col gap-3" data-testid="status-updates">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionHeading id="su-h">Status updates</SectionHeading>
        {canCompose && !composing && updates.length > 0 && openComposer}
      </div>
      {canPost && archived && (
        <p className="text-xs text-p1-text-2" data-testid="status-updates-archived">
          This project is archived, so new status updates can’t be posted.
        </p>
      )}
      {composing && canCompose && userId != null && (
        <StatusUpdateComposer
          projectId={projectId}
          userId={userId}
          computedBand={currentComputedHealth(latest) ?? derivedBand}
          nextSeq={(latest?.seq ?? 0) + 1}
          liveRows={liveRows}
          onClose={() => setComposing(false)}
        />
      )}
      {history.isLoading ? (
        <div
          className="h-24 animate-pulse rounded-lg border border-p1-hairline bg-p1-surface-1"
          role="status"
          aria-label="Loading status updates"
          data-testid="status-updates-skeleton"
        />
      ) : history.isError ? (
        <>
          <QueryErrorState
            variant="inline"
            message="Status updates didn’t load"
            onRetry={() => void history.refetch()}
          />
          {/* The draft is local, so it stays reachable when the history read fails. */}
          {canCompose && !composing && openComposer}
        </>
      ) : updates.length === 0 ? (
        <div
          className="flex flex-col items-start gap-2 rounded-lg border border-p1-hairline bg-p1-surface-1 p-4"
          data-testid="status-updates-empty"
        >
          <p className="text-sm text-p1-text-1">No status updates yet</p>
          {canCompose && !composing && openComposer}
        </div>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-p1-hairline rounded-lg border border-p1-hairline bg-p1-surface-1">
            {updates.map((u) => {
              const isSelected = u.id === selectedId;
              return (
                <li key={u.id}>
                  <button
                    type="button"
                    aria-expanded={isSelected}
                    onClick={() => setSelectedId(isSelected ? null : u.id)}
                    className={`flex min-h-[44px] w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-sm ${FOCUS_RING}`}
                    data-testid="status-update-row"
                  >
                    <CallChip rag={u.rag} />
                    <span className="min-w-0 flex-1 truncate text-p1-text-1">
                      {firstLine(u.narrative) || `Update ${u.seq}`}
                    </span>
                    <span className="text-xs text-p1-text-2">
                      {u.author_name ?? 'Former member'}
                    </span>
                    <span className="font-mono text-xs text-p1-text-2">
                      {formatInstantDate(u.posted_at, 'medium')}
                    </span>
                  </button>
                  {isSelected && (
                    <div className="flex flex-col gap-3 px-3 pb-3">
                      <UpdateActions
                        projectId={projectId}
                        projectCode={projectCode}
                        update={u}
                        // Minting is Admin+ and refused on an archived project, like a post.
                        canShare={canPost && !archived}
                      />
                      <FrozenSnapshot update={u} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-p1-text-3">
            Updates can’t be edited after posting. A correction is a new update.
          </p>
        </>
      )}
    </section>
  );
}
