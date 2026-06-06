/**
 * DA-10 — Product backlog / grooming view (ADR-0105, #494).
 *
 * The PO's priority-ordered backlog: stories grouped under epics, each carrying a
 * Definition-of-Ready chip, an acceptance-criteria meter, and points; a grooming-health
 * strip; and a "next-sprint ready line" drawn where the cumulative ready points reach
 * the active sprint's capacity. Auto-rank (DA-11 control) is surfaced here as a toggle
 * state — when on, manual drag is locked (the server enforces this; the handle is
 * hidden). Quick inline story-add (#921) commits a title-only story on Enter.
 *
 * Rendered against the real navy/sage tokens, not the prototype green.
 */

import { useMemo } from 'react';
import { Button } from '@/components/Button';
import { useProjectId } from '@/hooks/useProjectId';
import type { Task } from '@/types';
import { AcMeter, DorChip } from './components/atoms';
import { useAutoRank, useProductBacklog } from './hooks/useProductBacklog';
import type { EpicGroup, GroomingHealth } from './types';

function GroomStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'onTrack' | 'atRisk';
}) {
  const valueColor =
    tone === 'onTrack'
      ? 'text-semantic-on-track'
      : tone === 'atRisk'
        ? 'text-semantic-at-risk'
        : 'text-neutral-text-primary';
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-text-secondary">
        {label}
      </span>
      <span className={`font-mono text-lg font-bold tabular-nums ${valueColor}`}>{value}</span>
      <span className="text-[10.5px] text-neutral-text-secondary">{sub}</span>
    </div>
  );
}

function HealthStrip({ health }: { health: GroomingHealth }) {
  const dorTone = health.dorPct >= 80 ? 'onTrack' : health.dorPct >= 50 ? 'atRisk' : 'atRisk';
  return (
    <div className="flex flex-wrap items-center gap-x-10 gap-y-3 border-b border-neutral-border bg-neutral-surface-raised px-6 py-3.5">
      <GroomStat
        label="Definition of Ready"
        value={`${health.dorPct}%`}
        sub={`${health.readyCount} of ${health.storyCount} stories ready`}
        tone={dorTone}
      />
      <GroomStat
        label="Ready for next sprint"
        value={`${health.readyPoints}`}
        sub={
          health.capacityPoints != null
            ? `${health.readyPoints} of ${health.capacityPoints} pts capacity`
            : 'no active sprint capacity'
        }
      />
      <GroomStat
        label="Unestimated"
        value={`${health.unestimated}`}
        sub={health.unestimated === 0 ? 'all stories pointed' : 'need an estimate'}
        tone={health.unestimated === 0 ? 'onTrack' : undefined}
      />
      <GroomStat
        label="Acceptance criteria"
        value={`${health.acMet}/${health.acTotal}`}
        sub="met across backlog"
      />
    </div>
  );
}

const COLS = 'grid grid-cols-[28px_56px_1fr_120px_84px_44px] items-center gap-2.5';

function StoryRow({ story }: { story: Task }) {
  const overSized = (story.storyPoints ?? 0) >= 8;
  return (
    <div className={`${COLS} border-b border-neutral-border px-2 py-2.5 text-[13px]`}>
      <span className="text-neutral-text-secondary" aria-hidden>
        ⠿
      </span>
      <span className="font-mono text-[11px] text-neutral-text-secondary">{story.shortId}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium text-neutral-text-primary">{story.name}</span>
      </span>
      <AcMeter met={story.acMet ?? 0} total={story.acTotal ?? 0} />
      <DorChip dor={story.dor ?? 'idea'} />
      <span
        className={`text-center font-mono text-[13px] font-semibold ${
          overSized ? 'text-semantic-at-risk' : 'text-neutral-text-primary'
        }`}
      >
        {story.storyPoints ?? '—'}
      </span>
    </div>
  );
}

