/**
 * NotificationPreferencesPage — per-user toggle matrix at
 * /me/settings/notifications/ (ADR-0075 §A.7, #311 frontend phase 4).
 *
 * Per-toggle debounced auto-save (300 ms) — four toggles total in 0.2 so a
 * Save button would be cognitive overhead. The matrix is future-proof for
 * Enterprise channels (Slack DM, Teams DM, SMS) registered against ADR-0049's
 * NOTIFICATION_CHANNELS slot; extra columns appear automatically as the
 * server returns new (event_type, channel) rows.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type NotificationPreferenceRow,
  useApplyNotificationPreset,
  useNotificationPreferences,
  useUpdateNotificationPreference,
} from '@/hooks/useNotificationPreferences';
import { useCurrentUser } from '@/hooks/useCurrentUser';

const EVENT_LABELS: Record<string, { title: string; example: string }> = {
  mention_individual: {
    title: "When you're @-mentioned individually",
    example: '“@sarah can you take this on?”',
  },
  mention_group: {
    title: "When a group you're in is @-mentioned",
    example: '“@scrum-team please review the spec”',
  },
  // Own-task events (#639) — keys match the WebhookEventType values.
  'task.assigned': {
    title: 'When a task is assigned to you',
    example: 'You become the owner of “Foundation pour”',
  },
  'task.due_date_changed': {
    title: 'When the planned date of your task changes',
    example: '“Foundation pour” moves to Aug 14',
  },
  // Blocked signal (#855) — one of the two events the Signal-only preset keeps on.
  'task.blocked': {
    title: 'When a task you own is blocked',
    example: 'A teammate flags “Foundation pour” as blocked',
  },
  comment_on_my_task: {
    title: 'When someone comments on your task',
    example: 'A teammate leaves a note on a task you own',
  },
  // Signal-privacy ceiling-raise ratification (issue 1275). Email defaults OFF —
  // the in-app inbox is the discovery surface.
  'signal.ceiling_proposal_opened': {
    title: 'When your team opens a signal-visibility proposal',
    example: 'A proposal to widen velocity visibility opens — vote before it expires',
  },
  'signal.ceiling_proposal_resolved': {
    title: 'When a signal-visibility proposal is resolved',
    example: 'A visibility proposal is ratified, rejected, or expires',
  },
};

const CHANNEL_LABELS: Record<string, string> = {
  in_app: 'In-app',
  email: 'Email',
};

const DEBOUNCE_MS = 300;
const SAVED_TOAST_MS = 3000;

interface ToggleProps {
  pref: NotificationPreferenceRow;
  onChange: (id: number, enabled: boolean) => void;
}

function PreferenceToggle({ pref, onChange }: ToggleProps) {
  const channelLabel = CHANNEL_LABELS[pref.channel] ?? pref.channel;
  const eventLabel = EVENT_LABELS[pref.event_type]?.title ?? pref.event_type;
  // 44×44 outer hit zone (rule 5); inner visual 44×24 switch unchanged.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={pref.enabled}
      aria-label={`${channelLabel} notifications for ${eventLabel}`}
      onClick={() => onChange(pref.id, !pref.enabled)}
      className="inline-flex items-center justify-center w-11 h-11
        focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none rounded-full"
    >
      <span
        aria-hidden="true"
        className={`relative inline-flex items-center w-11 h-6 rounded-full transition-colors
          ${pref.enabled ? 'bg-semantic-on-track' : 'bg-neutral-border'}`}
      >
        <span
          className={`absolute w-4 h-4 rounded-full bg-white transition-transform
            ${pref.enabled ? 'translate-x-6' : 'translate-x-1'}`}
        />
      </span>
    </button>
  );
}

export function NotificationPreferencesPage() {
  const { preferences, isLoading, error } = useNotificationPreferences();
  const updatePreference = useUpdateNotificationPreference();
  const applyPreset = useApplyNotificationPreset();
  const { user } = useCurrentUser();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const debounceTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  // #855: a contributor (no admin access anywhere) gets the simplified
  // "Signal-only" card with the full matrix collapsed behind a one-tap escape;
  // admins skip the card and see the matrix directly. `showFullMatrix` is the
  // escape latch — once a contributor opens the grid it stays open for the visit.
  // Strict `=== false`: an absent/loading signal must NOT hide the matrix (an
  // admin whose /auth/me hasn't resolved should still see the full grid).
  const isContributor = user?.can_access_admin_settings === false;
  const [showFullMatrix, setShowFullMatrix] = useState(false);
  const matrixVisible = !isContributor || showFullMatrix;

  // Distinct event_type + channel sets, derived from the preferences list
  // so Enterprise additions (slack_dm, teams_dm, sms) appear automatically.
  const { eventTypes, channels, prefByKey } = useMemo(() => {
    const eventSet = new Set<string>();
    const channelSet = new Set<string>();
    const byKey = new Map<string, NotificationPreferenceRow>();
    for (const p of preferences) {
      eventSet.add(p.event_type);
      channelSet.add(p.channel);
      byKey.set(`${p.event_type}:${p.channel}`, p);
    }
    // Deterministic order: OSS event types first (mention_individual then
    // mention_group), then anything else alphabetized.
    const ordered = (set: Set<string>, primary: string[]) => {
      const out = primary.filter((k) => set.has(k));
      const rest = [...set].filter((k) => !primary.includes(k)).sort();
      return [...out, ...rest];
    };
    return {
      eventTypes: ordered(eventSet, [
        'mention_individual',
        'mention_group',
        'task.assigned',
        'task.due_date_changed',
        'task.blocked',
        'comment_on_my_task',
        'signal.ceiling_proposal_opened',
        'signal.ceiling_proposal_resolved',
      ]),
      channels: ordered(channelSet, ['in_app', 'email']),
      prefByKey: byKey,
    };
  }, [preferences]);

  function scheduleUpdate(id: number, enabled: boolean) {
    const existing = debounceTimers.current.get(id);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      updatePreference.mutate(
        { id, enabled },
        {
          onSuccess: () => setSavedAt(Date.now()),
        },
      );
      debounceTimers.current.delete(id);
    }, DEBOUNCE_MS);
    debounceTimers.current.set(id, handle);
  }

  // Auto-dismiss the "Saved" indicator after 3 s.
  useEffect(() => {
    if (savedAt == null) return;
    const handle = setTimeout(() => setSavedAt(null), SAVED_TOAST_MS);
    return () => clearTimeout(handle);
  }, [savedAt]);

  // Clear any pending timers if the component unmounts mid-debounce.
  useEffect(() => {
    const timers = debounceTimers.current;
    return () => {
      timers.forEach((handle) => clearTimeout(handle));
      timers.clear();
    };
  }, []);

  if (isLoading) {
    return (
      <main aria-busy="true" aria-label="Loading notification preferences" className="p-6">
        <div className="h-8 w-64 rounded-card bg-neutral-surface-raised animate-pulse mb-4" />
        <div className="h-40 rounded-card border border-neutral-border bg-neutral-surface-raised animate-pulse" />
      </main>
    );
  }

  if (error) {
    return (
      <main className="p-6" role="alert">
        <p className="text-sm text-semantic-critical">
          Couldn&apos;t load preferences.{' '}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="text-brand-primary underline-offset-2 hover:underline"
          >
            Reload
          </button>
        </p>
      </main>
    );
  }

  return (
    <main
      aria-label="Notification preferences"
      className="flex flex-col gap-4 p-6 max-w-3xl mx-auto"
    >
      <header>
        <h1 className="text-lg font-semibold text-neutral-text-primary">
          Notification preferences
        </h1>
        <p className="text-sm text-neutral-text-secondary">
          Choose how you&apos;re notified about your work.
        </p>
      </header>

      {/* Signal-only card (#855) — contributors only. The full matrix stays
          collapsed behind the escape until they ask for it. */}
      {isContributor && (
        <section
          aria-label="Signal-only notifications"
          className="rounded-card border border-brand-primary/40 bg-brand-primary/5 p-4 flex flex-col gap-3"
        >
          <div>
            <h2 className="text-sm font-semibold text-neutral-text-primary">Signal-only</h2>
            <p className="text-sm text-neutral-text-secondary mt-0.5">
              You&apos;ll only hear about blocked work and deadline changes. Everything else
              stays quiet.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() =>
                applyPreset.mutate('signal_only', { onSuccess: () => setSavedAt(Date.now()) })
              }
              disabled={applyPreset.isPending}
              className="h-9 px-3 rounded-control text-sm font-medium bg-brand-primary text-white
                hover:bg-brand-primary-dark disabled:opacity-60 disabled:cursor-progress
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                focus-visible:ring-offset-1"
            >
              {applyPreset.isPending ? 'Applying…' : 'Use signal-only'}
            </button>
            <button
              type="button"
              onClick={() => setShowFullMatrix((v) => !v)}
              aria-expanded={showFullMatrix}
              className="h-9 px-2 rounded-control text-sm font-medium text-brand-primary
                hover:underline focus-visible:outline-none focus-visible:ring-2
                focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              {showFullMatrix ? 'Hide notification types' : 'Show all notification types'}
            </button>
          </div>
        </section>
      )}

      {/* Desktop matrix (≥ md): one row per event_type, one column per channel. */}
      {matrixVisible && (
      <>
      <div className="hidden md:block border border-neutral-border rounded-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-border">
              <th
                scope="col"
                className="text-left text-xs font-medium uppercase tracking-wide text-neutral-text-secondary px-4 py-2"
              >
                Event
              </th>
              {channels.map((ch) => (
                <th
                  key={ch}
                  scope="col"
                  className="text-center text-xs font-medium uppercase tracking-wide text-neutral-text-secondary px-4 py-2 w-32"
                >
                  {CHANNEL_LABELS[ch] ?? ch}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {eventTypes.map((evt) => {
              const meta = EVENT_LABELS[evt];
              return (
                <tr key={evt} className="border-b border-neutral-border last:border-b-0">
                  <th scope="row" className="text-left px-4 py-3 align-top">
                    <div className="text-sm text-neutral-text-primary font-medium">
                      {meta?.title ?? evt}
                    </div>
                    {meta?.example && (
                      <div className="text-xs text-neutral-text-secondary mt-0.5">
                        {meta.example}
                      </div>
                    )}
                  </th>
                  {channels.map((ch) => {
                    const pref = prefByKey.get(`${evt}:${ch}`);
                    if (!pref) {
                      return (
                        <td
                          key={ch}
                          className="text-center px-4 py-3 text-xs text-neutral-text-disabled"
                        >
                          —
                        </td>
                      );
                    }
                    return (
                      <td key={ch} className="text-center px-4 py-3">
                        <PreferenceToggle pref={pref} onChange={scheduleUpdate} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile stack (< md): per-event section with channel sub-rows. */}
      <div className="md:hidden flex flex-col gap-4">
        {eventTypes.map((evt) => {
          const meta = EVENT_LABELS[evt];
          return (
            <section
              key={evt}
              aria-labelledby={`pref-event-${evt}`}
              className="border border-neutral-border rounded-card p-3"
            >
              <h2
                id={`pref-event-${evt}`}
                className="text-sm font-medium text-neutral-text-primary"
              >
                {meta?.title ?? evt}
              </h2>
              {meta?.example && (
                <p className="text-xs text-neutral-text-secondary mt-0.5">{meta.example}</p>
              )}
              <div className="flex flex-col gap-2 mt-3">
                {channels.map((ch) => {
                  const pref = prefByKey.get(`${evt}:${ch}`);
                  if (!pref) return null;
                  return (
                    <div key={ch} className="flex items-center justify-between">
                      <span className="text-sm text-neutral-text-primary">
                        {CHANNEL_LABELS[ch] ?? ch}
                      </span>
                      <PreferenceToggle pref={pref} onChange={scheduleUpdate} />
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      </>
      )}

      <p aria-live="polite" className="text-xs text-neutral-text-secondary">
        {applyPreset.isError
          ? 'Couldn’t apply the preset. Try again.'
          : savedAt != null
            ? 'Saved.'
            : updatePreference.isError
              ? 'Couldn’t save preference. Try again.'
              : 'Changes save automatically.'}
      </p>
    </main>
  );
}
