**Docker Compose production hardening.** No compose file set a log-rotation
policy anywhere: Django emits single-line JSON per request in production, plus a
Celery worker and beat at `--loglevel=info`, against Docker's uncapped
`json-file` driver — a guaranteed disk-full incident on a long-running install,
which takes PostgreSQL down with it. Every service in the production and demo
stacks now caps at 10 MB x 5.

**`client_max_body_size` is 110M everywhere**, not 50M. `MAX_ATTACHMENT_SIZE_BYTES`
and `DATA_UPLOAD_MAX_MEMORY_SIZE` are both 100 MB, and that setting's own comment
tells operators to configure nginx to match — but all three edge configs capped
at 50M, so every attachment between 50 and 100 MB got a bare nginx 413 on every
deployment path. The baked web image set nothing at all and inherited nginx's
1 MB default.

**The dev stack no longer publishes PostgreSQL on `0.0.0.0`** with its hardcoded
password (Docker's published ports bypass most host firewalls), and the docs no
longer recommend that stack for "small teams". **Production Valkey is persistent
and bounded** — it was an unsized `tmpfs`, so every restart wiped the broker,
channel layer, cache, and throttle counters, and the dev stack was the one with
a durable volume. **Production services now have resource limits** (the demo
stack limited everything and production limited nothing) and **nginx, celery,
and celery-beat have healthchecks** — `restart: unless-stopped` only fires on
process exit, so a wedged nginx or a stopped beat reported `Up` forever.

**`init-prod.sh` no longer `source`s `.env`.** A documented `.env.example` line
(`CSP_CONNECT_SRC='self' wss:`) made bash execute `wss:` and exit 127, and a
password containing `$(...)` or a backtick would have been *executed*. It now
parses key-value pairs and evaluates nothing.

Also: the production compose file pins its project name (volume and container
names were directory-dependent while the docs hardcode them), documents that the
first run through `init-prod.sh` is mandatory, and gitignores the template that
run generates. `/admin/`'s `allow 127.0.0.1` could never match — nginx tests
`$remote_addr`, which for a request through a published port is the Docker
bridge gateway — so the documented SSH-tunnel procedure returned 403; the rule
now fails closed explicitly and the working procedure is documented. `APP_VERSION`
is documented as needing a pin, the observability overlay binds to loopback, and
`docker compose down -v` finally carries a warning. Closes #3189.
