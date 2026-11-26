import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { FOCUS_RING } from '@/components/page2/classes';
import { SnapshotPanel } from '@/components/page2/SnapshotPanel';
import { HealthBandChip, StatusChip, BAND_TONE } from '@/components/page2/StatusChip';
import { useMinWidth } from '@/features/shell2/useMinWidth';
import { snapshotRows } from '@/features/project/statusUpdates/statusUpdateModel';
import { fmtUtcMedium } from '@/lib/formatUtcDate';
import { RAG_BAND, asHealthBand, ragLabel } from '@/lib/ragBand';
import {
  classifyStatusUpdateShareError,
  fetchPublicStatusUpdate,
  narrativeParagraphs,
  type PublicStatusUpdate,
  type StatusUpdateShareErrorKind,
} from './statusUpdateShareApi';
import { useNoReferrer } from './useNoReferrer';

/** Wide enough for the desktop frame: the narrative shows in full. */
const WIDE_PX = 768;

function StatePage({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-p1-surface-0 px-4">
      <div className="w-full max-w-sm rounded-lg border border-p1-hairline bg-p1-surface-1 p-6 text-center">
        <h1 className="mb-1 text-sm font-semibold text-p1-text-1">{title}</h1>
        <p className="text-sm text-p1-text-2">{body}</p>
      </div>
      {/* The brand mark on every state, so a recipient can tell the page is real. */}
      <p className="mt-4 text-xs font-medium text-p1-text-3">TruePPM</p>
    </div>
  );
}

const ERROR_COPY: Record<StatusUpdateShareErrorKind, { title: string; body: string }> = {
  unavailable: {
    title: 'This link isn’t available',
    body: 'It may have expired or been turned off. Ask the person who shared it for a new link.',
  },
  rate_limited: {
    title: 'Too many requests',
    body: 'This link was opened too often in a short time. Wait a minute and reload.',
  },
  error: {
    title: 'This update didn’t load',
    body: 'Something went wrong on our side. Reload the page to try again.',
  },
};

function Narrative({ text }: { text: string }) {
  const wide = useMinWidth(WIDE_PX);
  const [expanded, setExpanded] = useState(false);
  const paragraphs = narrativeParagraphs(text);
  if (paragraphs.length === 0) {
    return <p className="text-sm text-p1-text-2">No narrative was written for this update.</p>;
  }
  // Phone frame: the first paragraph, then a control that reveals the rest.
  const truncated = !wide && !expanded && paragraphs.length > 1;
  const shown = truncated ? paragraphs.slice(0, 1) : paragraphs;
  return (
    <div className="flex flex-col gap-2" data-testid="share-narrative">
      {shown.map((p, i) => (
        <p key={i} className="whitespace-pre-line text-sm leading-6 text-p1-text-1">
          {p}
        </p>
      ))}
      {truncated && (
        <button
          type="button"
          className={`inline-flex min-h-[44px] items-center self-start text-sm font-medium text-p1-brand underline ${FOCUS_RING}`}
          onClick={() => setExpanded(true)}
          data-testid="share-narrative-expand"
        >
          Read all {paragraphs.length} paragraphs
        </button>
      )}
    </div>
  );
}

function variance(days: number | null): string {
  if (days == null) return '—';
  if (days === 0) return 'On commitment';
  return days > 0 ? `+${days}d` : `${days}d`;
}

