# Workflow engine vs. transactional outbox: which do I need?

**Reference:** [ADR-0080](../adr/0080-durable-workflow-execution.md) (workflow engine) · [`on_commit` durability audit](on-commit-audit.md) (outbox)

TruePPM has two durability mechanisms for async work. They solve **different**
problems and they **compose** — the workflow engine is additive to the outbox,
not a replacement. Reaching for the wrong one adds either fragility (a multi-step
process glued together by hand) or ceremony (a whole workflow to send one email).

## The short answer

| You need to… | Use |
|---|---|
| Reliably run **one** task after a DB commit (send an email, broadcast an event, enqueue a recompute) | **Transactional outbox** |
| Orchestrate **multiple steps** where later steps depend on earlier ones | **Workflow engine** |
| **Roll back** completed work when a later step fails (saga / compensation) | **Workflow engine** |
| **Wait** on a timer or an external signal mid-process | **Workflow engine** |
| Produce a **queryable history** of what happened, step by step | **Workflow engine** |

If you're not sure, you almost certainly want the **outbox** — most async work
in TruePPM is a single fire-and-forget task.

## Transactional outbox — "commit and reliably enqueue one task"

The outbox guarantees at-least-once dispatch of a **single** task. You write an
outbox row in the same transaction as your DB change; a 30-second Beat drain
re-dispatches it if the broker was down at commit time. No work is lost between
the commit and the enqueue.

This is the right tool for the overwhelming majority of async side effects.
Existing usages — and they should **stay** as outbox, there is no reason to
migrate them onto the workflow interface:

- **CPM recalculation** — `scheduling.services.enqueue_recalculate` / `ScheduleRequest`
- **Board events and sync notifications** — broadcast on commit
- **Webhook delivery** — `WebhookDelivery`
- **MS Project import** — `ImportRequest`

```python
# Single task after a commit: outbox. Do NOT reach for a workflow here.
from trueppm_api.apps.scheduling.services import enqueue_recalculate

enqueue_recalculate(project_id)  # writes the row, best-effort dispatches, drain backstops
```

See the [`on_commit` durability audit](on-commit-audit.md) for how deferred
dispatch is wired across the codebase.

## Workflow engine — "orchestrate a multi-step process durably"

The workflow engine (ADR-0080) runs a **multi-step state machine** that holds
state across steps, runs them in order, compensates completed steps in reverse
on failure, can sleep on a durable timer, and records a queryable history. You
author a workflow **declaratively** as an ordered chain of steps:

```python
from trueppm_api.workflows.registry import WorkflowDefinition, WorkflowStep

class ProvisionTeammate(WorkflowDefinition):
    name = "provision_teammate"

    def build_steps(self, workflow_input):
        return [
            WorkflowStep("create_account", create_account, compensate=delete_account),
            WorkflowStep("grant_access", grant_access, compensate=revoke_access),
            WorkflowStep("send_welcome", send_welcome),  # no rollback needed
        ]
```

You drive workflows only through the public service surface — never a backend
class directly:

```python
from trueppm_api.workflows import start_workflow, get_workflow_state

workflow_id = start_workflow("provision_teammate", {"user_id": str(user.id)})
state = get_workflow_state(workflow_id)  # .status, .result, ...
```

The full primitive set is `start_workflow`, `signal_workflow`, `query_workflow`,
`get_workflow_state`, `cancel_workflow`, `sleep`, `run_activity`, and
`get_history`.

### It composes with the outbox

The engine doesn't bypass the outbox — it **builds on** it. The default backend
advances a workflow one step at a time, and each step-advance is written as a
workflow outbox row inside `transaction.on_commit`, re-dispatched by the
`workflows_outbox_drain` Beat task. So a workflow inherits exactly the same
broker-outage durability the single-task outbox gives you, applied across every
step. Activities are once-and-only-once on `(workflow, activity_name, input)`,
so an at-least-once redelivery never runs a side effect twice.

## Backend-neutrality (why workflow code never imports Celery)

Workflow consumer code imports **only** from `trueppm_api.workflows`. It must
never import `celery`, `dbos`, or `temporalio`. The execution model (a
declarative chain over Celery + outbox today) lives entirely behind the
interface, so the backend can change without touching a single workflow:

- **Default (OSS):** Celery + transactional outbox — ships today.
- **DBOS (OSS):** a Postgres-native backend — the natural in-edition durability upgrade.
- **Temporal (Enterprise):** registered against the same interface by the
  enterprise edition; the engine's extension point, not an OSS dependency.

If a workflow ever needed to know which backend it runs on, the abstraction
would have already failed. There is deliberately no `_backend` parameter on any
primitive.

## Decision recap

- **One task, fire-and-forget?** Outbox. Don't overthink it.
- **A process with ordered steps, rollback, waits, or history?** Workflow engine.
- **Already using the outbox for single-shot dispatch?** Leave it — migrating it
  onto the workflow interface buys nothing.
