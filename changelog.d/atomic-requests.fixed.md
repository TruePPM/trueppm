Enable `ATOMIC_REQUESTS` so `transaction.on_commit()` defers Celery and broadcast callbacks to post-commit, preventing broker failures from returning HTTP 500 on task mutations.
