import { useProjectId } from '@/hooks/useProjectId';
import {
  PROJECT_NOTIFICATION_CHANNELS,
  PROJECT_NOTIFICATION_EVENTS,
  ProjectNotificationChannel,
  ProjectNotificationEventType,
  useProjectNotificationPreferences,
} from '@/hooks/useProjectNotificationPreferences';
import { SettingsPageTitle } from '../SettingsShell';

const QUIET_FROM_OPTIONS = ['18:00', '19:00', '20:00', '21:00', '22:00'];
const QUIET_UNTIL_OPTIONS = ['06:00', '07:00', '08:00', '09:00'];

/** Project > Notifications settings page. Wired to the per-project
 * notification preferences API (#522). */
export function ProjectNotificationsPage() {
  const projectId = useProjectId();
  const { preferences, isLoading, error, update } = useProjectNotificationPreferences(projectId);

  function setCell(event: ProjectNotificationEventType, channel: ProjectNotificationChannel, next: boolean) {
    update.mutate({ matrix: { [event]: { [channel]: next } } });
  }

  function toggleQuiet() {
    if (!preferences) return;
    update.mutate({ quietHoursEnabled: !preferences.quietHoursEnabled });
  }

  function togglePaused() {
    if (!preferences) return;
    update.mutate({ paused: !preferences.paused });
  }

  function setQuietFrom(value: string) {
    update.mutate({ quietHoursFrom: value });
  }

  function setQuietUntil(value: string) {
    update.mutate({ quietHoursUntil: value });
  }

  // Strip seconds — the API returns HH:MM:SS, the <select> binds HH:MM.
  const quietFrom = (preferences?.quietHoursFrom ?? '20:00:00').slice(0, 5);
  const quietUntil = (preferences?.quietHoursUntil ?? '07:00:00').slice(0, 5);

  if (isLoading) {
    return (
      <div>
        <SettingsPageTitle
          title="Notifications"
          subtitle="Per-project routing rules. Members can override these in their personal preferences."
        />
        <div className="px-6 pb-8 text-[13px] text-neutral-text-secondary">Loading…</div>
      </div>
    );
  }

  if (error || !preferences) {
    return (
      <div>
        <SettingsPageTitle
          title="Notifications"
          subtitle="Per-project routing rules. Members can override these in their personal preferences."
        />
        <div className="px-6 pb-8 text-[13px] text-status-danger" role="alert">
          Failed to load preferences. Try refreshing the page.
        </div>
      </div>
    );
  }

  return (
    <div>
      <SettingsPageTitle
        title="Notifications"
        subtitle="Per-project routing rules. Members can override these in their personal preferences."
      />

      <div className="px-6 pb-8 max-w-[920px] space-y-4">
        {/* Pause-all kill-switch (#589). Sits above the matrix so a member who
            isn't ready to dial in their routing has a one-click opt-out. The
            matrix below remains fully editable while paused — toggling cells
            updates stored preferences for when pause is released. */}
        <div className="bg-neutral-surface-raised border border-neutral-border rounded-lg p-4 flex items-start gap-4">
          <Toggle
            on={preferences.paused}
            onToggle={togglePaused}
            ariaLabel="Pause all project notifications"
          />
          <div className="flex-1">
            <h2 className="text-[13px] font-semibold text-neutral-text-primary">
              Pause all notifications
            </h2>
            <p className="text-[12px] text-neutral-text-secondary leading-snug mt-0.5">
              {preferences.paused
                ? 'Paused — no notifications will fire for you on this project. Your matrix below is preserved and resumes when you unpause.'
                : 'One-click opt-out from every notification on this project. Useful while you dial in the matrix below.'}
            </p>
          </div>
        </div>

        {/* Event × Channel matrix */}
        <div
          aria-disabled={preferences.paused}
          className={[
            'bg-neutral-surface-raised border border-neutral-border rounded-lg overflow-hidden transition-opacity',
            preferences.paused ? 'opacity-50' : '',
          ].join(' ')}
        >
          <div
            className="grid px-4 py-2.5 bg-neutral-surface-sunken border-b border-neutral-border/55 text-[10px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary"
            style={{ gridTemplateColumns: `2fr repeat(${PROJECT_NOTIFICATION_CHANNELS.length}, 110px)` }}
          >
            <span>Event</span>
            {PROJECT_NOTIFICATION_CHANNELS.map((c) => (
              <span key={c.channel} className="text-center">
                {c.label}
              </span>
            ))}
          </div>

          {PROJECT_NOTIFICATION_EVENTS.map((evt, ri) => (
            <div
              key={evt.type}
              className={[
                'grid items-center px-4 py-2.5 text-[13px]',
                ri < PROJECT_NOTIFICATION_EVENTS.length - 1 ? 'border-b border-neutral-border/55' : '',
              ].join(' ')}
              style={{ gridTemplateColumns: `2fr repeat(${PROJECT_NOTIFICATION_CHANNELS.length}, 110px)` }}
            >
              <span className="text-neutral-text-primary">{evt.label}</span>
              {PROJECT_NOTIFICATION_CHANNELS.map(({ channel }) => {
                const on = preferences.matrix[evt.type]?.[channel] ?? false;
                return (
                  <span key={channel} className="flex justify-center">
                    <Toggle
                      on={on}
                      onToggle={() => setCell(evt.type, channel, !on)}
                      ariaLabel={`${evt.label} via ${channel}`}
                    />
                  </span>
                );
              })}
            </div>
          ))}
        </div>

        {/* Slack routing + Quiet hours */}
        <div className="grid grid-cols-2 gap-3.5">
          <div className="bg-neutral-surface-raised border border-neutral-border rounded-lg p-4">
            <h2 className="text-[13px] font-semibold text-neutral-text-primary mb-3">Slack channel routing</h2>
            <p className="text-[12px] text-neutral-text-secondary leading-snug mb-3">
              Configure Slack channels for your workspace in{' '}
              <span className="font-semibold text-neutral-text-primary">Project Settings → Integrations</span>.
              Toggles above control whether each event is delivered via Slack at all.
            </p>
            <div className="space-y-2">
              {[
                { lvl: 'Critical-path slips, risk escalations', ch: 'Configure in Integrations' },
                { lvl: 'Daily digest, milestone events', ch: 'Configure in Integrations' },
                { lvl: 'Comment mentions', ch: 'DM the recipient' },
              ].map((row) => (
                <div
                  key={row.lvl}
                  className="grid gap-2.5 py-1.5 text-[12px]"
                  style={{ gridTemplateColumns: '1.4fr 1fr' }}
                >
                  <span className="text-neutral-text-secondary leading-snug">{row.lvl}</span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-brand-primary-light text-brand-primary h-fit">
                    {row.ch}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-neutral-surface-raised border border-neutral-border rounded-lg p-4">
            <h2 className="text-[13px] font-semibold text-neutral-text-primary mb-3">Quiet hours</h2>
            <div className="flex items-center gap-2.5">
              <Toggle
                on={preferences.quietHoursEnabled}
                onToggle={toggleQuiet}
                ariaLabel="Quiet hours"
              />
              <span className="text-[13px] text-neutral-text-primary">Suppress non-critical notifications</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <QuietHourSelect
                label="From"
                value={quietFrom}
                options={QUIET_FROM_OPTIONS}
                onChange={(v) => setQuietFrom(`${v}:00`)}
              />
              <QuietHourSelect
                label="Until"
                value={quietUntil}
                options={QUIET_UNTIL_OPTIONS}
                onChange={(v) => setQuietUntil(`${v}:00`)}
              />
            </div>
            <p className="text-[12px] text-neutral-text-secondary mt-3 leading-snug">
              Critical-path slips and risk escalations always notify immediately.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Toggle({ on, onToggle, ariaLabel }: { on: boolean; onToggle: () => void; ariaLabel: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={onToggle}
      className={[
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        on ? 'bg-brand-primary border-brand-primary' : 'bg-neutral-surface-sunken border-neutral-border',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
          on ? 'translate-x-3.5' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  );
}

function QuietHourSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  // Ensure the current value appears in the list even if it's not one of the
  // preset options (e.g. a user PATCHed an arbitrary time via the API directly).
  const merged = options.includes(value) ? options : [value, ...options];
  return (
    <label className="block">
      <div className="text-[11px] text-neutral-text-secondary mb-1">{label}</div>
      <div className="relative">
        <select
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full h-8 pl-2.5 pr-7 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
        >
          {merged.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <svg
          className="pointer-events-none absolute right-2 top-2.5 text-neutral-text-secondary"
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
    </label>
  );
}
