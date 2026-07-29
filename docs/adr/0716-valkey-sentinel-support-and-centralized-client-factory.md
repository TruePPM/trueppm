# ADR-0716: Valkey Sentinel support and a centralized client factory

## Status
Accepted — Sentinel support ships **experimental** in 0.4 (see Consequences → Risks)

## Context

Every Valkey role in the API is derived from one environment variable by string
concatenation (`settings/base.py`):

```python
REDIS_URL = env("REDIS_URL", default="redis://redis:6379")
CACHES["default"]["LOCATION"]              = f"{REDIS_URL}/2"
CHANNEL_LAYERS["default"]["CONFIG"]["hosts"] = [f"{REDIS_URL}/1"]
CELERY_BROKER_URL = CELERY_RESULT_BACKEND    = f"{REDIS_URL}/0"
```

That shape makes both self-managed HA topologies we recommend to operators
impossible to configure, for reasons that differ per consumer:

- **Sentinel.** Django's built-in `django.core.cache.backends.redis.RedisCache`
  has no Sentinel support at all. `channels-redis` accepts Sentinel *only* as a
  dict host — `{"sentinels": [(host, port), …], "master_name": …}` — which a URL
  can never carry. Celery accepts a `sentinel://` URL but only in combination
  with `broker_transport_options={"master_name": …}`, which settings never set.
  Three consumers, three unrelated reasons, one shared outcome: an operator who
  follows our documented Sentinel guidance gets a deploy that does not start or
  silently talks to a replica.
- **Cluster.** A clustered endpoint exposes only database `0`, so the `/1`, `/2`,
  and `/3` suffixes are invalid against it. `channels-redis` has no cluster
  support in any case.

### The problem is larger than the three settings entries

Issue #2554 frames this as three roles. It is actually **four logical databases
and eleven client construction sites**. Beyond the three settings entries, the
codebase builds raw `redis-py` clients directly from `settings.REDIS_URL`:

| Site | DB | Client |
|---|---|---|
| `apps/sync/ws_auth.py` (issue / consume WS ticket) | 0 | sync + asyncio |
| `apps/sync/consumers.py` | 0 | asyncio |
| `apps/taskruns/views.py`, `apps/taskruns/tracker.py` | 0 | sync |
| `apps/projects/views.py` | 0 | sync |
| `core/idempotent.py` | 0 | sync |
| `apps/sync/throttles.py` | 2 | sync |
| `apps/projects/throttles.py` | 2 | sync |
| `apps/workshops/consumers.py` | 2 | sync |
| `apps/observability/otel/export_health.py` | 2 | sync |
| `apps/notifications/throttles.py` | **3** | sync |

Database `3` is a fourth index that no prior document records. Each of these
sites is as unreachable under Sentinel as the three headline consumers. Fixing
only the settings entries would produce the **worst** outcome available: an
operator configures Sentinel, believes they have HA, and then loses WebSocket
ticket authentication, every throttle counter, task-run tracking, and OTLP
export health the first time the primary fails over — silently, because all
these sites fail open by design.

**P3M layer:** none — this is deployment infrastructure beneath every layer.

## Decision

### 1. Config surface: a Sentinel *block*, not per-role URLs

`REDIS_URL` stays exactly as it is and remains the default that derives all four
databases. A deploy that sets nothing new behaves byte-for-byte as before.

Sentinel is enabled by one new variable and configured by four more:

| Variable | Meaning |
|---|---|
| `TRUEPPM_VALKEY_SENTINELS` | Comma-separated `host:port` list. **Non-empty enables Sentinel mode.** |
| `TRUEPPM_VALKEY_MASTER_NAME` | Sentinel monitor name. Required in Sentinel mode. |
| `TRUEPPM_VALKEY_PASSWORD` | Password for the data nodes (primary/replicas). |
| `TRUEPPM_VALKEY_SENTINEL_PASSWORD` | Password for the Sentinel nodes themselves, when it differs. |
| `TRUEPPM_VALKEY_USE_TLS` | Use TLS to the data nodes. |

