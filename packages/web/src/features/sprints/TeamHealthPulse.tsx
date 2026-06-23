import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  usePulse,
  usePulseTrend,
  useUpsertPulse,
  type PulseTrendPoint,
} from '@/hooks/useRetroBoard';
import { useIterationLabel } from '@/hooks/useIterationLabel';

interface Props {
  sprintId: string;
  /** When false (CANCELLED sprint), the poll renders disabled. */
  canRespond: boolean;
}

const MOOD_EMOJI = ['😞', '😐', '🙂', '😀', '🤩'] as const;

/**
 * In-retro team-health pulse (#923, ADR-0117 §5).
 *
 * The trend read is gated server-side by `can_read_signal(..., "pulse")`: an
 * above-audience reader (PM/PMO band) receives `{gated: true}` and sees ONLY
 * the "kept private" wall — never a teaser, count, or blur. Within the team
 * boundary the poll is one-tap (optimistic PUT) and the trend shows three
 * cross-sprint sparklines.
 */
export function TeamHealthPulse({ sprintId, canRespond }: Props) {
  const trend = usePulseTrend(sprintId);

  if (trend.isLoading) {
    return (
      <div className="h-24 rounded-md border border-neutral-border bg-neutral-surface-raised animate-pulse" />
    );
  }

  // Gated: the requester is above the pulse audience — show the wall only.
  if (trend.data?.gated === true) {
    return <PulseGatedWall />;
  }

  return (
    <section
      aria-labelledby="pulse-heading"
      className="rounded-md border border-neutral-border bg-neutral-surface-raised p-3 flex flex-col gap-3"
    >
      <h3
        id="pulse-heading"
        className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
      >
        Team health
      </h3>
      <PulsePoll sprintId={sprintId} canRespond={canRespond} />
      {trend.data && trend.data.gated === false && (
        <PulseTrend
          points={trend.data.points}
          energyDeclining={trend.data.energy_declining}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// PulseGatedWall — the exact "kept private" copy (no numbers, no CTA)
// ---------------------------------------------------------------------------

function PulseGatedWall() {
  return (
    <section
      aria-label="Team health"
      className="rounded-md border border-neutral-border bg-neutral-surface-raised p-4 flex flex-col items-center gap-2 text-center"
    >
      <p className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
        <span aria-hidden="true">🔒 </span>Team health
      </p>
      <p className="text-sm text-neutral-text-secondary max-w-prose">
        This team keeps its health pulse private. Mood and energy signals are shared with
        the team and their coach only — by the team&apos;s choice.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// PulsePoll — one-tap mood / energy / confidence radiogroups
// ---------------------------------------------------------------------------

function PulsePoll({ sprintId, canRespond }: { sprintId: string; canRespond: boolean }) {
  const pulse = usePulse(sprintId);
  const upsert = useUpsertPulse(sprintId);

  const [mood, setMood] = useState<number | null>(null);
  const [energy, setEnergy] = useState<number | null>(null);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate the selection from the requester's own stored response once.
  useEffect(() => {
    if (hydrated || pulse.data === undefined) return;
    if (pulse.data) {
      setMood(pulse.data.mood);
      setEnergy(pulse.data.energy);
      setConfidence(pulse.data.confidence);
    }
    setHydrated(true);
  }, [pulse.data, hydrated]);

  // Surface "✓ saved" for 1.5s after a successful upsert.
  useEffect(() => {
    if (savedAt === null) return;
    const t = setTimeout(() => setSavedAt(null), 1500);
    return () => clearTimeout(t);
  }, [savedAt]);

  // One tap submits as soon as mood + energy are both chosen (confidence
  // optional). Re-tapping any dimension re-submits the full current answer.
  function submit(next: { mood: number | null; energy: number | null; confidence: number | null }) {
    if (next.mood == null || next.energy == null) return;
    upsert.mutate(
      { mood: next.mood, energy: next.energy, confidence: next.confidence },
      { onSuccess: () => setSavedAt(Date.now()) },
    );
  }

  function pick(dim: 'mood' | 'energy' | 'confidence', value: number) {
    if (!canRespond) return;
    const next = {
      mood: dim === 'mood' ? value : mood,
      energy: dim === 'energy' ? value : energy,
      confidence: dim === 'confidence' ? value : confidence,
    };
    if (dim === 'mood') setMood(value);
    if (dim === 'energy') setEnergy(value);
    if (dim === 'confidence') setConfidence(value);
    submit(next);
  }

  const moodOptions: PulseOption[] = MOOD_EMOJI.map((emoji, i) => ({
    value: i + 1,
    content: (
      <span aria-hidden="true" className="text-xl leading-none">
        {emoji}
      </span>
    ),
  }));
  const scaleOptions: PulseOption[] = [1, 2, 3, 4, 5].map((v) => ({
    value: v,
    content: (
      <span aria-hidden="true" className="text-sm font-semibold tppm-mono leading-none">
        {v}
      </span>
    ),
  }));

  return (
    <div className="flex flex-col gap-3">
      <PulseRadioGroup
        legend="Mood"
        value={mood}
        disabled={!canRespond}
        onPick={(v) => pick('mood', v)}
        options={moodOptions}
      />
      <PulseRadioGroup
        legend="Energy"
        value={energy}
        disabled={!canRespond}
        onPick={(v) => pick('energy', v)}
        options={scaleOptions}
      />
      <PulseRadioGroup
        legend="Confidence"
        optional
        value={confidence}
        disabled={!canRespond}
        onPick={(v) => pick('confidence', v)}
        options={scaleOptions}
      />
      <div className="h-4" aria-live="polite">
        {upsert.isError ? (
          <p role="alert" className="text-xs text-semantic-critical">
            Couldn&apos;t record your pulse. Tap again to retry.
          </p>
        ) : savedAt !== null ? (
          <p className="text-xs text-semantic-on-track">✓ saved</p>
        ) : canRespond && (mood === null || energy === null) ? (
          <p className="text-xs italic text-neutral-text-disabled">
            Pick mood and energy to record your pulse.
          </p>
        ) : null}
      </div>
    </div>
  );
}

interface PulseOption {
  value: number;
  content: ReactNode;
}

/**
 * One pulse dimension as an accessible radiogroup (WCAG 2.1.1 / 4.1.2).
 *
 * Roving tabindex with real focus movement: arrow keys move DOM focus across
 * the options (and only the focused option is tabbable) WITHOUT committing —
 * a keyboard user can scan 1→5 without recording four throwaway answers into
 * the team aggregate. Commit happens only on activation (click, or Enter/Space
 * on the focused option, via the native button), matching the mouse "one tap".
 */
function PulseRadioGroup({
  legend,
  optional,
  value,
  disabled,
  onPick,
  options,
}: {
  legend: string;
  optional?: boolean;
  value: number | null;
  disabled: boolean;
  onPick: (value: number) => void;
  options: PulseOption[];
}) {
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIdx = options.findIndex((o) => o.value === value);
  // The roving focus index. Tracks the selection when one exists; otherwise the
  // first option is the entry point so the group is reachable by Tab.
  const [focusIdx, setFocusIdx] = useState(selectedIdx >= 0 ? selectedIdx : 0);
  useEffect(() => {
    if (selectedIdx >= 0) setFocusIdx(selectedIdx);
  }, [selectedIdx]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    let next = focusIdx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      next = Math.min(options.length - 1, focusIdx + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next = Math.max(0, focusIdx - 1);
    } else {
      return;
    }
    e.preventDefault();
    setFocusIdx(next);
    btnRefs.current[next]?.focus(); // move focus — do NOT commit (see docstring)
  }

  const anySelected = value !== null;

  return (
    <div
      role="radiogroup"
      aria-label={optional ? `${legend} (optional)` : legend}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-1 outline-none"
    >
      <span className="text-xs font-medium text-neutral-text-secondary">
        {legend}
        {optional && (
          <span className="ml-1 text-neutral-text-disabled font-normal">(optional)</span>
        )}
      </span>
      <div className="flex items-center gap-1.5">
        {options.map((o, i) => {
          const selected = value === o.value;
          return (
            <button
              key={o.value}
              ref={(el) => {
                btnRefs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${legend} ${o.value} of ${options.length}`}
              disabled={disabled}
              // Roving tabindex: only the focused option is in the tab order.
              tabIndex={i === focusIdx ? 0 : -1}
              onClick={() => onPick(o.value)}
              className={[
                'inline-flex h-12 w-12 items-center justify-center rounded-full border',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                selected
                  ? 'border-brand-primary bg-brand-primary/10 ring-2 ring-brand-primary'
                  : anySelected
                    ? 'border-neutral-border opacity-50 hover:opacity-100'
                    : 'border-neutral-border hover:border-brand-primary',
              ].join(' ')}
            >
              {o.content}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PulseTrend — three labeled inline sparklines (mood / energy / confidence)
// ---------------------------------------------------------------------------

function PulseTrend({
  points,
  energyDeclining,
}: {
  points: PulseTrendPoint[];
  energyDeclining: boolean;
}) {
  const itl = useIterationLabel();
  if (points.length === 0) {
    return (
      <p className="text-xs italic text-neutral-text-disabled">
        No pulse history yet — answers appear here as your team responds across {itl.lowerPlural}.
      </p>
    );
  }

  const latest = points[points.length - 1];

  return (
    <div className="flex flex-col gap-2">
      {energyDeclining && (
        <p
          role="status"
          className="inline-flex items-center gap-1 self-start text-xs text-semantic-warning bg-semantic-warning-bg rounded px-2 py-0.5"
        >
          <span aria-hidden="true">⚠</span> Energy down 2 {itl.lowerPlural} running.
        </p>
      )}
      <Sparkline label="Mood" points={points} value={(p) => p.avg_mood} />
      <Sparkline label="Energy" points={points} value={(p) => p.avg_energy} />
      <Sparkline label="Confidence" points={points} value={(p) => p.avg_confidence} />
      <p className="text-[11px] tppm-mono text-neutral-text-disabled">
        {latest.response_count} responded this {itl.lower}
      </p>
    </div>
  );
}

/**
 * A single labeled inline sparkline. x = sprint, oldest → newest;
 * brand-primary stroke. Each sprint's `response_count` is exposed on hover and
 * focus via the data-point title + the group aria-label (keyboard-reachable).
 */
function Sparkline({
  label,
  points,
  value,
}: {
  label: string;
  points: PulseTrendPoint[];
  value: (p: PulseTrendPoint) => number | null;
}) {
  const W = 120;
  const H = 24;
  const PAD = 2;
  const vals = points.map(value);
  const present = vals.filter((v): v is number => v != null);

  if (present.length === 0) {
    return (
      <div className="flex items-center gap-2">
        <span className="w-20 shrink-0 text-xs text-neutral-text-secondary">{label}</span>
        <span className="text-[11px] italic text-neutral-text-disabled">no data</span>
      </div>
    );
  }

  // Pulse dimensions are bounded 1–5, so use a fixed scale for comparability
  // across the three sparklines (a flatter mood line shouldn't look identical
  // to a flatter energy line at a different amplitude).
  const min = 1;
  const max = 5;
  const span = Math.max(1, points.length - 1);

  function x(i: number): number {
    return PAD + (i / span) * (W - 2 * PAD);
  }
  function y(v: number): number {
    return H - PAD - ((v - min) / (max - min)) * (H - 2 * PAD);
  }

  const segments = points
    .map((p, i) => ({ i, v: value(p) }))
    .filter((s): s is { i: number; v: number } => s.v != null);

  const path = segments
    .map((s, idx) => `${idx === 0 ? 'M' : 'L'} ${x(s.i).toFixed(1)} ${y(s.v).toFixed(1)}`)
    .join(' ');

  const descr = points
    .map((p) => `${p.sprint_name}: ${value(p)?.toFixed(1) ?? 'n/a'} (${p.response_count} responses)`)
    .join('; ');

  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-xs text-neutral-text-secondary">{label}</span>
      <svg
        role="img"
        aria-label={`${label} trend — ${descr}`}
        viewBox={`0 0 ${W} ${H}`}
        className="h-6 w-32 text-brand-primary"
        tabIndex={0}
      >
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {segments.map((s) => (
          <circle key={s.i} cx={x(s.i)} cy={y(s.v)} r={1.8} fill="currentColor">
            <title>
              {points[s.i].sprint_name}: {s.v.toFixed(1)} ({points[s.i].response_count} responses)
            </title>
          </circle>
        ))}
      </svg>
    </div>
  );
}
