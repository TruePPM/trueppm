import type { FormEvent } from 'react';
import { Button } from '@/components/Button';

interface MentionGroupCreateFormProps {
  /** Distinguishes the project vs program create-form field ids on one page (#3903). */
  idPrefix: string;
  namePlaceholder: string;
  newName: string;
  newDescription: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  submitDisabled: boolean;
  nameErrorMessage?: string;
}

/**
 * "New group" create form shared by `MentionGroupsSection` and
 * `ProgramMentionGroupsSection` (#3903) — identical fields, only the id
 * prefix, placeholder, and submit gating differ per caller.
 */
export function MentionGroupCreateForm({
  idPrefix,
  namePlaceholder,
  newName,
  newDescription,
  onNameChange,
  onDescriptionChange,
  onSubmit,
  submitDisabled,
  nameErrorMessage,
}: MentionGroupCreateFormProps) {
  return (
    <form onSubmit={onSubmit} className="mt-4 space-y-2">
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="flex-1">
          <label htmlFor={`${idPrefix}-name`} className="sr-only">
            Group name
          </label>
          <input
            id={`${idPrefix}-name`}
            value={newName}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder={namePlaceholder}
            aria-invalid={nameErrorMessage ? true : undefined}
            className="h-8 w-full rounded border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          />
        </div>
        <div className="flex-1">
          <label htmlFor={`${idPrefix}-description`} className="sr-only">
            Description (optional)
          </label>
          <input
            id={`${idPrefix}-description`}
            value={newDescription}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder="Description (optional)"
            className="h-8 w-full rounded border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          />
        </div>
        <Button type="submit" disabled={submitDisabled}>
          New group
        </Button>
      </div>
      {nameErrorMessage && (
        <p role="alert" className="text-xs text-semantic-critical">
          {nameErrorMessage}
        </p>
      )}
    </form>
  );
}
