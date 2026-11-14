import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import axios from 'axios';
import { Button } from '@/components/Button';
import { useDrivingChain } from '@/hooks/useDrivingChain';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useSchedulerStore } from '@/stores/schedulerStore';
import {
  BAND_TEXT,
  bandWord,
  buildCopyText,
  buildWhyCriticalView,
  floatLabel,
  notComputableText,
  type BandKind,
  type ChainCard,
  type SentenceSegment,
} from './whyCriticalModel';
import { WhyCriticalNetworkDialog } from './WhyCriticalNetworkDialog';

/** Global (not per-task) disclosure preference — a per-viewer convenience only. */
const DETAIL_OPEN_KEY = 'tppm:whyCritical:detailOpen';
/** Default wait when a 429 carries no usable `Retry-After`. */
const DEFAULT_RETRY_AFTER_S = 30;
/** Debounce between a schedule recompute and the refetch it triggers. */
const RECOMPUTE_DEBOUNCE_MS = 3000;

function readDetailOpen(): boolean {
  try {
    return window.localStorage.getItem(DETAIL_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDetailOpen(open: boolean): void {
  try {
    window.localStorage.setItem(DETAIL_OPEN_KEY, open ? '1' : '0');
  } catch {
    // Storage blocked (private window, previews): the default stays collapsed.
  }
}

function retryAfterSeconds(error: unknown): number | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 429) return null;
  const raw: unknown = (error.response.headers as Record<string, unknown>)['retry-after'];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : DEFAULT_RETRY_AFTER_S;
}

const CONNECTOR: Record<BandKind, string> = {
  critical: 'border-semantic-critical',
  near_critical: 'border-semantic-at-risk',
  ample: 'border-neutral-text-primary',
  unknown: 'border-neutral-text-primary',
};

const LINK_CLASS =
  'font-semibold text-brand-primary underline underline-offset-2 rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2';

export interface WhyCriticalSectionProps {
  projectId: string;
  taskId: string;
  /** The drawer task's own sprint, which picks the sprint-only wording. */
  taskHasSprint: boolean;
  /** Bumped by the header badge or a deep link: scroll to and focus the heading. */
  focusNonce: number;
  /** Desktop width (≥ 768 px): only then does the network view entry render. */
  wide: boolean;
  /** Opens another task in this drawer; without it task names render as text. */
  onOpenTask?: (taskId: string) => void;
  /** Reports the payload's band and float for the header badge (`null` = unknown yet). */
  onBand?: (band: BandKind | null, float: number | null) => void;
}

/**
 * "Why critical" — the first Details section of the Schedule task drawer (#4892).
 *
 * Renders the server's driving-chain payload and nothing else: a plain-language
 * sentence first, the chain behind a "Show technical detail" disclosure. A
 * refresh keeps the current content on screen dimmed (never a skeleton after
 * the first load) and a 429 waits for the user behind a visible countdown.
 */
export function WhyCriticalSection({
  projectId,
  taskId,
  taskHasSprint,
  focusNonce,
  wide,
  onOpenTask,
  onBand,
}: WhyCriticalSectionProps) {
  const query = useDrivingChain(projectId, taskId, true);
  const { data, error, isFetching, refetch } = query;
  const online = useOnlineStatus();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [detailOpen, setDetailOpen] = useState(readDetailOpen);
  const [refreshKind, setRefreshKind] = useState<'auto' | 'manual'>('manual');
  const [countdown, setCountdown] = useState(0);
  const [readyAnnounced, setReadyAnnounced] = useState(false);
  const [showSlowText, setShowSlowText] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [networkOpen, setNetworkOpen] = useState(false);
  const networkButtonRef = useRef<HTMLButtonElement>(null);

  const view = useMemo(() => (data ? buildWhyCriticalView(data, new Date()) : null), [data]);
  const copyText = useMemo(() => (data && view ? buildCopyText(data, view) : ''), [data, view]);

  // Header badge mirrors the payload's band once it arrives.
  useEffect(() => {
    if (!onBand) return;
    if (!view) onBand(data && !data.computable ? 'unknown' : null, null);
    else onBand(view.band, view.self.total_float.value);
  }, [view, data, onBand]);

  // Deep link / badge: scroll the heading to the top of the body and focus it.
  useEffect(() => {
    if (focusNonce === 0) return;
    const el = headingRef.current;
    if (!el) return;
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // After the drawer's own open transition (it reveals the shell ~50 ms in),
    // otherwise focusing a still-invisible heading is a no-op.
    const id = window.setTimeout(() => {
      el.scrollIntoView?.({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
      el.focus({ preventScroll: true });
    }, 80);
    return () => window.clearTimeout(id);
  }, [focusNonce]);

  // Skeleton status text only after 400 ms, so a fast response never flashes it.
  useEffect(() => {
    if (data || error) return;
    const t = window.setTimeout(() => setShowSlowText(true), 400);
    return () => window.clearTimeout(t);
  }, [data, error]);

  // 429: count down from Retry-After; never retry automatically.
  const throttleSeconds = retryAfterSeconds(error);
  useEffect(() => {
    if (throttleSeconds === null) return;
    setCountdown(throttleSeconds);
    setReadyAnnounced(false);
    const t = window.setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          window.clearInterval(t);
          setReadyAnnounced(true);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, [throttleSeconds, error]);

  // A schedule recompute marks the payload stale and refetches after a debounce.
  // TanStack dedupes concurrent fetches on one key, so at most one is in flight.
  // Staleness keys on the scheduler store's `recalculatedAt` because the payload
  // carries no `schedule_version` to compare against. During a 429 countdown the
  // auto refetch is skipped: the user's Try again fetches the latest schedule.
  const recalculatedAt = useSchedulerStore((s) => s.recalculatedAt);
  const lastRecalc = useRef(recalculatedAt);
  useEffect(() => {
    if (lastRecalc.current === recalculatedAt) return;
    lastRecalc.current = recalculatedAt;
    if (!data) return;
    const t = window.setTimeout(() => {
      if (countdown > 0) return;
      setRefreshKind('auto');
      void refetch();
    }, RECOMPUTE_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // `countdown` is read at fire time, not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recalculatedAt]);

  const manualRefresh = () => {
    setRefreshKind('manual');
    void refetch();
  };

  const toggleDetail = () => {
    setDetailOpen((open) => {
      writeDetailOpen(!open);
      return !open;
    });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      setCopyState('failed');
    }
  };

  const heading = (
    <h3
      id="why-critical"
      ref={headingRef}
      tabIndex={-1}
      className="text-sm font-semibold text-neutral-text-primary rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2"
    >
      Why critical
    </h3>
  );

  const throttled = throttleSeconds !== null;
  const retryButton = (
    <Button
      variant="secondary"
      size="sm"
      disabled={(throttled && countdown > 0) || isFetching}
      onClick={manualRefresh}
    >
      {throttled && countdown > 0 ? `Try again in ${countdown} s` : 'Try again'}
    </Button>
  );
  const throttleAnnouncement = (
    <span className="sr-only" role="status">
      {throttled && readyAnnounced ? 'Ready to try again.' : ''}
    </span>
  );

  const errorBody = (keep: boolean) => {
    const message = throttled
      ? 'This takes a lot of computing, and too many requests came in at once.'
      : !online
        ? "You're offline. This needs a connection."
        : keep
          ? `Couldn't update. Showing the schedule computed ${view?.provenanceShort.replace('Schedule computed ', '') ?? ''}.`
          : "Couldn't load why this task is critical.";
    return (
      <div className="flex flex-wrap items-center gap-2" role={throttled ? 'status' : 'alert'}>
        <p className="text-sm text-neutral-text-secondary">{message}</p>
        {retryButton}
        {throttled && (
          <span className="text-xs text-neutral-text-secondary">No automatic retry.</span>
        )}
        {throttleAnnouncement}
      </div>
    );
  };

  let body: ReactNode;
  if (!data && error) {
    body = errorBody(false);
  } else if (!data) {
    body = (
      <div aria-busy="true" className="space-y-2 min-h-[4.5rem]">
        <div className="h-4 w-full rounded bg-neutral-surface-sunken animate-pulse motion-reduce:animate-none" />
        <div className="h-4 w-3/4 rounded bg-neutral-surface-sunken animate-pulse motion-reduce:animate-none" />
        <p role="status" className="text-xs text-neutral-text-secondary">
          {showSlowText ? 'Working out what drives this task…' : ''}
        </p>
      </div>
    );
  } else if (!data.computable || !view) {
    body = (
      <p className="text-sm text-neutral-text-secondary">
        {notComputableText(data.reason, taskHasSprint)}
      </p>
    );
  } else if (view.band === 'ample') {
    body = (
      <div className="space-y-1">
        <p className="text-sm text-neutral-text-secondary">
          After the latest schedule update, this task is no longer critical or near-critical.
        </p>
        <p className="text-xs text-neutral-text-secondary">{view.provenanceShort}</p>
      </div>
    );
  } else {
    const refreshing = isFetching;
    body = (
      <div className="space-y-2">
        {refreshing && (
          <p role="status" className="text-xs text-neutral-text-secondary">
            {refreshKind === 'auto' ? 'Schedule changed · updating…' : 'Updating…'}
          </p>
        )}
        {error && errorBody(true)}
        <div
          className={refreshing || error ? 'opacity-[0.55]' : undefined}
          data-testid="why-critical-content"
        >
          <Sentence segments={view.sentence} onOpenTask={onOpenTask} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            aria-expanded={detailOpen}
            aria-controls="why-critical-detail"
            onClick={toggleDetail}
            className="min-h-11 text-sm font-medium text-brand-primary rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2"
          >
            {detailOpen ? 'Hide technical detail' : 'Show technical detail'}
            {!detailOpen && view.partial ? ' · partial' : ''}
          </button>
          {/* The version line stays at full strength while content dims (R8). */}
          <span className="text-xs text-neutral-text-secondary">
            {refreshing
              ? `Showing ${view.provenanceShort.replace('Schedule', 'schedule')}`
              : view.provenanceShort}
          </span>
        </div>
        {detailOpen && (
          <div
            id="why-critical-detail"
            className={`space-y-3 ${refreshing || error ? 'opacity-[0.55]' : ''}`}
          >
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => void copy()}>
                {copyState === 'copied' ? (
                  <>
                    <span aria-hidden="true">✓ </span>Copied
                  </>
                ) : (
                  'Copy as text'
                )}
              </Button>
              {wide && (
                <Button
                  ref={networkButtonRef}
                  variant="secondary"
                  size="sm"
                  onClick={() => setNetworkOpen(true)}
                >
                  Open network view
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                aria-label="Refresh why critical"
                disabled={isFetching || (throttled && countdown > 0)}
                onClick={manualRefresh}
              >
                Refresh
              </Button>
            </div>
            <p role="status" className="sr-only">
              {copyState === 'copied' ? 'Copied to clipboard as plain text.' : ''}
            </p>
            {copyState === 'failed' && (
              <div className="space-y-1">
                <p className="text-sm text-neutral-text-secondary">
                  {"Couldn't copy. Select the text below and copy it."}
                </p>
                <label className="sr-only" htmlFor="why-critical-copy-fallback">
                  Why critical as text
                </label>
                <textarea
                  id="why-critical-copy-fallback"
                  readOnly
                  value={copyText}
                  rows={8}
                  ref={(el) => el?.select()}
                  className="w-full tppm-mono text-xs rounded-control border border-neutral-border p-2"
                />
              </div>
            )}
            <p className="text-xs text-neutral-text-secondary">
              {view.unitsLine} · {view.thresholdLine}
            </p>
            <ol aria-label="Driving chain, nearest first" className="space-y-1">
              {view.cards.map((card) => (
                <ChainItem
                  key={card.key}
                  card={card}
                  gapAfter={card.kind === 'finish' ? view.downstreamGap : null}
                  onOpenTask={onOpenTask}
                />
              ))}
            </ol>
            {view.truncationLines.length > 0 && (
              <div className="rounded-control border border-dashed border-neutral-border px-3 py-2 text-xs text-neutral-text-secondary">
                {view.truncationLines.map((l) => (
                  <p key={l}>{l}</p>
                ))}
              </div>
            )}
            <p className="text-xs text-neutral-text-secondary">{view.provenanceLong}</p>
          </div>
        )}
        {networkOpen && data && (
          <WhyCriticalNetworkDialog
            chain={data}
            view={view}
            copyText={copyText}
            onClose={() => {
              setNetworkOpen(false);
              networkButtonRef.current?.focus();
            }}
            onOpenTask={
              onOpenTask
                ? (id) => {
                    setNetworkOpen(false);
                    onOpenTask(id);
                  }
                : undefined
            }
          />
        )}
      </div>
    );
  }

  return (
    <section
      aria-labelledby="why-critical"
      className="space-y-2"
      data-testid="why-critical-section"
    >
      {heading}
      {body}
    </section>
  );
}

function Sentence({
  segments,
  onOpenTask,
}: {
  segments: SentenceSegment[];
  onOpenTask?: (taskId: string) => void;
}) {
  return (
    <p className="text-[15px] leading-normal text-neutral-text-primary">
      {segments.map((s, i) =>
        s.taskId && onOpenTask ? (
          <button
            key={i}
            type="button"
            className={LINK_CLASS}
            onClick={() => onOpenTask(s.taskId as string)}
          >
            {s.text}
          </button>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </p>
  );
}

function ChainItem({
  card,
  gapAfter,
  onOpenTask,
}: {
  card: ChainCard;
  gapAfter: string | null;
  onOpenTask?: (taskId: string) => void;
}) {
  const word = bandWord(card.band);
  const cardClass = [
    'rounded-control px-3 py-2 bg-neutral-surface',
    card.kind === 'self' ? 'border-2 border-neutral-text-primary' : 'border border-neutral-border',
    card.kind === 'finish' ? 'border-dashed' : '',
    card.kind === 'sprint' ? 'bg-neutral-surface-sunken' : '',
    card.nonDriving ? 'ml-6' : '',
  ].join(' ');
  return (
    <li>
      {card.outEdges.map((e) => (
        <div
          key={e.label}
          className={`flex items-stretch gap-2 py-1 ${card.nonDriving ? 'ml-6' : ''}`}
        >
          <span
            aria-hidden="true"
            className={`ml-3 border-l-2 ${
              e.driving
                ? `border-solid ${CONNECTOR[e.successorBand]}`
                : 'border-dashed border-neutral-text-secondary'
            }`}
          />
          <span className="text-xs text-neutral-text-secondary">{e.label}</span>
        </div>
      ))}
      <div className={cardClass}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm text-neutral-text-primary">
              {card.taskId && onOpenTask && card.kind !== 'self' ? (
                <button
                  type="button"
                  className={LINK_CLASS}
                  onClick={() => onOpenTask(card.taskId as string)}
                >
                  {card.title}
                </button>
              ) : (
                <span className="font-semibold">{card.title}</span>
              )}
              {card.kind === 'self' && (
                <span className="ml-2 text-xs font-semibold px-1.5 py-0.5 rounded-chip bg-neutral-surface-sunken">
                  This task
                </span>
              )}
              {card.kind === 'finish' && (
                <span className="ml-2 text-xs font-semibold px-1.5 py-0.5 rounded-chip bg-neutral-text-primary text-neutral-surface">
                  Project finish
                </span>
              )}
            </p>
            <p className="text-xs text-neutral-text-secondary">{card.subtitle}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="tppm-mono text-xs text-neutral-text-primary">{floatLabel(card.float)}</p>
            {word ? (
              <p className={`text-xs font-semibold ${BAND_TEXT[card.band]}`}>{word}</p>
            ) : (
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 rounded-full bg-neutral-text-secondary"
              />
            )}
          </div>
        </div>
      </div>
      {gapAfter && <p className="py-1 pl-3 text-xs text-neutral-text-secondary">{gapAfter}</p>}
    </li>
  );
}
