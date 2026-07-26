# Rule 142 — The brand mark is the duotone dependency-arrow LogoMark

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Design System v2.0 — Navy/Sage Brand (ADR-0103)*

**The brand mark is the duotone dependency-arrow `LogoMark`** (`Icons.tsx`) — navy nodes (`fill-navy-700 dark:fill-reversed`) + sage arrow (`fill-sage-500`, holds in both modes; the arrowhead is a *fill*, so sage-500 is correct there per rule 143). Never `currentColor` (it is two-color). The wordmark (`Logo.tsx`) is **"True" navy + "PPM" sage**, `font-display` (Space Grotesk) Bold `-0.02em`, no space; the accessible name lives on the lockup's `aria-label` (the visible text is split across spans — assert it via `getByLabelText`/`getByRole`, never `getByText('TruePPM')`). The "PPM" sage is **`text-brand-primary`** (sage-700 on light / sage-400 on dark) — it is AA *foreground text*, so it must NOT use the fills-only sage-500, which is only 2.88:1 as text on white (rule 143; was a 1.4.3 fail fixed in #1689). Render ≥24px; below 28px use the favicon build.
