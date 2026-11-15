/**
 * The one place the settings model's "this value came from a scope above you" copy
 * is written (#3716). Workspace -> Program -> Project inheritance is the deepest
 * structural concept in settings, and a user learning it pattern-matches across
 * screens, so every screen must say it the same way: "Inherited from the <scope>
 * default". `grep -rn "Inherited from" src` should return this file and tests only.
 *
 * `system` is a real fourth state (no calendar set anywhere above the project) and
 * stays distinct ON PURPOSE, named in the same form. `parentTask` is a different
 * mechanism (task hierarchy governance, not the settings cascade) and is likewise
 * distinct on purpose rather than by drift.
 */
export const INHERIT_SOURCE = {
  program: 'the program default',
  workspace: 'the workspace default',
  programOrWorkspace: 'the program or workspace default',
  system: 'the system default',
  parentTask: 'the parent task',
} as const;

export type InheritSource = (typeof INHERIT_SOURCE)[keyof typeof INHERIT_SOURCE];

/** "Inherited from the program default" — optionally with the resolved value. */
export function inheritedFrom(source: string, value?: string): string {
  return value ? `Inherited from ${source} (${value})` : `Inherited from ${source}`;
}

/** "Inherited from the program default:" — the lead-in before a value rendered beside it. */
export function inheritedFromLead(source: string): string {
  return `${inheritedFrom(source)}:`;
}

/** Lowercase form for the middle of a composite aria-label: "inherited from the program default". */
export function inheritedFromPhrase(source: string): string {
  return `inherited from ${source}`;
}
