/**
 * Presentation metadata for the role-context lens switcher (issue 1263, ADR-0161).
 *
 * Single source of the user-facing copy so the compact UserMenu segmented and
 * the settings radio-card group never drift. The lens is presentation-only; the
 * copy deliberately says "view" not "role" so it never reads as a permissions
 * change (it isn't one — RBAC is untouched).
 */
import type { RoleContext } from '@/hooks/useCurrentUser';

export interface RoleContextChoice {
  value: RoleContext;
  /** Full label (settings cards, accessible name of the segmented buttons). */
  label: string;
  /** Compact label for the inline UserMenu segmented control. */
  shortLabel: string;
  /** One-line helper shown on the settings card. */
  description: string;
}

/** The row label used on both surfaces — "View focus", not "Role …" (rule: no implied permission change). */
export const ROLE_CONTEXT_LABEL = 'View focus';

/** Options in display order — `unified` (neutral default) leads, never PM-first. */
export const ROLE_CONTEXT_CHOICES: readonly RoleContextChoice[] = [
  {
    value: 'unified',
    label: 'Unified Today',
    shortLabel: 'Unified',
    description: 'A balanced view that blends planning and delivery. The default.',
  },
  {
    value: 'pm',
    label: 'PM',
    shortLabel: 'PM',
    description: 'Opens each project on its Schedule and leads with planning views.',
  },
  {
    value: 'scrum_master',
    label: 'Scrum Master',
    shortLabel: 'Scrum',
    description: 'Opens each project on its Board and leads with sprint views.',
  },
] as const;
