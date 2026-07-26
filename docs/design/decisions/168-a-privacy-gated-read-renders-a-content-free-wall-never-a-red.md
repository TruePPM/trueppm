# Rule 168 — A privacy-gated read renders a content-free wall, never a redacted teaser — the gate is a server fact the client only branches on

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Live retro board + team-health pulse (Issue #851 / #923, ADR-0117)*

**A privacy-gated read renders a content-free wall, never a redacted teaser — the gate is a server fact the client only branches on.** When a server signal is withheld (the pulse trend's `{gated: true}`, ADR-0104), the component returns ONLY the "kept private" wall — no count, no blurred chart, no "request access" CTA (social pressure is itself a leak). The gated/ungated shape is a discriminated union on a server `gated` flag (`usePulseTrend`); the client never receives the data and computes nothing from it. Mirror this for any future team-private signal surface: branch on the server's gate, render an explanatory wall with zero numbers, and keep the aggregate math server-side (the client renders `energy_declining` etc. as given, never derives a trend from raw responses it should never hold).