function EpicSection({ group }: { group: EpicGroup }) {
  const { epic, stories, rollup } = group;
  const pct = rollup.pointsTotal > 0 ? Math.round((rollup.pointsDone / rollup.pointsTotal) * 100) : 0;
  return (
    <div className="mb-3.5">
      <div className="flex items-center gap-2.5 rounded-md bg-neutral-surface-sunken px-2 py-2">
        <span className="h-5 w-2 rounded-[2px] bg-brand-primary" aria-hidden />
        <span className="text-[10px] font-bold uppercase tracking-wide text-neutral-text-secondary">
          Epic
        </span>
        <span className="font-mono text-[11px] text-neutral-text-secondary">{epic.shortId}</span>
        <span className="text-sm font-semibold text-neutral-text-primary">{epic.name}</span>
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-neutral-text-secondary">
          {rollup.pointsDone}/{rollup.pointsTotal} pts · {pct}%
        </span>
      </div>
      {stories.map((s) => (
        <StoryRow key={s.id} story={s} />
      ))}
    </div>
  );
}

export function ProductBacklogPage() {
  const projectId = useProjectId();
  const { data, isLoading, isError } = useProductBacklog(projectId);
  const autoRank = useAutoRank(projectId);

  // Flatten stories in render order to locate the next-sprint ready line — the row
  // after which cumulative ready points first reach the active sprint's capacity.
  const readyLineAfterId = useMemo(() => {
    if (!data?.health.capacityPoints) return null;
    const cap = data.health.capacityPoints;
    const flat: Task[] = [...data.epics.flatMap((g) => g.stories), ...data.ungrouped];
    let cum = 0;
    for (const s of flat) {
      if (s.dor === 'ready') {
        cum += s.storyPoints ?? 0;
        if (cum >= cap) return s.id;
      }
    }
    return null;
  }, [data]);

  if (isLoading) {
    return <div className="p-6 text-sm text-neutral-text-secondary">Loading backlog…</div>;
  }
  if (isError || !data) {
    return (
      <div className="p-6 text-sm text-semantic-critical">Could not load the product backlog.</div>
    );
  }

  const { health, scoring } = data;
  const allEmpty = data.epics.length === 0 && data.ungrouped.length === 0;

  return (
    <div className="flex h-full flex-col overflow-auto bg-neutral-surface">
      <header className="flex items-center gap-3 border-b border-neutral-border px-6 py-4">
        <div className="flex flex-col">
          <h1 className="text-xl font-semibold text-neutral-text-primary">Product backlog</h1>
          <span className="text-xs text-neutral-text-secondary">Backlog / Grooming</span>
        </div>
        <div className="flex-1" />
        {scoring.model !== 'none' && (
          <span className="rounded-full bg-brand-primary/10 px-3 py-1 text-xs font-semibold text-brand-primary">
            {scoring.model.toUpperCase()}
          </span>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => autoRank.mutate()}
          disabled={autoRank.isPending || scoring.model === 'none'}
          title={
            scoring.model === 'none'
              ? 'Set a prioritization model to auto-rank'
              : 'Sort the backlog by score (manual drag still wins afterward)'
          }
        >
          {autoRank.isPending ? 'Ranking…' : 'Auto-rank'}
        </Button>
        <Button variant="primary" size="sm">
          Start grooming
        </Button>
      </header>

      <HealthStrip health={health} />

      <div
        className={`${COLS} border-b border-neutral-border px-6 py-2 text-[10px] font-semibold uppercase tracking-wide text-neutral-text-secondary`}
      >
        <span>#</span>
        <span>ID</span>
        <span>Story</span>
        <span>Acceptance</span>
        <span>Readiness</span>
        <span className="text-center">Pts</span>
      </div>

      {allEmpty ? (
        <div className="p-8 text-center text-sm text-neutral-text-secondary">
          No stories yet. Pull items from the program backlog or add a story to start grooming.
        </div>
      ) : (
        <div className="px-4 pt-2">
          {data.epics.map((group) => (
            <div key={group.epic.id}>
              <EpicSection group={group} />
              {group.stories.some((s) => s.id === readyLineAfterId) && <ReadyLine />}
            </div>
          ))}
          {data.ungrouped.length > 0 && (
            <div className="mb-3.5">
              {data.ungrouped.map((s) => (
                <div key={s.id}>
                  <StoryRow story={s} />
                  {s.id === readyLineAfterId && <ReadyLine />}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReadyLine() {
  return (
    <div className="flex items-center gap-2.5 px-2 py-1.5">
      <span className="h-0 flex-1 border-t-2 border-dashed border-brand-primary" />
      <span className="text-[10.5px] font-bold uppercase tracking-wide text-brand-primary">
        Next-sprint ready line
      </span>
      <span className="h-0 flex-1 border-t-2 border-dashed border-brand-primary" />
    </div>
  );
}
