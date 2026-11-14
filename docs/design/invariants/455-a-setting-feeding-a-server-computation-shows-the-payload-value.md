# Rule 455 — A setting that feeds a server computation is shown on the consuming surface as the payload's value, never re-read from settings

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Product boundary*. The index carries the rule's headline; this file carries its full text (#4892). Binding on every surface it names.

Settings that feed a server computation are shown on the consuming surface as the payload's value ("Near-critical: ≤ 10 wd float"), never re-read from settings, so the two cannot disagree on screen (#4892).

**Origin.** Written with the Schedule drawer's "Why critical" section (#4892), whose design (ux-design, 2026-11-14) surfaced it. It applies to any later surface of the same shape, not only that one.
