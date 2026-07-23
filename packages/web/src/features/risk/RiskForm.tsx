import { useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import type { Risk } from '@/api/types';
import { useCreateRisk, useUpdateRisk } from '@/hooks/useRisks';
import { RiskChip } from './RiskChip';
import { RiskTaskPicker } from './RiskTaskPicker';

function formatMutationError(error: Error): string {
  if (axios.isAxiosError(error) && error.response?.data) {
    const data = error.response.data as Record<string, unknown>;
    // DRF returns { field: ["error"] } or { detail: "error" }
    if (typeof data.detail === 'string') return data.detail;
    const messages: string[] = [];
    for (const [key, val] of Object.entries(data)) {
      if (Array.isArray(val)) messages.push(`${key}: ${val.join(', ')}`);
      else if (typeof val === 'string') messages.push(`${key}: ${val}`);
    }
    if (messages.length > 0) return messages.join('. ');
  }
  return error.message || 'Failed to save risk. Please try again.';
}

export interface RiskFormProps {
  projectId: string;
  risk?: Risk;
  onSuccess: () => void;
  onCancel: () => void;
}

const STATUS_OPTIONS: Array<{ value: Risk['status']; label: string }> = [
  { value: 'OPEN', label: 'Open' },
  { value: 'MITIGATING', label: 'Mitigating' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'ACCEPTED', label: 'Accepted' },
  { value: 'CLOSED', label: 'Closed' },
];

const CATEGORY_OPTIONS = [
  { value: 'TECHNICAL', label: 'Technical' },
  { value: 'EXTERNAL', label: 'External' },
  { value: 'ORGANIZATIONAL', label: 'Organizational' },
  { value: 'PROJECT_MANAGEMENT', label: 'Project Management' },
];

const RESPONSE_OPTIONS = [
  { value: 'AVOID', label: 'Avoid' },
  { value: 'MITIGATE', label: 'Mitigate' },
  { value: 'TRANSFER', label: 'Transfer' },
  { value: 'ACCEPT', label: 'Accept' },
];

const PROBABILITY_IMPACT_OPTIONS = [1, 2, 3, 4, 5] as const;

const INPUT_BASE =
  'w-full border border-neutral-border rounded-control px-3 bg-neutral-surface ' +
  'text-neutral-text-primary text-sm ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1';

export function RiskForm({ projectId, risk, onSuccess, onCancel }: RiskFormProps) {
  const isEdit = risk !== undefined;

  const [title, setTitle] = useState(risk?.title ?? '');
  const [description, setDescription] = useState(risk?.description ?? '');
  const [status, setStatus] = useState<Risk['status']>(risk?.status ?? 'OPEN');
  const [probability, setProbability] = useState<number>(risk?.probability ?? 3);
  const [impact, setImpact] = useState<number>(risk?.impact ?? 3);
  const [titleError, setTitleError] = useState('');
  // Linked tasks (#2156). Seed from the risk's current links; on submit the full
  // desired set is sent because the serializer replaces (not appends) the M2M.
  const [taskIds, setTaskIds] = useState<string[]>(risk?.tasks ?? []);

  // Risk framework fields — Advanced section
  const [category, setCategory] = useState<string>(risk?.category ?? '');
  const [response, setResponse] = useState<string>(risk?.response ?? '');
  const [mitigationDueDate, setMitigationDueDate] = useState(risk?.mitigation_due_date ?? '');
  const [trigger, setTrigger] = useState(risk?.trigger ?? '');
  const [contingency, setContingency] = useState(risk?.contingency ?? '');
  // Auto-open if any framework field is already set (edit mode with existing data)
  const [advancedOpen, setAdvancedOpen] = useState(
    !!(
      risk?.category ||
      risk?.response ||
      risk?.mitigation_due_date ||
      risk?.trigger ||
      risk?.contingency
    ),
  );

  const createMutation = useCreateRisk();
  const updateMutation = useUpdateRisk();

  const isPending = createMutation.isPending || updateMutation.isPending;
  const mutationError = createMutation.error ?? updateMutation.error;
  const severity = probability * impact;

  function validate(): boolean {
    if (!title.trim()) {
      setTitleError('Title is required.');
      return false;
    }
    setTitleError('');
    return true;
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    createMutation.reset();
    updateMutation.reset();
    if (!validate()) return;

    const payload = {
      title: title.trim(),
      description,
      status,
      probability,
      impact,
      owner: null,
      tasks: taskIds,
      category: (category || null) as Risk['category'],
      response: (response || null) as Risk['response'],
      mitigation_due_date: mitigationDueDate || null,
      trigger,
      contingency,
    };

    if (isEdit) {
      updateMutation.mutate({ projectId, id: risk.id, data: payload }, { onSuccess });
    } else {
      createMutation.mutate({ projectId, data: payload }, { onSuccess });
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4 p-4">
      {/* Title */}
      <div className="flex flex-col gap-1">
        <label htmlFor="risk-title" className="text-sm font-medium text-neutral-text-primary">
          Title{' '}
          <span aria-hidden="true" className="text-semantic-critical">
            *
          </span>
        </label>
        <input
          id="risk-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={`${INPUT_BASE} h-11`}
          aria-required="true"
          aria-describedby={titleError ? 'risk-title-error' : undefined}
          aria-invalid={titleError ? 'true' : 'false'}
        />
        {titleError && (
          <p id="risk-title-error" role="alert" className="text-xs text-semantic-critical">
            {titleError}
          </p>
        )}
      </div>

      {/* Status */}
      <div className="flex flex-col gap-1">
        <label htmlFor="risk-status" className="text-sm font-medium text-neutral-text-primary">
          Status
        </label>
        <select
          id="risk-status"
          value={status}
          onChange={(e) => setStatus(e.target.value as Risk['status'])}
          className={`${INPUT_BASE} h-11`}
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Probability + Impact row */}
      <div className="flex gap-4">
        <div className="flex flex-col gap-1 flex-1">
          <label
            htmlFor="risk-probability"
            className="text-sm font-medium text-neutral-text-primary"
          >
            Probability (1–5)
          </label>
          <select
            id="risk-probability"
            value={probability}
            onChange={(e) => setProbability(Number(e.target.value))}
            className={`${INPUT_BASE} h-11`}
          >
            {PROBABILITY_IMPACT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1 flex-1">
          <label htmlFor="risk-impact" className="text-sm font-medium text-neutral-text-primary">
            Impact (1–5)
          </label>
          <select
            id="risk-impact"
            value={impact}
            onChange={(e) => setImpact(Number(e.target.value))}
            className={`${INPUT_BASE} h-11`}
          >
            {PROBABILITY_IMPACT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Severity — read-only computed display */}
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-neutral-text-primary">Severity</span>
        <div className="flex items-center gap-2 h-11 px-3 border border-neutral-border rounded-control bg-neutral-surface-raised">
          <span className="text-sm text-neutral-text-secondary">{severity}</span>
          <RiskChip severity={severity} />
        </div>
      </div>

      {/* Description */}
      <div className="flex flex-col gap-1">
        <label htmlFor="risk-description" className="text-sm font-medium text-neutral-text-primary">
          Description
        </label>
        <textarea
          id="risk-description"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={`${INPUT_BASE} resize-none py-2`}
        />
      </div>

      {/* Linked tasks (#2156) — attach existing project tasks (max 10) */}
      <RiskTaskPicker projectId={projectId} selectedIds={taskIds} onChange={setTaskIds} />

      {/* Advanced (risk framework) — collapsible.
          Standalone buttons (this toggle, the Cancel/Save actions) use focus: (not
          focus-visible:) so the ring shows on pointer-initiated focus in Firefox/Safari
          (rule 214, WCAG 2.4.7). Form fields (INPUT_BASE inputs/selects) keep focus-visible:. */}
      <div className="border border-neutral-border rounded-card">
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          aria-expanded={advancedOpen}
          className="w-full flex items-center justify-between px-3 h-10 text-sm font-medium rounded-control
            text-neutral-text-secondary hover:text-neutral-text-primary
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        >
          <span>Advanced</span>
          <svg
            className={`w-4 h-4 transition-transform duration-150 ${advancedOpen ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {advancedOpen && (
          <div className="px-3 py-3 flex flex-col gap-4 border-t border-neutral-border">
            {/* Category */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor="risk-category"
                className="text-sm font-medium text-neutral-text-primary"
              >
                Category
              </label>
              <select
                id="risk-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className={`${INPUT_BASE} h-11`}
              >
                <option value="">— none —</option>
                {CATEGORY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Response */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor="risk-response"
                className="text-sm font-medium text-neutral-text-primary"
              >
                Response
              </label>
              <select
                id="risk-response"
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                className={`${INPUT_BASE} h-11`}
              >
                <option value="">— none —</option>
                {RESPONSE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Mitigation Due Date */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor="risk-due-date"
                className="text-sm font-medium text-neutral-text-primary"
              >
                Mitigation Due Date
              </label>
              <input
                id="risk-due-date"
                type="date"
                value={mitigationDueDate}
                onChange={(e) => setMitigationDueDate(e.target.value)}
                className={`${INPUT_BASE} h-11`}
              />
            </div>

            {/* Trigger */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor="risk-trigger"
                className="text-sm font-medium text-neutral-text-primary"
              >
                Trigger
              </label>
              <p className="text-xs text-neutral-text-secondary">
                Condition that signals escalation
              </p>
              <textarea
                id="risk-trigger"
                rows={2}
                value={trigger}
                onChange={(e) => setTrigger(e.target.value)}
                className={`${INPUT_BASE} resize-none py-2`}
              />
            </div>

            {/* Contingency */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor="risk-contingency"
                className="text-sm font-medium text-neutral-text-primary"
              >
                Contingency
              </label>
              <textarea
                id="risk-contingency"
                rows={2}
                value={contingency}
                onChange={(e) => setContingency(e.target.value)}
                className={`${INPUT_BASE} resize-none py-2`}
              />
            </div>
          </div>
        )}
      </div>

      {/* Mutation error */}
      {mutationError && (
        <div
          role="alert"
          className="rounded-card border border-semantic-critical/30 bg-semantic-critical-bg px-3 py-2"
        >
          <p className="text-sm text-semantic-critical">
            {mutationError instanceof Error
              ? formatMutationError(mutationError)
              : 'Failed to save risk. Please try again.'}
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={isPending}
          className="h-10 px-4 rounded-control text-sm font-medium text-neutral-text-secondary
            border border-neutral-border
            hover:text-neutral-text-primary
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
            disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isPending}
          className="h-10 px-4 rounded-control text-sm font-medium text-neutral-text-inverse
            bg-brand-primary border border-brand-primary-dark
            hover:bg-brand-primary-dark
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
            disabled:opacity-50"
        >
          {isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