We **reject** the per-role URL override surface proposed as step 1 of the issue
(`TRUEPPM_CACHE_URL` / `_CHANNELS_URL` / `_BROKER_URL`). It multiplies the
configuration matrix by four and does not actually deliver Sentinel to anything,
because the blocking constraint is that `channels-redis` and the Django cache
cannot express Sentinel *as a URL at all*. It would be surface area without
capability. Sentinel-mode-as-a-block subsumes the requirement, and "fewer moving
parts" is the tiebreaker in the decision framework.

### 2. No `django-redis` — a ~30-line cache backend subclass instead

ADR-0065 and ADR-0068 both explicitly declined to add `django-redis`, and
`apps/projects/throttles.py` carries that rationale in its module docstring
("so the API doesn't take on a new top-level dependency"). The obvious reading is
that Sentinel forces us to reverse it. It does not.

Django's `RedisCache.__init__` assigns `self._class = RedisCacheClient` and
builds the client lazily in a `_cache` cached property. Overriding a single
attribute is enough:

```python
class SentinelRedisCache(RedisCache):
    def __init__(self, server, params):
        super().__init__(server, params)
        self._class = _SentinelCacheClient
```

`_SentinelCacheClient` subclasses Django's `RedisCacheClient` and overrides only
`_get_connection_pool`, returning a pool from `Sentinel(...).master_for(...)`.
Everything else — serialization, timeout semantics, every cache operation — is
inherited unchanged.

This **upholds** the existing precedent rather than reversing it, keeps the
dependency count flat, and keeps the failover path in code we own and test. It
is selected *only* in Sentinel mode; single-endpoint deploys continue to use
Django's stock `RedisCache` on exactly the path they use today.

### 3. One factory: `trueppm_api/core/valkey.py`

A single module becomes the only place a Valkey client is constructed:

```python
sentinel_mode() -> bool
pool(db: int) -> redis.ConnectionPool          # pooled, cached per db
client(db: int) -> redis.Redis                 # sync
async_client(db: int) -> redis.asyncio.Redis   # asyncio
url_for(db: int) -> str                        # single-endpoint mode only
```

In single-endpoint mode it returns exactly what the call sites build today. In
Sentinel mode it returns `Sentinel(...).master_for(master_name, db=db)`, which
re-resolves the current primary on connection — this is what makes failover
transparent with no restart.

All eleven raw sites migrate to it. **This is in scope for this change, not a
follow-up.** A partial migration would ship the failure mode described in the
Context: an operator with a green deploy and a silent, fail-open HA hole. The
acceptance criterion "failover is transparent to all three consumers" is not
truthfully satisfiable while eleven clients still pin a single host.

Named database-index constants replace the magic numbers, including the
previously undocumented `3`:

```python
DB_CELERY = 0; DB_CHANNELS = 1; DB_CACHE = 2; DB_NOTIFICATIONS = 3
```

### 4. Cluster mode is explicitly out of scope

Cluster is **not supported and will not be**, on the current architecture. Two
independent blockers: a clustered endpoint exposes only database `0`, and we use
four; and `channels-redis` has no cluster support whatsoever. Supporting it would
mean collapsing four logical databases onto one keyspace behind key prefixes
*and* replacing the channel layer — far outside this issue. Documented as
unsupported, with the reason, rather than left ambiguous.

### 5. Fail-fast via Django system checks

Misconfiguration surfaces at `manage.py check` / startup, not on first cache
write, through checks registered in `core/checks.py`:

- **`trueppm.valkey.E001`** — `TRUEPPM_VALKEY_SENTINELS` set without
  `TRUEPPM_VALKEY_MASTER_NAME`.
- **`trueppm.valkey.E002`** — a sentinel entry that is not parseable as
  `host:port`.
- **`trueppm.valkey.W001`** — `REDIS_URL` set to a non-default value *and*
  Sentinel mode enabled: `REDIS_URL` is ignored, which is worth saying out loud.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Sentinel block + central factory + cache subclass (chosen)** | All four DBs and all 11 sites failover-transparent; no new dependency; single construction point; non-breaking | Touches many files; we own the cache client subclass against Django internals |
