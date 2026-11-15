import { FieldHelp } from '@/components/FieldHelp';

/**
 * Contextual help for the guardrail notice (#3714). The notice carries the
 * server's one-line reason; this says what a guardrail is and why the write
 * already succeeded, which the line cannot.
 */
export function GuardrailBreachHelp() {
  return (
    <FieldHelp
      label="Sprint guardrails"
      docHref="administration/project-settings/#sprint-guardrails"
      docLabel="About sprint guardrails"
      body={
        <div className="flex flex-col gap-2">
          <p>
            A guardrail is a sprint-composition rule your project set. The line beside this
            button names the rule that tripped and why it matters.
          </p>
          <ul className="flex flex-col gap-1 text-xs text-neutral-text-secondary">
            <li>
              <strong className="text-neutral-text-primary">Warn</strong> — the assignment already
              went through. <em>Keep it here</em> records your override; <em>Undo</em> reverts it.
            </li>
            <li>
              <strong className="text-neutral-text-primary">Block</strong> — the assignment is
              refused and nothing is saved. Only the project owner can turn a rule from Warn to
              Block.
            </li>
          </ul>
        </div>
      }
    />
  );
}
