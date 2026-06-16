# ADR-0141: Short-lived ticket for the WebSocket handshake

## Status
Accepted

## Context
Both real-time consumers — `ProjectConsumer` (`apps/sync/consumers.py`) and
`WorkshopConsumer` (`apps/workshops/consumers.py`, ADR-0046) — authenticate the
WebSocket upgrade by reading the JWT **access token** from the URL query string
(`?token=<jwt>`). Browsers cannot attach an `Authorization` header to the initial
WebSocket handshake, so the token had to travel somewhere the browser *can* set —
the URL.

Full request URLs are routinely logged: NGINX `access_log`, GCP/AWS load
balancers, ingress controllers, browser history, and any HAR capture. A leaked
access log therefore leaks a window of valid JWTs. The 15-minute
`ACCESS_TOKEN_LIFETIME` (`settings/base.py`) is a partial mitigation, but for a
self-hosted cluster where ops logs are retained for weeks it is not a defense.

The standard fix (RFC 6750 §2.3) is a short-lived, single-use **ticket**: the
client asks an authenticated REST endpoint for a ticket, then exchanges it on the
upgrade. A ticket that appears in a log is already spent or expired by the time
anyone reads the log.

P3M layer: Programs and Projects (OSS) — real-time collaboration on a single
project board. No cross-program/portfolio scope.

## Decision
1. **`POST /api/v1/ws/ticket/`** (`IsAuthenticated`) returns
   `{"ticket": "<opaque>", "expires_in": 30}`. The ticket is a
   `secrets.token_urlsafe(32)` value stored in Redis at
   `ws:ticket:<ticket>` → the requesting user's id, with a 30-second TTL.
2. **Consumers accept `?ticket=<id>`**: the ticket is consumed with an atomic
   `GETDEL` (single-use; Valkey/Redis ≥ 6.2) and resolved to the user. The
   ticket carries **authentication only** — each consumer still runs its own
   membership/role **authorization** gate after resolving the user, exactly as
   before.
3. **`?token=<jwt>` keeps working for one release** as a deprecated fallback. A
   connection authenticated via the legacy token path is annotated and logged
   with a deprecation warning so operators can spot stragglers before the path is
   removed.
4. **Frontend** (`useProjectWebSocket.ts`, `useWorkshopSocket.ts`) fetches a
   ticket via REST immediately before each `new WebSocket(...)` (including every
   reconnect, since tickets are single-use) and connects with `?ticket=`.

Ticket storage uses **raw Redis against `settings.REDIS_URL`** — the sync DRF
view writes with a synchronous `redis` client, the async consumer reads with
`redis.asyncio`. Django's cache framework is *not* used: no `CACHES` backend is
configured, so the default `LocMemCache` is per-process and invisible to the
Channels worker. Both sides share one helper module, `apps/sync/ws_auth.py`.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| Short-lived Redis ticket (chosen) | Logged value is useless (single-use, 30 s); no new deps; same Redis | Extra REST round-trip before connect |
| Keep `?token=` only | No work | The vulnerability the audit filed (#818) |
| `Sec-WebSocket-Protocol` subprotocol carries the JWT | No URL exposure | Still a long-lived JWT in a header some proxies log; awkward client API; JWT still reusable if leaked |
| Cookie-based session for WS | Browser sends it automatically | TruePPM is JWT/stateless; cookies reintroduce CSRF surface and don't suit mobile/API clients |

## Consequences
- **Easier**: leaked access logs no longer expose reusable credentials; the WS
  auth surface is now one shared, tested helper instead of two copy-pasted
  `_authenticate` methods.
- **Harder**: clients must fetch a ticket before connecting; a clock/TTL that is
  too tight could fail slow networks (30 s is generous for a single REST call).
- **Risks**: Redis must be reachable for new tickets (it already must be, for the
  channel layer and presence). The legacy `?token=` path stays for one release —
  the deprecation log is the signal to remove it.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api (sync, workshops), web
- Migration required: no (Redis-only state)
- API changes: yes — new `POST /api/v1/ws/ticket/`; consumers accept `?ticket=`
- OSS or Enterprise: OSS

### Durable Execution
1. Broker-down behaviour: N/A — a ticket is ephemeral 30 s state. If Redis is
   down the ticket POST fails (503-ish) and the client cannot connect, which is
   the same availability dependency the channel layer already has. Nothing
   durable is written, so there is no commit/dispatch gap.
2. Drain task: N/A — no async work is dispatched. Expiry is handled by Redis TTL.
3. Orphan window: N/A — no outbox rows.
4. Service layer: `apps/sync/ws_auth.py::issue_ticket()` / `consume_ticket()`.
5. API response on best-effort dispatch: synchronous — the POST returns the
   ticket inline; there is no queued work.
6. Outbox cleanup: N/A — Redis TTL (30 s) reaps unused tickets; `GETDEL` reaps
   used ones immediately.
7. Idempotency: tickets are single-use by construction (`GETDEL` is atomic, so a
   replayed ticket resolves to `None` on the second attempt). Issuing is
   naturally idempotent in effect — each POST mints an independent ticket.
8. Dead-letter / failure handling: N/A — a failed consume simply closes the
   socket (code 4001) and the client requests a fresh ticket and retries.