| Add `django-redis`, fix only the 3 settings entries | Smallest diff; well-trodden library | Reverses ADR-0065/0068 for no gain; leaves 11 sites pinned to one host — ships a *silent* HA hole, the worst outcome available |
| Per-role URL overrides (issue's step 1) | Flexible-looking; matches the issue text | Does not deliver Sentinel: channels-redis and Django cache cannot express it as a URL. 4× config matrix, zero new capability |
| Support Cluster too | Closes the topology gap completely | Requires collapsing 4 DBs to 1 keyspace and replacing `channels-redis`; disproportionate |
| Document Sentinel as unsupported, ship nothing | Zero risk | Leaves the only two self-managed HA paths dead; #2554 unresolved |

## Consequences

**Easier**

- An operator can run Valkey Sentinel and have *every* consumer — cache,
  channels, Celery, WS ticket auth, all throttles, task-run tracking, OTLP export
  health — follow the primary across a failover without a restart.
- The fourth database index (`3`) and the whole role/DB map are now declared in
  one module instead of being rediscoverable only by grep.
- Any future Valkey topology work has exactly one integration point.

**Harder**

- `_SentinelCacheClient` couples to two private Django names
  (`RedisCacheClient`, `_get_connection_pool`). A Django upgrade could move them.
  Mitigated by a test that asserts the subclass still binds to the real Django
  base and exercises a cache round-trip.
- Contributors must use `core.valkey` rather than `redis.from_url`. Enforced by a
  regression test that greps the source tree for new `from_url(settings.REDIS_URL`
  occurrences.

**Risks**

- Sentinel mode has no coverage in the bundled dev stack (single-node Valkey), so
  it is exercised by unit tests against a faked `Sentinel`, not end to end. The
  docs are explicit that operators should test failover in staging.
- Fail-open behavior in the throttles is preserved deliberately: a Valkey outage
  must not become an application outage. This means a Sentinel misconfiguration
  degrades throttling silently at runtime — which is precisely why the
  configuration errors are system checks that refuse to start.

## Implementation Notes

- P3M layer: **N/A** — deployment infrastructure, beneath all four layers
- Affected packages: `api`, `helm`, `website` (docs)
- Migration required: **no** — no model change
- API changes: **no** — no endpoint, serializer, or permission change
- OSS or Enterprise: **OSS**. Running your own datastore topology is core
  self-hosting, not org governance

### Durable Execution

1. **Broker-down behaviour:** Unchanged, and improved in Sentinel mode. This ADR
   adds no dispatch path. Celery's broker becomes `sentinel://` with
   `broker_transport_options={"master_name": …}`, so a primary failover is a
   reconnect rather than a hard broker outage. The ADR-0027 transactional outbox
   remains the durability mechanism for every existing dispatch site.
2. **Drain task:** None added. No new category of async work — this changes how
   existing clients connect, not what work is enqueued.
3. **Orphan window:** N/A — no outbox rows are written by this change.
4. **Service layer:** N/A for dispatch. The analogous concentration point this
   ADR *does* introduce is `core/valkey.py`, which every Valkey client must go
   through, mirroring the `services.py` convention.
5. **API response on best-effort dispatch:** N/A — no endpoint added or changed.
6. **Outbox cleanup:** N/A — no new outbox rows.
7. **Idempotency:** N/A for tasks. Client construction is idempotent by
   construction: pools are cached per database index and the cache is reset by
   `reset_pools()`, used by tests that rebind `REDIS_URL`.
8. **Dead-letter / failure handling:** Unchanged. Every migrated site keeps its
   existing failure posture — throttles and export health fail **open** (a Valkey
   outage must not become a DoS surface), WS ticket consume fails **closed** (a
   ticket that cannot be verified is not honored). Configuration errors fail at
   startup via system checks rather than at first use.
