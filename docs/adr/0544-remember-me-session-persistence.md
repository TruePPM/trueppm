# ADR-0544: Remember-me session persistence for cookie-JWT auth

## Status
Proposed

## Context
The login form has shipped a "Keep me signed in for 30 days" checkbox (`LoginPage.tsx`)
that already sends `remember_me` in the login body, but the backend never reads it
(#2246). Three confirmed defects follow:

1. **`remember_me` is ignored server-side.** `CookieTokenObtainPairView.post`
   (`core/auth_views.py`) discards it; the refresh cookie is always set with
   `max_age = REFRESH_TOKEN_LIFETIME = timedelta(days=7)` unconditionally
   (`_set_refresh_cookie`, `settings/base.py:576`).
2. **No session-only login exists.** Even with the box unchecked, every login gets a
   persistent 7-day cookie, so "don't remember me" on a shared machine is silently
   ignored — the credential survives browser close.
3. **The "30 days" copy is false** — the real lifetime is 7 days.

The auth model is pure cookie-JWT (#897, recorded in ADR-0187, carried forward by
ADR-0517): login returns a 15-min access token in the JSON body (held in memory in the
Zustand store) and sets the refresh token as an `httpOnly`/`Secure`/`SameSite=Strict`
cookie path-scoped to `/api/v1/auth/token/refresh/`. `ROTATE_REFRESH_TOKENS=True` and
`BLACKLIST_AFTER_ROTATION=True`, so every refresh mints a new refresh token and
blacklists the old one. On reload the SPA re-bootstraps its access token from the
refresh cookie.

Two forces make this subtle:

- **simplejwt bakes `exp` at mint time.** Confirmed in the installed source:
  `token.set_exp(lifetime=td)` overrides the class default, and a fresh
  `RefreshToken(encoded)` decode honors the baked `exp` regardless of the current
  `REFRESH_TOKEN_LIFETIME` setting. So a custom lifetime is a `set_exp` call, not a
  cookie `max_age` change — the cookie only controls browser *persistence*; the JWT
  `exp` is the real credential bound.
- **Rotation has no `remember_me`.** The refresh endpoint reads only the cookie, and
  the current rotation does a bare `refresh.set_exp()` — which resets `exp` to the
  7-day class default, losing any custom lifetime. The persistent-vs-session choice
  must therefore be carried *inside the token* and re-applied on every rotation.

P3M layer: Programs and Projects (authentication is cross-cutting infrastructure, OSS).
Basic auth is squarely OSS per the auth carve-out — this is login-session behavior, not
org identity governance.

## Decision

### 1. Lifetime mapping (concrete values)

| State | Refresh JWT `exp` | Cookie | Rationale |
|-------|-------------------|--------|-----------|
| `remember_me = true` | **30 days** | **persistent**, `Max-Age = 30d` | Matches the copy; a deliberate opt-in to a long-lived credential on a trusted device. |
| `remember_me = false` (default) | **12 hours** (sliding via rotation) | **session cookie** (`max_age=None` → dies on browser close) | Primary boundary is browser-close; the 12h JWT `exp` is a secondary *idle* timeout for a machine left open. |

**Idle-timeout mechanics for the session case** (worked through, since the issue asks):
while the browser stays open, active use refreshes the access token at least every 15
min, and each refresh *rotates* the refresh token. Rotation re-mints `exp` from the same
lifetime implied by the token (see §3), so the 12h window **slides** forward on every
refresh — an active user is never interrupted. The 12h `exp` only bites after 12h of
*inactivity with the browser still open* (walked-away case), forcing re-auth. Browser
close is handled independently by the session cookie. This is the standard sliding
session; it is acceptable — and correct — for the not-remembered case because
browser-close is the real shared-machine protection and 12h bounds the idle-open risk.

We deliberately do **not** use an absolute (non-sliding) session timeout: forcing a
re-login mid-workday for an actively-working user who simply didn't check the box is
hostile, and the sliding window still fully protects the shared-machine scenario.

### 2. Exact backend call sequence for custom-lifetime tokens

The persistent-vs-session choice is carried as a **custom `remember` boolean claim on
the refresh token** — confirmed to survive encode/decode and to be inherited
automatically across rotation (rotation re-signs the same payload; `set_jti/set_exp/
set_iat` never touch a custom claim). This makes the token self-describing, so the
stateless rotation endpoint needs no `remember_me` in its request and no server-side
store.

One security-critical subtlety: `RefreshToken.for_user(user)` writes an
`OutstandingToken` row whose `expires_at` is taken from the token's `exp` **at that
moment** — i.e. the 7-day class default, *before* we override to 30 days. `expires_at`
drives the nightly `flushexpiredtokens` cleanup, and `BlacklistedToken` cascades on
`OutstandingToken` delete. If left at 7 days for a 30-day token, a rotated/stolen token
that was blacklisted at day 2 would have its blacklist entry flushed at day 7 while the
JWT stays valid to day 30 → **replayable between day 7 and day 30**. The mint helper
therefore syncs `expires_at` to the real `exp`.

Single shared helper, used by both mint sites and the rotation path:

```python
from rest_framework_simplejwt.settings import api_settings
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken
from rest_framework_simplejwt.utils import datetime_from_epoch

def _apply_remember(refresh: RefreshToken, *, remember: bool) -> None:
    """Stamp the remember claim + custom exp on a refresh token and keep the
    OutstandingToken bookkeeping row's expires_at in sync with the real exp so a
    blacklisted long-lived token's revocation entry is not flushed early."""
    lifetime = (
        settings.REFRESH_TOKEN_REMEMBER_LIFETIME
        if remember
        else settings.REFRESH_TOKEN_SESSION_LIFETIME
    )
    refresh["remember"] = remember
    refresh.set_exp(lifetime=lifetime)
    # No-op (0 rows) when no OutstandingToken exists for this jti — e.g. a rotated
    # token whose new jti has no row yet; the row is created lazily at blacklist time
    # with the correct payload exp, so the sync is only load-bearing at the for_user
    # mint sites (login, SSO).
    OutstandingToken.objects.filter(jti=refresh[api_settings.JTI_CLAIM]).update(
        expires_at=datetime_from_epoch(refresh["exp"]),
    )
```

**Login** (`CookieTokenObtainPairView.post`) — reuse the serializer's already-minted
token (avoids a duplicate OutstandingToken row), stamp it, and set a matching cookie:

```python
remember = bool(request.data.get("remember_me", False)) if isinstance(request.data, dict) else False
data = dict(serializer.validated_data)
refresh_str = data.pop("refresh", None)          # access stays as the serializer minted it
response = Response(data, status=status.HTTP_200_OK)
if refresh_str:
    refresh = RefreshToken(refresh_str)          # same jti the serializer's for_user wrote
    _apply_remember(refresh, remember=remember)
    _set_refresh_cookie(response, str(refresh), persistent_seconds=_cookie_seconds(remember))
return response
```

The 15-min access token does not need the `remember` claim (nothing reads it; it is
copied onto the access token harmlessly, but its own `exp` stays 15 min). Keeping the
serializer's access token untouched is fine.

**SSO callback** (`apps/sso/views.py:256`) — mints via `RefreshToken.for_user(user)`.
There is no checkbox in an IdP redirect, so SSO logins are **always session-scoped**
(`remember=False`): the operator's IdP owns "remember this device," and defaulting an
unattended redirect to a 30-day persistent cookie would be the wrong safe default.

```python
refresh = RefreshToken.for_user(user)
_apply_remember(refresh, remember=False)
_set_refresh_cookie(response, str(refresh), persistent_seconds=None)
```

### 3. How the flag survives rotation

`CookieTokenRefreshView.post` reads the `remember` claim off the decoded incoming token
and re-applies both the lifetime and the cookie persistence. A missing claim is the
back-compat signal (see §6):

```python
claim = refresh.payload.get("remember")
if claim is None:
    # Legacy token minted before #2246 — preserve today's behavior exactly:
    # persistent 7-day cookie, 7-day exp, no claim added. Nobody is logged out or
    # silently converted to a session cookie; they adopt the new model at next login.
    refresh.set_exp(lifetime=settings.REFRESH_TOKEN_LIFETIME)   # 7d
    persistent_seconds = int(settings.REFRESH_TOKEN_LIFETIME.total_seconds())
else:
    remember = bool(claim)
    _apply_remember(refresh, remember=remember)                # re-slides 30d or 12h
    persistent_seconds = _cookie_seconds(remember)
# ... existing blacklist + set_jti/set_iat rotation, then:
_set_refresh_cookie(response, str(refresh), persistent_seconds=persistent_seconds)
```

`_cookie_seconds(remember)` returns `int(REFRESH_TOKEN_REMEMBER_LIFETIME.total_seconds())`
for remember, else `None` (session cookie).

### 4. `_set_refresh_cookie` gains a persistence parameter

```python
def _set_refresh_cookie(response, refresh_token, *, persistent_seconds: int | None) -> None:
    response.set_cookie(
        key=settings.AUTH_REFRESH_COOKIE_NAME,
        value=refresh_token,
        max_age=persistent_seconds,   # None → Django omits Max-Age/Expires → session cookie
        httponly=True,
        secure=settings.AUTH_REFRESH_COOKIE_SECURE,
        samesite=settings.AUTH_REFRESH_COOKIE_SAMESITE,
        path=settings.AUTH_REFRESH_COOKIE_PATH,
    )
```

Passing `max_age=None` to Django's `set_cookie` emits no `Max-Age`/`Expires` → a session
cookie. `_clear_refresh_cookie` is unchanged (path/samesite match is all `delete_cookie`
needs).

### 5. Default checkbox state
**Unchecked** (session-only) — the security-correct default. The safe behavior (dies on
browser close, 12h idle bound) is the default; the long-lived 30-day persistent
credential is an explicit opt-in. This already matches the shipped FE default
(`useState(false)`), so no FE default change is required.

### 6. New settings

```python
# TruePPM-specific refresh-session lifetimes (module-level, alongside AUTH_REFRESH_COOKIE_*).
# REFRESH_TOKEN_LIFETIME (in SIMPLE_JWT) stays 7d — it is now the LEGACY/back-compat
# default used only by rotation of pre-#2246 tokens and by for_user's initial mint.
REFRESH_TOKEN_REMEMBER_LIFETIME = timedelta(
    days=env.int("TRUEPPM_REFRESH_TOKEN_REMEMBER_DAYS", default=30)
)
REFRESH_TOKEN_SESSION_LIFETIME = timedelta(
    hours=env.int("TRUEPPM_REFRESH_TOKEN_SESSION_HOURS", default=12)
)
```

Env-overridable per the `TRUEPPM_` convention (mirrors `AUTH_REFRESH_COOKIE_*`) so
operators can tune both windows.

### 7. Frontend spec
The FE already sends `remember_me` and already labels the box "Keep me signed in for 30
days" — which becomes **accurate** once the backend honors it. Required FE change:
**none** (the flag wiring and default are correct). Recommended (minimal) polish:

- **Label (keep):** `Keep me signed in for 30 days` — now true when checked; the label
  describes what checking does.
- **Optional muted helper** under the checkbox (`text-xs text-neutral-text-secondary`):
  `Leave off on shared devices — you'll be signed out when you close your browser.`
  Makes the session-default behavior explicit for the shared-machine case. This is the
  only net-new copy; everything else is unchanged.
- Default: unchecked (unchanged).

No new component, no layout change, no interaction change — one checkbox on an existing
form. The existing vitest/e2e assertions on the label text and on `remember_me: false`
default continue to pass.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Carry `remember` as a token claim (chosen)** | Stateless; survives rotation with no store; self-describing; one helper for all sites | Claim also copied to access token (benign); needs OutstandingToken `expires_at` sync |
| Server-side per-session store of the remember flag (DB row keyed by jti) | Explicit; queryable | New table + write on every rotation; couples refresh to a DB read; more moving parts for a boolean |
| Infer persistence from the incoming cookie's own `Max-Age`/expiry | No claim, no store | The server cannot read a request cookie's `Max-Age` (browsers send only name=value); impossible |
| Session case = 12h **absolute** (non-sliding) timeout | Hard upper bound per login | Interrupts an actively-working user mid-day; worse UX with no real added safety over sliding + browser-close |
| Only fix the cookie `max_age`, leave `exp` at 7d | One-line change | JWT `exp` still 7d, so a "session" token is valid 7d if the cookie is exfiltrated; the credential bound is unchanged — cosmetic only |

## Consequences
- **Easier:** "Remember me" and session-only login both work correctly; the copy is
  honest; operators get two tunable windows.
- **Easier:** rotation logic becomes uniform — one claim drives both lifetime and cookie
  persistence at every mint/rotate site.
- **Harder / risks:**
  - A 30-day persistent `httpOnly` cookie is a longer-lived credential than 7 days.
    Mitigated by the existing controls (rotate-and-blacklist, `httpOnly`/`Secure`/
    `SameSite=Strict`, path-scoping) and by it being an explicit user opt-in — the
    standard remember-me tradeoff.
  - The `OutstandingToken.expires_at` sync is **security-load-bearing** for the 30-day
    case (prevents early blacklist-entry flush). It must ship with an explicit test.
  - `remember` is copied onto the access token by simplejwt (not in `no_copy_claims`).
    Harmless (nothing reads it, its own `exp` is unchanged); documented so a future
    reader doesn't treat it as meaningful there.
- **Out of scope:** mobile auth (uses its own token flow, not this web cookie);
  configurable per-workspace session policy (an org-governance concern → Enterprise, not
  this OSS change).

## Implementation Notes
- P3M layer: Programs and Projects (cross-cutting auth infra).
- Affected packages: `api` (`core/auth_views.py`, `apps/sso/views.py`, `settings/base.py`),
  `web` (optional one-line helper copy in `LoginPage.tsx`).
- Migration required: **no** (no model changes; `OutstandingToken` is an existing
  simplejwt table, updated via a data write, not a schema change).
- API changes: **behavioral only** — the login request already accepts `remember_me`
  (already in the OpenAPI request via `TokenObtainPairSerializer` free-form body); the
  response shape (`access` only) is unchanged. No schema regeneration needed for the
  response. If `remember_me` should appear as a typed, documented request field, extend
  the login request serializer — otherwise it remains an accepted extra body key as
  today.
- OSS or Enterprise: **OSS** (basic auth session behavior; auth carve-out).

### Durable Execution
1. **Broker-down behaviour:** N/A — login, refresh, and logout are fully synchronous
   request/response paths with no queued side effects. The only async work is the
   pre-existing nightly `flushexpiredtokens` cleanup (Beat), which this ADR does not add.
2. **Drain task:** N/A — no new async dispatch category.
3. **Orphan window:** N/A — no outbox rows.
4. **Service layer:** N/A — no async service. The synchronous token stamping is a private
   helper (`_apply_remember`) in `core/auth_views.py`, imported by the SSO view.
5. **API response on best-effort dispatch:** N/A — login returns the access token
   synchronously (200); no `{"queued": true}` path.
6. **Outbox cleanup:** N/A. The related bookkeeping cleanup is the existing nightly
   `flushexpiredtokens` (deletes `OutstandingToken` rows past `expires_at`, cascading to
   `BlacklistedToken`); this ADR's `expires_at` sync keeps that cleanup honoring the true
   token lifetime (its retention is the token's own `exp`, 12h–30d).
7. **Idempotency:** Login and refresh are naturally safe to repeat (each mints a fresh
   token). Rotation blacklists the incoming token via `get_or_create` (idempotent on
   replay → the replayed token is already blacklisted → 401). The `expires_at` sync is a
   deterministic `filter(jti=...).update(...)` (idempotent). No non-idempotent step.
8. **Dead-letter / failure handling:** N/A — no task queue. A failed refresh returns 401
   and the SPA routes to login (existing behavior).

### Test coverage (for the follow-up test-scaffold pass)
Backend (`tests/apps/access/test_auth_cookie.py`, currently has **no** cookie-lifetime
coverage):
- login `remember_me=true` → persistent cookie (`Max-Age ≈ 30d`) and refresh JWT `exp ≈ 30d`.
- login `remember_me=false` (and omitted) → **session cookie** (no `Max-Age`/`Expires`)
  and refresh JWT `exp ≈ 12h`.
- rotation of a remember token → still persistent, `exp` re-slid to 30d, claim preserved.
- rotation of a session token → still a session cookie, `exp` 12h, claim preserved.
- rotation of a **legacy** token (no `remember` claim) → persistent 7d, claim still
  absent, not logged out, not converted to a session cookie (back-compat).
- **security:** a remember token blacklisted on rotation keeps its `OutstandingToken.
  expires_at ≈ 30d`, so its `BlacklistedToken` survives past day 7 (replay of the old
  token at day 8+ → 401).
- SSO callback login → session cookie + 12h `exp`.

Frontend: existing `LoginPage.test.tsx` / `wave8-login.spec.ts` assertions stand; add a
vitest assertion for the optional helper copy only if it is added.
```
