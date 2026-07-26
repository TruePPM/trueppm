# Rule 88 — Risk matrix zone tokens live in tailwind.config.ts under colors.risk

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Risk Register Rules*

**Risk matrix zone tokens live in `tailwind.config.ts` under `colors.risk`** — no hex
literals inside `RiskMatrix.tsx` or `RiskMatrixCell.tsx`. Tokens reference CSS custom
properties defined in `globals.css` so dark mode automatically swaps to higher-opacity
values that remain legible on dark surfaces. Light / dark values:
```
risk.zone-critical: rgba(185,28,28,0.08)   /  rgba(248,113,113,0.28)
risk.zone-high:     rgba(232,160,32,0.12)  /  rgba(251,146,60,0.22)
risk.zone-medium:   rgba(232,160,32,0.06)  /  rgba(251,191,36,0.16)
risk.zone-low:      rgb(245,245,240)        /  rgba(74,222,128,0.22)
risk.zone-minimal:  rgb(255,255,255)        /  rgba(74,222,128,0.08)
```
