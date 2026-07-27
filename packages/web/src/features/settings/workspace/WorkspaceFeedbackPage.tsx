/**
 * Workspace → System → Feedback (#2392).
 *
 * Two operator controls over the in-product "Report a bug" affordance:
 * whether it appears at all, and where it points.
 *
 * The control is a **link, not a beacon** — TruePPM never transmits anything on
 * this path, and this page says so where the operator is deciding, not only in
 * the docs. An air-gapped install can still leave it on and repoint it at an
 * internal helpdesk; turning it off is for deployments that want no outbound
 * affordance in the UI at all.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { FieldHelp } from '@/components/FieldHelp';
import { Toggle } from '../components/Toggle';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { useUpdateWorkspaceSettings } from '../hooks/useUpdateWorkspaceSettings';
import { DEFAULT_FEEDBACK_URL } from '@/lib/feedbackContext';

export function WorkspaceFeedbackPage() {
  const { data: ws, isLoading } = useWorkspaceSettings();
  const updateSettings = useUpdateWorkspaceSettings();

  const [enabled, setEnabled] = useState(true);
  const [url, setUrl] = useState('');
  const [initial, setInitial] = useState({ enabled: true, url: '' });

  useEffect(() => {
    if (!ws) return;
    const snap = { enabled: ws.feedbackEnabled, url: ws.feedbackUrl };
    setEnabled(snap.enabled);
    setUrl(snap.url);
    setInitial(snap);
  }, [ws]);

  const values = useMemo(() => ({ enabled, url }), [enabled, url]);

  const onSave = useCallback(async () => {
    await updateSettings.mutateAsync({ feedbackEnabled: enabled, feedbackUrl: url.trim() });
    setInitial({ enabled, url: url.trim() });
  }, [updateSettings, enabled, url]);

  const onReset = useCallback(() => {
    setEnabled(initial.enabled);
    setUrl(initial.url);
  }, [initial]);

  useDirtyForm({ values, initialValues: initial, onSave, onReset, apiReady: !!ws });

  if (isLoading || !ws) {
    return (
      <div className="px-6 py-8 space-y-3">
        <div className="h-16 rounded-card bg-neutral-surface-raised motion-safe:animate-pulse" />
      </div>
    );
  }

  return (
    <div>
      <SettingsPageTitle
        title="Feedback"
        subtitle="The in-product “Report a bug” control: whether it appears, and where it points. TruePPM never sends anything on this path — the control opens a prefilled page the user reads and submits themselves."
      />

      <div className="px-6 pb-8 max-w-[720px]">
        <FieldRow
          label="Report a bug control"
          hint="Show a “Report a bug” entry in the account menu and the command palette."
          help={
            <FieldHelp
              label="Report a bug control"
              body="Shows a “Report a bug” entry in the account menu and command palette. Choosing it opens a dialog showing exactly what would be included — TruePPM version, edition, the screen name, and the browser — which the user can edit before continuing to your tracker. Nothing is transmitted by TruePPM itself, on this path or any other."
              docHref="administration/configuration/"
            />
          }
        >
          <Toggle
            on={enabled}
            onChange={setEnabled}
            onLabel="Shown"
            offLabel="Hidden"
            ariaLabel="Show the report-a-bug control"
          />
        </FieldRow>

        <FieldRow
          label="Tracker URL"
          hint="Where the control sends the user. Leave blank to use the public TruePPM tracker."
          help={
            <FieldHelp
              label="Tracker URL"
              body="The page the report-a-bug control opens. Leave it blank to use the public TruePPM issue tracker. Point it at your own tracker or helpdesk to keep reports internal — the prefilled title and description are passed as query parameters, which a tracker that does not understand them simply ignores."
              docHref="administration/configuration/"
            />
          }
        >
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={!enabled}
            placeholder={DEFAULT_FEEDBACK_URL}
            aria-label="Tracker URL"
            className="h-9 w-full rounded-control border border-neutral-border bg-neutral-surface px-2 text-sm
              text-neutral-text-primary disabled:opacity-50
              focus:outline-none focus:ring-2 focus:ring-brand-primary"
          />
        </FieldRow>
      </div>
    </div>
  );
}
