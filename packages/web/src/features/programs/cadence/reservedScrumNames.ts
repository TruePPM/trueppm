/**
 * Scrum vocabulary that must not be created as a program-level ceremony
 * template (ADR-0079). Mirrors RESERVED_SCRUM_CEREMONY_NAMES in
 * ``packages/api/src/trueppm_api/apps/projects/models.py`` — if you add a
 * name here, add it there as well. Comparison is case-insensitive on the
 * trimmed input value.
 */
export const RESERVED_SCRUM_CEREMONY_NAMES: ReadonlySet<string> = new Set([
  'sprint planning',
  'sprint review',
  'sprint retrospective',
  'retrospective',
  'retro',
  'daily scrum',
  'standup',
  'daily standup',
  'scrum of scrums',
]);

export function isReservedScrumName(name: string): boolean {
  return RESERVED_SCRUM_CEREMONY_NAMES.has(name.trim().toLowerCase());
}
