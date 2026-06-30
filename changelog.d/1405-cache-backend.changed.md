- **Default cache backend is now Redis/Valkey (db 2):** the application cache, which
  previously fell back to per-process local memory, is now backed by the same
  Redis/Valkey instance already required for Channels and Celery (database 2; db 0 =
  Celery, db 1 = the channel layer). This is required for the new SSO login state and
  the API rate-limit throttles to be consistent across multiple worker processes.
  Self-hosted deployments already running Redis/Valkey need no action; the local dev
  and test settings continue to use in-memory caching and require no separate cache
  service.
