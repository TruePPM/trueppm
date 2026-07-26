# Rule 154 — The Project Settings → Team tab is methodology-gated in 0.3, not team-count-gated

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Team Settings + Facet Axis Rules (Issue #927, ADR-0078)*

**The Project Settings → Team tab is methodology-gated in 0.3, not team-count-gated.** The tab (`features/settings/team/ProjectTeamPage.tsx`) renders in the Setup nav group iff `project.methodology` is `AGILE` or `HYBRID` (hidden on `WATERFALL`) — so waterfall projects never see Team UI. This is deliberately **not** the ADR-0078 §F single-team-invisibility rule: that rule (`team_count === 1` → hide) governs *multi-team chrome* (team picker, team-name labels, Sprint/Task team fields), which this tab does not render until #599. With only the auto-created default team existing in 0.3, a count gate would hide the tab forever and make facet assignment impossible, defeating the issue. Gate by methodology; the tab shows the single default team's role+facet matrix with no multi-team chrome.
