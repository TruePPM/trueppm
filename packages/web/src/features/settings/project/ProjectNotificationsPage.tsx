import { useId } from 'react';

import { useProjectId } from '@/hooks/useProjectId';
import {
  PROJECT_NOTIFICATION_CHANNELS,
  PROJECT_NOTIFICATION_EVENTS,
  ProjectNotificationChannel,
  ProjectNotificationEventType,
  isChannelUndeliverable,
  useProjectNotificationPreferences,
} from '@/hooks/useProjectNotificationPreferences';
import { SettingsPageTitle } from '../SettingsShell';
import { FieldHelp } from '@/components/FieldHelp';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { quietHoursTimezoneCopy } from './quietHoursTimezone';

const QUIET_FROM_OPTIONS = ['18:00', '19:00', '20:00', '21:00', '22:00'];
const QUIET_UNTIL_OPTIONS = ['06:00', '07:00', '08:00', '09:00'];

/** Project > Notifications settings page. Wired to the per-project
 * notification preferences API (#522). */
export function ProjectNotificationsPage() {
  const projectId = useProjectId();
  const noteId = useId();
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

  // The window is a bare wall-clock range, so "20:00" alone never said 20:00
  // *where* (#3397). The server resolves the zone and reports which tier of the
  // project → workspace → server → UTC chain supplied it; both selects point at
  // this line via aria-describedby, because the person picking the time is
  // exactly who needs the zone. Null when the response predates #3377.
  const quietZoneNote = quietHoursTimezoneCopy(
    preferences?.quietHoursTimezone,
    preferences?.quietHoursTimezoneSource,
  );
  const quietZoneNoteId = `quiet-hours-tz-${noteId}`;

  // The two delivery axes, resolved once. Every surface that speaks about them — the
  // column markers, the banner, the card below, and each switch's accessible name —
  // reads these, so the page cannot say two different things about the same channel
  // (web-rule 406). Prose that names members is built from `deadChannels`, never
  // written as literals: the set is server-owned now and can shrink without a web
  // release, and a hardcoded paragraph would outlive the marker it contradicts.
  const deadChannels = PROJECT_NOTIFICATION_CHANNELS.filter((c) =>
    isChannelUndeliverable(preferences?.channelDelivery ?? {}, c.channel),
  );
  const hasDeadEvents = PROJECT_NOTIFICATION_EVENTS.some(
    (evt) => preferences?.eventDelivery[evt.type] === false,
  );
  const deadChannelNames = formatList(deadChannels.map((c) => c.label.toLowerCase()));
  const slackIsDead = deadChannels.some((c) => c.channel === 'slack');

  if (isLoading) {
    return (
      <div>
        <SettingsPageTitle
          title="Notifications"
          subtitle="Per-project routing rules. Members can override these in their personal preferences."
        />
        <LoadingSkeleton label="Loading notification rules…" rows={4} className="px-6 pb-8" />
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
        <div className="px-6 pb-8 text-[13px] text-semantic-critical" role="alert">
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
        <div className="bg-neutral-surface-raised border border-neutral-border rounded-card p-4 flex items-start gap-4">
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
            'bg-neutral-surface-raised border border-neutral-border rounded-card overflow-hidden transition-opacity',
            preferences.paused ? 'opacity-50' : '',
          ].join(' ')}
        >
          <div
            className="grid px-4 py-2.5 bg-neutral-surface-sunken border-b border-neutral-border/55 text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary"
            style={{ gridTemplateColumns: `2fr repeat(${PROJECT_NOTIFICATION_CHANNELS.length}, 110px)` }}
          >
            <span className="flex items-center gap-1.5">
              Event
              <FieldHelp
                label="Notification routing"
                body="Each row is an event that can happen on this project; each column is a delivery channel. Turning a cell on says you want that event on that channel; turning it off silences it. That is a routing choice, not a promise that it reaches you — rows and columns marked not delivered yet send nothing today, and your choice is saved until they do. These are your personal rules for this project: other members set their own, and you can override them in your account-wide notification preferences."
                docHref="features/settings/project-notifications/#the-default-matrix"
              />
            </span>
            {/* Column marker, from the server's `channel_delivery` (#3378) — the
                per-column twin of the per-row `eventDelivery` badges below. The
                two axes are independent: `comment_mention` IS dispatched and its
                Slack cell still delivers nothing, so a row badge cannot cover
                this. The hardcoded list this used to read stays only as the
                answer for a server too old to send the map. */}
            {PROJECT_NOTIFICATION_CHANNELS.map((c) => (
              <span key={c.channel} className="text-center">
                {c.label}
                {deadChannels.some((d) => d.channel === c.channel) && (
                  <span
                    className="block font-normal normal-case tracking-normal text-[10px] text-neutral-text-secondary"
                    title="TruePPM does not deliver on this channel yet — your choice is saved and will apply once delivery ships."
                  >
                    not delivered yet
                  </span>
                )}
              </span>
            ))}
          </div>

          {/* The only at-rest explanation of either marker, so it has to cover both
              axes and appear whenever EITHER has a dead member. Gated on the row axis
              alone, a server that dispatches every event and delivers on no channel
              rendered two column markers whose consequence was stated nowhere but a
              `title` and a popover — rule 328(b)'s defect, re-created by making the
              set dynamic while its explanation stayed static (web-rule 406(c)). */}
          {(hasDeadEvents || deadChannels.length > 0) && (
            <p className="px-4 py-2 text-[12px] text-neutral-text-secondary border-b border-neutral-border/55">
              Rows and columns marked <span className="font-medium">not delivered yet</span>{' '}
              send nothing today, so changing them has no effect. Your choice is saved and
              applies once delivery ships.
            </p>
          )}

          {PROJECT_NOTIFICATION_EVENTS.map((evt, ri) => (
            <div
              key={evt.type}
              className={[
                'grid items-center px-4 py-2.5 text-[13px]',
                ri < PROJECT_NOTIFICATION_EVENTS.length - 1 ? 'border-b border-neutral-border/55' : '',
              ].join(' ')}
              style={{ gridTemplateColumns: `2fr repeat(${PROJECT_NOTIFICATION_CHANNELS.length}, 110px)` }}
            >
              <span className="flex items-baseline gap-2 flex-wrap min-w-0">
                <span className="text-neutral-text-primary">{evt.label}</span>
                {preferences.eventDelivery[evt.type] === false && (
                  <span
                    className="text-[11px] text-neutral-text-secondary whitespace-nowrap"
                    title="This event is not dispatched yet — your setting is saved and will apply once it is."
                  >
                    not delivered yet
                  </span>
                )}
              </span>
              {PROJECT_NOTIFICATION_CHANNELS.map(({ channel, label }) => {
                const on = preferences.matrix[evt.type]?.[channel] ?? false;
                // The name is synthesized, so it is the ONLY place a screen-reader
                // user can learn either fact: `aria-label` overrides sibling content,
                // the row badge is a sibling span, the column marker lives in an
                // unrelated header row, and the CSS grid carries no table semantics
                // to associate either. Without this a sighted user sees two markers
                // and an SR user gets none while operating 36 switches, some inert.
                // `label`, not `channel` — the raw enum key announced as "mobile_push".
                const dead =
                  deadChannels.some((d) => d.channel === channel) ||
                  preferences.eventDelivery[evt.type] === false;
                return (
                  <span key={channel} className="flex justify-center">
                    <Toggle
                      on={on}
                      onToggle={() => setCell(evt.type, channel, !on)}
                      ariaLabel={`${evt.label} via ${label}${dead ? ', not delivered yet' : ''}`}
                    />
                  </span>
                );
              })}
            </div>
          ))}
        </div>

        {/* Undelivered-channel explainer + Quiet hours. The row collapses to one
            column when there is no dead channel to explain, so Quiet hours takes the
            width rather than sitting beside a hole. */}
        <div
          className={[
            'grid gap-3.5',
            deadChannels.length > 0 ? 'grid-cols-2' : 'grid-cols-1',
          ].join(' ')}
        >
          {/* Built from `deadChannels`, heading included, and not rendered at all when
              the set is empty. Hardcoded as "Slack & mobile delivery" over present-tense
              prose, this card outlived the marker it explains: the day the server
              delivers on Slack the 10px caption disappears and an <h2> plus a paragraph
              keep asserting the opposite — and the loud half wins (web-rule 406). */}
          {deadChannels.length > 0 && (
          <div className="bg-neutral-surface-raised border border-neutral-border rounded-card p-4">
            <h2 className="text-[13px] font-semibold text-neutral-text-primary mb-3">
              Channels TruePPM does not deliver on yet
            </h2>
            <p className="text-[12px] text-neutral-text-secondary leading-snug mb-3">
              TruePPM does not deliver notifications to {deadChannelNames} yet, and no
              setting turns {deadChannels.length > 1 ? 'them' : 'it'} on. Those columns are
              kept so you can record your routing intent now — it applies once delivery
              ships.
            </p>
            {slackIsDead && (
              <p className="text-[12px] text-neutral-text-secondary leading-snug">
                To get project events into Slack today, add a Slack-format webhook under{' '}
                <span className="font-semibold text-neutral-text-primary">
                  Project Settings → Integrations
                </span>
                . That is a project-wide feed on its own event list — it does not read the
                matrix above, and it is not per-person routing.
              </p>
            )}
          </div>
          )}

          <div className="bg-neutral-surface-raised border border-neutral-border rounded-card p-4">
            <div className="flex items-center gap-1.5 mb-3">
              <h2 className="text-[13px] font-semibold text-neutral-text-primary">Quiet hours</h2>
              <FieldHelp
                label="Quiet hours"
                body="During the window you set, non-critical notifications are held back so you aren't pinged overnight. Critical-path slips and risk escalations always notify immediately, regardless of quiet hours. The window may wrap past midnight (e.g. 20:00 to 07:00). The times are read in the project's timezone, set under Project → Settings → General; a project that sets none follows the workspace default, which a workspace admin changes under Workspace → Settings → General. It is not a display timezone — times elsewhere in TruePPM are still shown in your own."
                docHref="features/settings/project-notifications/#quiet-hours"
              />
            </div>
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
                describedBy={quietZoneNote ? quietZoneNoteId : undefined}
                onChange={(v) => setQuietFrom(`${v}:00`)}
              />
              <QuietHourSelect
                label="Until"
                value={quietUntil}
                options={QUIET_UNTIL_OPTIONS}
                describedBy={quietZoneNote ? quietZoneNoteId : undefined}
                onChange={(v) => setQuietUntil(`${v}:00`)}
              />
            </div>
            {quietZoneNote && (
              <p
                id={quietZoneNoteId}
                className="text-[12px] text-neutral-text-secondary mt-2 leading-snug"
              >
                {quietZoneNote}
              </p>
            )}
            <p className="text-[12px] text-neutral-text-secondary mt-3 leading-snug">
              Critical-path slips and risk escalations always notify immediately.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * "Slack", "Slack and mobile push", "a, b, and c" — for prose built from a set.
 *
 * Exported for its own vitest: the card is gated on a non-empty set and only two of
 * four columns are dead, so the empty and three-or-more branches are unreachable
 * through the component and testable nowhere else.
 */
export function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
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
          'inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform',
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
  describedBy,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  /** Id of the resolved-timezone caption, so "From" announces the zone too. */
  describedBy?: string;
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
          aria-describedby={describedBy}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full h-8 pl-2.5 pr-7 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
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
