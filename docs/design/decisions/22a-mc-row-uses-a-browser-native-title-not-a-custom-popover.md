# Rule 22a — MC row uses a browser-native title, not a custom popover

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Monte Carlo Row Rules*

**MC row uses a browser-native `title`, not a custom popover.** The plain-English explanation (`"8 in 10 simulations finish by {date}"` for real distributions, `"Every simulation finished on {date}. Add PERT estimates …"` when percentiles collapse to one date) is carried by the `title` attribute on the row's static `div`, mirrored to `aria-label` for screen readers. The previous `mouseenter`-triggered popover opened on cursor pass-through and overlapped the unscheduled gutter sitting directly above; native `title` doesn't fire on transient hovers and never positions over adjacent elements. The full histogram lives in `MCResultPanel` (TopBar P80 click) and `MonteCarloSheet` (mobile) — surfaces where the user has explicitly asked for distribution shape.
