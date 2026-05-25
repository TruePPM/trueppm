---
title: Program risk policy
description: Decide what a program does when a cross-project dependency slips — surface it, warn the people involved, or block the successor and escalate.
---

When one project's task is a predecessor for a task in another project in the same **program**, a slip in the first can block the second. The **Program Settings → Risk & deps policy** page decides what the program does when that happens. Open it at **Program → Settings → Risk & deps policy**.

The page has three parts:

1. A **read-only 5×5 risk matrix** showing the organization-wide probability × impact thresholds.
2. A **cross-project dependency slip** policy — the main control on this page.
3. An **auto-escalate after** day count.

This is intra-program only. The policy governs dependencies *between projects inside the same program*. Cross-program and portfolio coordination is out of scope — that is an Enterprise concern.

<!-- TODO(#722): screenshot — Program Settings → Risk & deps policy page showing the read-only risk matrix, the slip-propagation radio group, and the escalation-days input. -->

## Permissions

| Action | Minimum role |
|--------|-------------|
| View the risk policy | Program Viewer |
| Change the slip policy or escalation days | Program Admin |

A program Viewer sees the page in read-only mode. Only a program Admin can change the slip policy or the escalation window.

## The risk matrix is read-only here

The 5×5 matrix (probability 1–5 × impact 1–5, scored low / medium / high / critical) is shown for reference but cannot be edited on this page. The thresholds are **organization-wide**, not per-program, so they are managed elsewhere and rendered here read-only so program admins can see the scale their slip policy operates against.

## Slip propagation

This is the core decision: what the program does when a predecessor task in one project slips and blocks a successor in another. There are three rungs, which let a PM step up enforcement as a program matures.

| Policy | Identifier | Behavior |
|--------|-----------|----------|
| No action | `none` | The slip is visible in the schedule, but no notification or gate fires. A deliberate opt-out. |
| Warn only (default) | `warn` | Notifies the successor PM and the program manager via an in-app alert. The successor task is not blocked. |
| Block & escalate | `block` | Locks the successor task from starting and opens an escalation ticket. The strongest enforcement. |

`warn` is the default because it matches how the program overview already renders a slip indicator: the overview surfaces the slip, and `warn` adds an in-app alert to the people involved without gating work. `none` and `block` are explicit opt-outs in either direction — silence the alert, or harden it into a gate.

## Escalation days

The **Auto-escalate after** value is the number of days a blocked dependency can sit without resolution before it escalates to the program manager. It must be an integer **between 1 and 30**; the default is **3**. Values outside that range are rejected (the page surfaces the error inline before you can save).

### How escalation interacts with the slip indicator

The slip indicator on the program overview surfaces a cross-project dependency slip as soon as it is detected. Escalation days govern *how long that slipped dependency may remain unresolved* before it is escalated to the program manager:

- Under **Warn only**, the slip indicator appears and the successor PM and program manager get an in-app alert immediately. If the dependency is still unresolved after the escalation window, it escalates to the program manager.
- Under **Block & escalate**, the successor task is locked and an escalation ticket opens; the escalation window bounds how long that blocked state persists before the escalation is raised to the program manager.
- Under **No action**, nothing escalates — the slip is only visible in the schedule, so the escalation window has no effect.

The slip indicator answers *"has something slipped?"*; the escalation days answer *"how long before we raise it?"*

The slip policy and the escalation days are edited together and saved together via the settings save bar.

## FAQ

**Why can't I edit the risk matrix here?**
The probability/impact thresholds are organization-wide so that risk scores mean the same thing across every program. They are shown here read-only as the reference scale; editing them is a separate, org-level concern.

**Does the slip policy apply across programs?**
No. It applies only to dependencies between projects within the same program. Cross-program coordination is an Enterprise capability and is out of scope for this page.

**What happens at exactly the escalation-day boundary?**
Escalation fires once a blocked dependency has been unresolved for the configured number of days. Set it lower to escalate sooner, higher to give teams more room to resolve a slip before the program manager is pulled in. The allowed range is 1–30 days.

**What is the API behind this page?**
`GET` and `PATCH` `/api/v1/programs/{program_id}/risk-policy/`, returning `slip_propagation` (`none` / `warn` / `block`) and `escalation_days` (1–30). Reads require program Viewer; writes require program Admin. Both fields are validated server-side.
