A sprint close that fails is now retried and can be observed. Previously one
failure was terminal: the close task marked its request FAILED without
re-raising, so the Celery retry budget never fired; re-entry short-circuited on
the FAILED row; and the drain recovered only stalled in-flight rows. A single
unsnapshottable task left the sprint ACTIVE indefinitely behind a dead request,
with no path back except manual database intervention — while two comments in
the source asserted the opposite, that the drain retried.

Failures are now classified. A transient one carries a retry clock and the drain
re-queues it, up to three attempts; a failure nothing can fix — the sprint was
cancelled or is not closable — is terminal immediately and is never retried.

`GET /api/v1/sprints/{id}/close-request/` is new, and reports the outcome of the
most recent close attempt including its error and whether it will be retried.
The close endpoint has always returned `202` with a `request_id` and documented
that clients poll for completion, but no read route existed, so the id addressed
nothing and a failed close surfaced no error anywhere.
