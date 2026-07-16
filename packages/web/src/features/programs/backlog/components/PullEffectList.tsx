/**
 * The shared "what will happen" bullets for a pull, rendered identically by the
 * desktop pull-confirm pane and the mobile pull sheet. Extracted so the copy
 * lives in one place (it drifted between the two surfaces before #1996).
 */

interface PullEffectListProps {
  /** Target project name, when a project is selected — personalizes bullet 2. */
  projectName: string | null;
  className?: string;
}

export function PullEffectList({ projectName, className = '' }: PullEffectListProps) {
  return (
    <ul className={`space-y-1 text-xs leading-relaxed text-neutral-text-secondary ${className}`}>
      <li>• This item becomes Pulled</li>
      <li>• New task in {projectName ? `${projectName}'s` : 'the project'} backlog</li>
      <li>• Title, description, story points, tags, and type are copied over</li>
      <li>• Closing the task closes this item</li>
    </ul>
  );
}