function ShareBody({ data }: { data: PublicStatusUpdate }) {
  const band = asHealthBand(data.computed_health);
  const posted = fmtUtcMedium(data.posted_at);
  return (
    <div className="min-h-screen bg-p1-surface-0" data-testid="status-update-share">
      {/* A bare header, not app chrome: no navigation and no link into the workspace. */}
      <header className="border-b border-p1-hairline bg-p1-surface-1">
        <div className="mx-auto flex min-h-[44px] max-w-3xl items-center justify-between gap-2 px-4">
          <span className="text-sm font-semibold text-p1-text-1">TruePPM</span>
          <span
            className="rounded-full border border-p1-hairline px-2 py-0.5 text-xs text-p1-text-2"
            data-testid="share-read-only-chip"
          >
            Read-only
          </span>
        </div>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
        <div className="flex flex-col gap-1">
          <p className="text-xs text-p1-text-2">Status update {data.seq}</p>
          <h1 className="text-xl font-semibold text-p1-text-1">{data.project.name}</h1>
          <p className="text-sm text-p1-text-2">
            Posted {posted}
            {data.author ? ` by ${data.author}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="flex items-center gap-2 text-sm text-p1-text-2">
            The call
            <StatusChip
              tone={BAND_TONE[RAG_BAND[data.rag]]}
              label={ragLabel(data.rag)}
              data-testid="share-call"
            />
          </span>
          {band && (
            <span className="flex items-center gap-2 text-sm text-p1-text-2">
              Computed health
              <HealthBandChip band={band} data-testid="share-health" />
            </span>
          )}
        </div>
        <section aria-labelledby="share-narrative-h" className="flex flex-col gap-2">
          <h2 id="share-narrative-h" className="text-sm font-semibold text-p1-text-1">
            Narrative
          </h2>
          <Narrative text={data.narrative} />
        </section>
        <SnapshotPanel
          mode="frozen"
          heading={`Snapshot of update ${data.seq}`}
          asOf={fmtUtcMedium(data.as_of)}
          rows={snapshotRows(data)}
        >
          <p className="text-xs text-p1-text-2">
            Commitment:{' '}
            {data.forecast.baseline_finish
              ? fmtUtcMedium(data.forecast.baseline_finish)
              : 'not computable (no baseline is set)'}
          </p>
          {data.milestones && data.milestones.length > 0 && (
            <div>
              <h4 className="text-xs text-p1-text-2">Milestones</h4>
              <ul className="flex flex-col gap-1" data-testid="share-milestones">
                {data.milestones.map((m, i) => (
                  <li
                    key={i}
                    className="flex flex-wrap items-baseline gap-x-2 text-sm text-p1-text-1"
                  >
                    <span aria-hidden="true">◆</span>
                    <span>{m.name}</span>
                    <span className="font-mono text-xs">
                      {m.cpm_finish ? fmtUtcMedium(m.cpm_finish) : 'no finish'}
                    </span>
                    <span className="text-xs text-p1-text-2">
                      vs. commitment {variance(m.variance_days)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.risks && (
            <div>
              <h4 className="text-xs text-p1-text-2">Top risks</h4>
              {data.risks.length === 0 ? (
                <p className="text-sm text-p1-text-2">No open risks.</p>
              ) : (
                <ul className="flex flex-col gap-1" data-testid="share-risks">
                  {data.risks.map((r, i) => (
                    <li key={i} className="text-sm text-p1-text-1">
                      {r.title}{' '}
                      <span className="text-xs text-p1-text-2">
                        probability {r.probability} × impact {r.impact} = {r.severity}
                        {r.owner ? ` · ${r.owner}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {data.decisions && (
            <div>
              <h4 className="text-xs text-p1-text-2">Open decisions</h4>
              {data.decisions.length === 0 ? (
                <p className="text-sm text-p1-text-2">No open decisions.</p>
              ) : (
                <ul className="flex flex-col gap-1" data-testid="share-decisions">
                  {data.decisions.map((d, i) => (
                    <li key={i} className="text-sm text-p1-text-1">
                      {d.title}{' '}
                      <span className="text-xs text-p1-text-2">
                        {d.due_date ? `due ${fmtUtcMedium(d.due_date)}` : 'no due date'}
                        {d.owner ? ` · ${d.owner}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </SnapshotPanel>
        <p className="text-xs text-p1-text-2" data-testid="share-frozen-note">
          These facts were frozen when update {data.seq} was posted and do not change when the plan
          moves.
        </p>
      </main>
    </div>
  );
}

/**
 * Public, read-only render of one posted status update (#4805). Standalone, outside
 * the app shell: no sign-in, no workspace chrome, no link into the workspace. Its only
 * request is the anonymous share read; every value it prints comes from that frozen
 * projection, never the live plan. Theme tokens (`p1-*`) follow the viewer's light or
 * dark preference, and the phone layout truncates the narrative.
 */
export function PublicStatusUpdateSharePage() {
  const { token = '' } = useParams<{ token: string }>();
  const [data, setData] = useState<PublicStatusUpdate | null>(null);
  const [error, setError] = useState<StatusUpdateShareErrorKind | null>(null);
  useNoReferrer();

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetchPublicStatusUpdate(token)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(classifyStatusUpdateShareError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (data) document.title = `${data.project.name} · Status update ${data.seq}`;
  }, [data]);

  if (error) return <StatePage {...ERROR_COPY[error]} />;
  if (!data) {
    return (
      <div
        className="min-h-screen bg-p1-surface-0 p-6"
        role="status"
        aria-label="Loading status update"
        data-testid="status-update-share-loading"
      >
        <div className="mx-auto h-48 max-w-3xl animate-pulse rounded-lg border border-p1-hairline bg-p1-surface-1" />
      </div>
    );
  }
  return <ShareBody data={data} />;
}

