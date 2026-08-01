import type { Methodology } from '@/types';

/**
 * The display label for a project methodology (web-rule 196: always the resolved
 * `effective_methodology`, never a raw per-project override, at the call site).
 *
 * Centralized here because three shell surfaces render it — the Customize-views
 * menu's "Reset to {Method} default", the location-switcher project-picker
 * subtitle, and the rail "This project" card subtitle (issue #1680) — and a shared
 * label keeps them from drifting.
 */
const METHOD_LABEL: Record<Methodology, string> = {
  AGILE: 'Agile',
  WATERFALL: 'Waterfall',
  HYBRID: 'Hybrid',
};

export function methodologyLabel(methodology: Methodology): string {
  return METHOD_LABEL[methodology];
}

/**
 * Full descriptive phrase for a project's *resolved* methodology, including
 * whether it currently matches the workspace default (issue #2619).
 *
 * The rail subtitle and `MethodologyIndicator` badge used to render bare
 * `"${label} workspace"` — wording that describes the *workspace's* methodology
 * when the value on screen is this specific *project's* resolved preset (a
 * project named "Waterfall" that never touched its own setting still resolves to
 * HYBRID by inheritance and would read "Hybrid workspace", implying the org runs
 * Hybrid). This drops "workspace" and instead states the fact the client can
 * actually verify.
 *
 * `effective`/`inherited` come straight off the project detail read (ADR-0107).
 * When they match, the project is either genuinely locked to the workspace
 * default (`methodologyOverridePolicy === 'inherit'`) or its own explicit value
 * just happens to equal that default — methodology has no per-scope null
 * "inherit" sentinel the way `iteration_label` etc. do (`methodology.py`), and the
 * policy itself is only readable from an admin-only workspace endpoint, so the
 * client cannot tell those two cases apart here. This only ever asserts the fact
 * both cases share — the project currently reads the workspace default — never a
 * specific inheritance mechanism. When they differ, the project's own value is a
 * verified override and the phrase says so with no qualifier.
 *
 * `inherited` is optional so call sites on an older cached payload (or before
 * the project query resolves) degrade to the plain label rather than asserting a
 * fact they cannot back up.
 */
export function methodologyStatusLabel(effective: Methodology, inherited?: Methodology): string {
  const label = `${METHOD_LABEL[effective]} methodology`;
  return inherited !== undefined && inherited === effective
    ? `${label} (workspace default)`
    : label;
}
