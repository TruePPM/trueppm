---
title: Team Ownership Is Not Surveillance
description: The signals a team generates about its own flow belong to the team. TruePPM surfaces the review-queue and velocity a hybrid human/AI team needs to manage itself — team-owned, opt-in to roll upward, never a management dashboard.
---

The fastest way to ruin a metric is to point it at the people it measures. The moment a
tool shows management how quickly each engineer reviews work — or how many items an
agent's output is piling up in front of a named reviewer — that number stops being a
signal the team can act on and becomes a stopwatch the team games or abandons. It is the
same failure that turned "velocity" from a planning aid into a productivity gauge on so
many dashboards.

Hybrid human/AI work makes the temptation worse, not better. When agents draft and humans
review, the review queue becomes the real bottleneck — and the obvious, wrong move is to
put "reviewer throughput" on a leadership dashboard and start staffing against it.

**TruePPM draws the line the other way.** The signals a team generates about its own flow
belong to the team:

> A signal that measures how hard a person — or their agents — is working stays with the
> team. A signal that answers "will we hit the date" rolls up, as a confidence-weighted
> forecast, not a scoreboard.

This is not a new stance. Sprint **velocity is never auto-exposed** to the PMO as a
productivity metric — the team owns it (sprint sovereignty, shipped in 0.3). The MCP
automation surface is designed so that read access to sprint internals stays scoped, so
*automation never becomes surveillance*. The hybrid **review-gate signal** will extend the
same principle to agent-era work.

:::note[Version status]
The sprint-sovereignty stance (velocity is never a management gauge) is **shipped as of
0.3**. The hybrid **review-gate queue signal** described below **ships in 0.5** — until
then, treat that part as a statement of intent, not of shipped behavior. See the
[roadmap](/overview/roadmap/) for the authoritative Shipped / Underway / Planned status.
:::

## Where the line falls

| Signal | Who sees it by default | Rolls up to management? |
| --- | --- | --- |
| Individual review latency / who-reviewed-how-fast | The reviewing engineers and their Scrum Master or tech lead | **Never** |
| Review-queue depth &amp; drain-time — team capacity *(ships in 0.5)* | The team | Only by the team's **explicit, audited opt-in** |
| Sprint velocity | The team | **Never** auto-exposed as a productivity gauge (sprint sovereignty) |
| Milestone confidence / schedule forecast (P80) | The team | **Yes** — a confidence-weighted forecast is what management sees |

Management gets the answer it actually needs — *is the plan on track, and with what
confidence* — without being handed a per-person efficiency ranking it does not need and
should not have.

Two consequences fall out of the principle:

- **Opt-in is RBAC-enforced, not an admin toggle.** Rolling a team-capacity read upward is
  a decision the team makes, gated like a mid-sprint scope change — an explicit, audited
  action — not a switch a PMO administrator can flip on the team's behalf.
- **Consent does not travel.** When a post-1.0 enterprise deployment aggregates team
  signals into a cross-program view, the same per-team consent **re-applies**. Consent is
  never "once-granted, always-granted."

## One of the lines we draw on purpose

Team ownership is not surveillance is one of TruePPM's four
[**guiding principles**](/overview/principles/) — alongside *computed, not guessed*,
*adoption over gatekeeping* ([SSO is not an enterprise feature](/overview/sso-is-not-enterprise/)),
and *your data, your infrastructure*. The through-line: a tool a team must adopt voluntarily
has to be built for the team first. A signal that becomes a management weapon is a signal the
team stops trusting — and an untrusted signal is worthless to management too.
