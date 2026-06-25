import { useEffect, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import axios from 'axios';
import {
  useProgramPhaseGateConfig,
  useUpdateProgramPhaseGateConfig,
} from '@/features/programs/hooks/useProgramPhaseGateConfig';

export interface PhaseGateConfigPanelProps {
  programId: string;
  canEdit: boolean;
  onClose: () => void;
}

function formatMutationError(error: Error): string {
  if (axios.isAxiosError(error) && error.response?.data) {
    const data = error.response.data as Record<string, unknown>;
    if (typeof data.detail === 'string') return data.detail;
    const messages: string[] = [];
    for (const [key, val] of Object.entries(data)) {
      if (Array.isArray(val)) messages.push(`${key}: ${val.join(', ')}`);
      else if (typeof val === 'string') messages.push(`${key}: ${val}`);
    }
    if (messages.length > 0) return messages.join('. ');
  }
  return error.message || 'Couldn’t save phase-gate template.';
}

/**
 * Right-side slide-over for the singleton PhaseGateConfig (ADR-0079).
 *
 * Read-only for non-admin program members — they see the template but the
 * fields are disabled and the Save button is hidden, mirroring the API
 * permission matrix (IsProgramMember reads, IsProgramAdmin writes).
 */
export function PhaseGateConfigPanel({ programId, canEdit, onClose }: PhaseGateConfigPanelProps) {
  const { data: config, isLoading, isError } = useProgramPhaseGateConfig(programId);
  const update = useUpdateProgramPhaseGateConfig(programId);

  const [enabled, setEnabled] = useState(false);
  const [inviteTemplate, setInviteTemplate] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (config) {
      setEnabled(config.enabled);
      setInviteTemplate(config.invite_template);
    }
  }, [config]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !update.isPending) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, update.isPending]);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setFormError(null);
    try {
      await update.mutateAsync({ enabled, invite_template: inviteTemplate });
      onClose();
    } catch (err) {
      setFormError(formatMutationError(err as Error));
    }
  }

  function handleBackdropClick(e: MouseEvent<HTMLDivElement>): void {
    if (e.target === e.currentTarget && !update.isPending) onClose();
  }

  return (
    <div
      role="presentation"
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="phase-gate-panel-title"
        className="w-full max-w-[440px] h-full bg-neutral-surface-raised border-l border-neutral-border flex flex-col"
      >
        <header className="px-5 py-3 border-b border-neutral-border/55">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2
                id="phase-gate-panel-title"
                className="text-[14px] font-semibold text-neutral-text-primary"
              >
                Phase gate calendar
              </h2>
              <p className="text-xs text-neutral-text-secondary mt-0.5 leading-snug">
                Auto-scheduled when a phase boundary milestone is saved.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              disabled={update.isPending}
              className="text-neutral-text-secondary text-[20px] leading-none px-2 py-0.5 rounded-control hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:opacity-50"
            >
              ✕
            </button>
          </div>
        </header>

        {!canEdit && (
          <div
            role="status"
            className="mx-5 mt-3 rounded-card border border-neutral-border bg-neutral-surface-sunken px-3 py-2 text-xs text-neutral-text-secondary"
          >
            Read-only — only program admins can edit this template.
          </div>
        )}

        <form
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
          className="flex-1 overflow-y-auto px-5 py-4 space-y-4"
        >
          {isLoading && (
            <div role="status" className="text-xs text-neutral-text-secondary">
              Loading…
            </div>
          )}
          {isError && (
            <div role="alert" className="text-xs text-semantic-critical">
              Couldn’t load template config. Close and retry.
            </div>
          )}
          {!isLoading && !isError && (
            <>
              <label className="flex items-center gap-2 text-[13px] text-neutral-text-primary cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  disabled={!canEdit || update.isPending}
                  className="rounded-control border-neutral-border text-brand-primary focus-visible:ring-2 focus-visible:ring-brand-primary disabled:opacity-50"
                />
                Enabled
              </label>

              <div>
                <label
                  htmlFor="phase-gate-invite"
                  className="block text-xs font-semibold text-neutral-text-primary mb-1"
                >
                  Invite template
                </label>
                <textarea
                  id="phase-gate-invite"
                  value={inviteTemplate}
                  onChange={(e) => setInviteTemplate(e.target.value)}
                  rows={12}
                  readOnly={!canEdit}
                  disabled={update.isPending}
                  placeholder="Subject: Gate review – {{milestone.name}}

Hi team, we're reviewing the {{phase.name}} phase gate on {{date}}…"
                  className="w-full px-2.5 py-1.5 rounded-control border border-neutral-border bg-neutral-surface-base text-[12px] font-mono leading-snug focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:opacity-50"
                />
                <p className="text-[11px] text-neutral-text-secondary mt-1 leading-snug">
                  Available variables: <code>{'{{milestone.name}}'}</code>
                  {' · '}
                  <code>{'{{date}}'}</code>
                  {' · '}
                  <code>{'{{program.name}}'}</code>
                  {' · '}
                  <code>{'{{owner}}'}</code>
                </p>
              </div>

              {formError && (
                <div
                  role="alert"
                  className="rounded-card border border-semantic-critical/40 bg-semantic-critical-bg px-3 py-2 text-xs text-semantic-critical"
                >
                  {formError}
                </div>
              )}
            </>
          )}
        </form>

        {canEdit && !isLoading && !isError && (
          <footer className="px-5 py-3 border-t border-neutral-border/55 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={update.isPending}
              className="px-3 py-1.5 rounded-control border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={(e) => {
                void handleSubmit(e as unknown as FormEvent);
              }}
              disabled={update.isPending}
              className="px-3 py-1.5 rounded-control bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              {update.isPending ? 'Saving…' : 'Save'}
            </button>
          </footer>
        )}
      </aside>
    </div>
  );
}
