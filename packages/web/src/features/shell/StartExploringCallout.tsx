/**
 * Post-load "Start exploring" guidance callout (issue 1054).
 *
 * After a user loads a bundled sample, the load flow navigates with router state
 * `{ startExploringSample: <sampleKey> }`. This callout — mounted once in the
 * app shell above the routed content — reads that signal and renders a tight,
 * dismissable set of static first-steps keyed to the sample, so an evaluator who
 * lands on Program Overview or a Board has an obvious next move instead of a
 * sparse page. It is non-blocking guidance — a labeled region landmark (a
 * `<section>` with an aria-label), never a modal: it must not trap or steal
 * focus while the user explores.
 *
 * Renders nothing when there is no signal (a direct visit) or the sample key is
 * unknown — graceful by construction. Dismissing clears the router state so the
 * callout does not reappear on back/forward or refresh.
 */
import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { CloseIcon } from '@/components/Icons';

interface SampleGuidance {
  /** The sample's display name, used in the callout heading. */
  title: string;
  /** One-line framing shown under the heading. */
  intro: string;
  /** 2–3 static first-step suggestions. No links: project ids are not known to a
   *  static callout, and "static copy, no dynamic detection" is the design rule. */
  steps: string[];
}

/** Static first-step copy per bundled sample (no API calls, no persona detection). */
const START_EXPLORING_COPY: Record<string, SampleGuidance> = {
  'atlas-platform-launch': {
    title: 'Atlas Platform Launch',
    intro: 'A hybrid launch program of three workstreams. A good first tour:',
    steps: [
      'Open the Platform Core project → Sprints for its velocity history.',
      'Open any project → Schedule for the CPM critical path.',
      'Program Overview KPIs fill in once the first schedule run completes.',
    ],
  },
  'aurora-mobile-app': {
    title: 'Aurora Mobile App',
    intro: 'A pure-agile team — the story lives in the sprint flow:',
    steps: [
      'Open the project → Board to work the active sprint.',
      'Open → Sprints for the burndown and velocity history.',
      'This sample is sprints-only by design — there is no schedule.',
    ],
  },
  'bayside-civic-center': {
    title: 'Bayside Civic Center',
    intro: 'A waterfall build with a full critical path. Start here:',
    steps: [
      'Open the project → Schedule for the CPM critical path (all four dependency types).',
      'Open → Grid to see the three-point estimates behind the P50/P80/P95 forecast.',
      'A baseline is captured — compare planned vs. current on the Schedule.',
    ],
  },
  'helios-crm-replacement': {
    title: 'Helios CRM Replacement',
    intro: 'A small hybrid: a finished waterfall plan feeding an agile build. Try:',
    steps: [
      'Open → Schedule to see the planning phase and the cross-phase handoff.',
      'Open → Sprints for the agile build phase.',
      'Open → Board to work the active sprint.',
    ],
  },
};

interface StartExploringState {
  startExploringSample?: string;
}

export function StartExploringCallout() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();
  const [dismissed, setDismissed] = useState(false);

  const sampleKey = (location.state as StartExploringState | null)?.startExploringSample;
  const guidance = sampleKey ? START_EXPLORING_COPY[sampleKey] : undefined;

  if (dismissed || guidance === undefined) return null;

  // When a contributor lands on a board (a project route), lead with their work —
  // the assigned open-sprint tasks are right there on the board they landed on.
  const onBoard = Boolean(params.projectId);

  function dismiss() {
    setDismissed(true);
    // Drop the router state so back/forward/refresh doesn't re-show the callout.
    void navigate(location.pathname + location.search, { replace: true, state: null });
  }

  return (
    <section
      aria-label="Start exploring this demo"
      className="mx-4 mt-4 rounded-card border border-brand-primary/20 bg-brand-primary/5 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-neutral-text-primary">
            Start exploring — {guidance.title}
          </h2>
          <p className="mt-1 text-sm text-neutral-text-secondary">{guidance.intro}</p>
          <ul className="mt-2 space-y-1">
            {onBoard && (
              <li className="flex gap-2 text-sm text-neutral-text-secondary">
                <span aria-hidden="true" className="text-brand-primary">
                  →
                </span>
                <span>
                  Your assigned tasks are on this board — drag a card to update its status.
                </span>
              </li>
            )}
            {guidance.steps.map((step) => (
              <li key={step} className="flex gap-2 text-sm text-neutral-text-secondary">
                <span aria-hidden="true" className="text-brand-primary">
                  →
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ul>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-control
            text-neutral-text-secondary hover:text-neutral-text-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1"
        >
          <CloseIcon aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
