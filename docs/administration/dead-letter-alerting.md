# Dead-letter alerting

When a background Celery task in TruePPM exhausts its retries, the work is
permanently abandoned — a CPM recalculation, a notification email, an MS Project
import, all driven asynchronously. Without a signal, a solo operator has no way to
know that work silently died short of reading the failed-task admin viewset by hand.

Dead-letter alerting closes that gap. Every permanently-failed task records a
durable row, emits a structured alert log line, and is counted on a Prometheus
endpoint you can scrape and alert on. (This is the basic detection layer every
adopter gets; routing alerts to PagerDuty or Slack is an Enterprise extension — see
[Routing alerts off-box](#routing-alerts-off-box-enterprise) below.)

## What happens when a task is dead-lettered

A task is *dead-lettered* when it has exhausted all configured retries and will not
run again. At that point, three things happen exactly once per failed task:

1. **A durable `FailedTask` row** is recorded (status `DEAD`). This is the
   system of record — it survives restarts and is what the metrics endpoint counts.
   It is the same row the failed-task admin viewset reads.
2. **A structured `WARNING` log line** is emitted by the
   `trueppm_api.apps.scheduling.receivers` logger:

   ```
   WARNING dead-letter alert: task scheduling.recalculate_schedule (a1b2c3d4-…) permanently failed: connection timed out
   ```

   The line carries machine-readable `extra` fields for log-based alerting:

   | Field | Meaning |
   |---|---|
   | `task_name` | The registered Celery task name (e.g. `scheduling.recalculate_schedule`) |
   | `task_id` | The Celery task id of the failed run |
   | `exception_type` | The exception class name that caused the final failure |
   | `project_id` | The owning project id, or `null` when the task is not project-scoped |

3. **A `celery_task_permanently_failed` signal** fires, which Enterprise (or your
   own code) can subscribe to for off-box alerting. The OSS receiver only logs —
   see [Routing alerts off-box](#routing-alerts-off-box-enterprise).

The alert fires **once per newly dead-lettered task**: a re-delivered failure for a
task id that is already parked does not re-alert, so you do not get an alert storm
from a single stuck task.

> The alert `WARNING` is deliberately a distinct, lower-severity line from the
> `ERROR` that records the underlying task failure. The `ERROR` records *what
> failed*; the `WARNING` records *that an operator alert was raised*. The alerting
> receiver is exception-safe — a failure inside alerting can never mask or re-raise
> into the dead-letter recording path. See ADR-0084 for the full rationale.

### Alerting on the log line

If you forward worker logs to an aggregator (Loki, CloudWatch, Datadog, an ELK
stack), alert on the `dead-letter alert:` message from the
`trueppm_api.apps.scheduling.receivers` logger. The `extra` fields are emitted as
structured fields, so you can route or group by `task_name` or `project_id` without
parsing the message string. This is the fallback signal for deployments with no
Prometheus.

## The `/api/v1/health/dead-letter/` metrics endpoint

For metrics-based alerting, scrape the Prometheus-text endpoint. It requires a
**staff (admin)** account — it exposes operational state, so it is gated with
`IsAdminUser` and is bearer-scrapeable, mirroring `/api/v1/health/beat/` (see
[Beat liveness and durability](durability.md)).

It emits a single gauge, `trueppm_task_dead_letter_parked`, labelled by task name:

```
# HELP trueppm_task_dead_letter_parked Permanently dead-lettered Celery tasks currently awaiting operator action, by task name.
# TYPE trueppm_task_dead_letter_parked gauge
trueppm_task_dead_letter_parked{task_name="scheduling.recalculate_schedule"} 3
```

```bash
curl -fsS -H "Authorization: Bearer $ADMIN_JWT" \
  https://trueppm.example.com/api/v1/health/dead-letter/
```

The metric is a **gauge, not a counter**: it counts dead-lettered tasks that are
*currently parked* — awaiting operator action. The value **falls** when a parked
task is dismissed, retried, or purged. A value of `0` (or the series disappearing
for a given `task_name`) means nothing is currently dead-lettered for that task.

> The gauge is derived from the `FailedTask` table on each scrape
> (`COUNT(*) … GROUP BY task_name … WHERE status = DEAD`), not from an in-memory
> counter. This is correct by construction across processes: the Celery **worker**
> records the dead-letter, and the **web** process serves the scrape — a counter
> held in worker memory would be invisible to the scraper. Reading committed
> `FailedTask` rows means the web process sees exactly what the worker recorded.

### Wiring it into Prometheus

The endpoint is **authenticated**, so it is not a drop-in unauthenticated scrape
target. Configure the scrape job with a bearer token:

```yaml
scrape_configs:
  - job_name: trueppm-dead-letter
    metrics_path: /api/v1/health/dead-letter/
    scheme: https
    authorization:
      type: Bearer
      credentials: <admin-jwt>      # or credentials_file: /etc/prometheus/trueppm-token
    static_configs:
      - targets: ["trueppm.example.com"]
```

A useful alert rule fires when anything is parked:

```yaml
groups:
  - name: trueppm-dead-letter
    rules:
      - alert: TruePPMTaskDeadLettered
        expr: sum(trueppm_task_dead_letter_parked) > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "TruePPM has permanently-failed background tasks awaiting action"
```

Because the metric is a gauge of *currently parked* work, the alert clears
automatically once the parked tasks are retried, dismissed, or purged — no manual
alert reset.

## Routing alerts off-box (Enterprise)

The OSS edition only **logs** the alert and **counts** it on the metrics endpoint.
It never calls out to PagerDuty, Slack, or any external pager — that is an
Enterprise capability.

The integration point is the `celery_task_permanently_failed` Django signal in
`scheduling/signals.py`. Enterprise (or your own custom app) registers an
**additional** receiver against it from its own `AppConfig.ready()` — the OSS
log-only receiver stays in place and the two run side by side:

```python
# In an enterprise / custom app's apps.py
from django.apps import AppConfig


class AlertingConfig(AppConfig):
    name = "trueppm_enterprise.alerting"

    def ready(self) -> None:
        # Importing scheduling.signals gives the stable extension contract;
        # connecting a new receiver does not modify or replace the OSS one.
        from trueppm_api.apps.scheduling import signals

        @signals.celery_task_permanently_failed.connect
        def page_on_dead_letter(sender, *, task_name, task_id, exception, project_id, **kwargs):
            pagerduty.trigger(
                summary=f"TruePPM task {task_name} permanently failed",
                dedup_key=task_id,
                custom_details={
                    "exception": type(exception).__name__,
                    "project_id": project_id,
                },
            )
```

The signal payload carries `task_id`, `task_name`, `exception`, `traceback_str`,
and `project_id` (`None` when the task is not project-scoped).

> **The OSS core never imports `trueppm_enterprise`.** The dependency is one-way:
> Enterprise registers against the OSS signal, never the reverse. The signal's
> shape is a stable extension contract — OSS does not change it without treating it
> as a breaking change for Enterprise. See ADR-0084.

## Related

- [Beat liveness and durability](durability.md) — the sibling `/api/v1/health/beat/`
  detector for a dead Celery Beat process.
- [Outbox and record retention](retention.md) — `FailedTask` retention is governed
  by the retention purge; parked dead-letters are reaped along with other terminal
  records.
