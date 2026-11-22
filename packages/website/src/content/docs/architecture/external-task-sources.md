---
title: External task sources
description: Developer guide to the EXTERNAL_TASK_SOURCES extension point — the ExternalTaskSource contract, how to register a source, and the read-only boundary it must respect.
---

`EXTERNAL_TASK_SOURCES` is the extension point for a **personal, read-only** feed of
work items from another system into a user's [My Work](/features/my-work/). A user
connects their own account, TruePPM pulls the items assigned to them, and shows them
beside their TruePPM work. The shipped Jira connector is built on it, and a third
party can register another source against the same registry. This page is for someone
writing that source. For the end-user view of the shipped connector, see
[Connected accounts](/features/connected-accounts/#available-sources).

The design record is [ADR-0097](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0097-user-scoped-external-task-sync.md).

## The boundary your source must stay inside

The registry is in the Community (Apache 2.0) edition because it is deliberately
narrow. A source that crosses any of these lines is no longer this extension point,
and belongs in an Enterprise integration instead:

- **Read-only.** A source only reads. It never writes back to the remote system: no
  status change, comment, or assignment.
- **User-scoped.** One connection belongs to one user and holds that user's own
  credential. There is no organization-wide connector, shared service account, or
  admin-configured OAuth application.
- **No tasks.** A pulled item is a cache row (`ExternalWorkItem`), never a `Task`. It
  does not enter the schedule, take part in CPM, or become synced domain data. It never
  crosses the project WebSocket broadcast or the sync delta.
- **No inbound webhooks.** The pull is initiated by TruePPM. A source does not receive
  pushes from the provider. The multi-provider, bidirectional integration hub is a
  separate Enterprise feature.

## The contract

A source subclasses `ExternalTaskSource`, defined in
`packages/api/src/trueppm_api/apps/integrations/external_sources.py`. A source holds no
state and is instantiated per call. The caller decrypts the user's token once, at the
boundary, and passes the plaintext in, so a source never sees ciphertext or the
credential row.

| Member | Required | Purpose |
|---|---|---|
| `key` | yes | Class attribute. The registry key and the `<source>` segment of `/api/v1/me/connections/<source>/`, for example `"jira"`. |
| `label` | yes | Class attribute. The display name. |
| `requires_credential` | no | Class attribute, defaults to `True`. |
| `fetch_assigned_items(*, base_url, secret, config)` | **yes, the only abstract method** | Returns `list[ExternalWorkItemDTO]`: the items currently assigned to the credential's owner. One page, with no persistence. |
| `fetch_assigned_items_result(*, base_url, secret, config)` | no | Same read, returned as an `ExternalFetchResult` that also carries `total_available` and `page_size`, so My Work can say "the first 100 of 412". The default wraps `fetch_assigned_items` and reports both as unknown. |
| `verify_credential(*, base_url, secret, config)` | no | Checks that the token authenticates before the connection is stored. Returns a `VerifyResult`. The default accepts without a live check (`reason="unverified"`). |

The two optional methods are additive on purpose. A source written before they existed
keeps working, because the ABC is a cross-repo commitment: adding a source key is
additive, and renaming or removing a key or changing a signature is a
major-version change.

### What you return

`ExternalWorkItemDTO` is a frozen dataclass:

| Field | Meaning |
|---|---|
| `external_id` | The provider's identifier, such as the Jira key `RIV-482`. |
| `external_url` | Deep link to the item. Only `http` and `https` survive. |
| `title` | The item's summary. |
| `external_status` | The provider's raw status name. |
| `display_bucket` | One of `todo`, `in_progress`, `done`. Your source maps the provider's states onto these. |
| `due_date` | Optional `date`, or `None`. |

Treat the provider's response as untrusted. The sync worker calls the DTO's
`sanitized()` on every item before caching it: it truncates `external_id` to 255
characters, `title` to 512, `external_status` to 64 and `external_url` to 2,000,
replaces a non-`http(s)` URL with an empty string, and coerces an unknown
`display_bucket` to `todo`. The Jira source calls it too, so do the same in a new
source rather than relying on the worker alone.

### Signaling failure

Raise these from `fetch_assigned_items` (all are in `external_sources.py`). The sync
worker handles each differently, so pick the narrowest one:

| Exception | When | Effect |
|---|---|---|
| `ExternalSourceAuthError` | The provider rejected the token (401 or 403). | The connection is flagged as auth-failed, My Work shows "Reconnect", and the pull is not retried. |
| `ExternalSourceRateLimited(message, retry_after=...)` | The provider returned 429. Pass the parsed `Retry-After` seconds, or `None`. | The pull is re-queued against the provider's clock rather than treated as an outage. |
| `ExternalSourceConfigError` | The stored `config` cannot produce a safe query. | The connection is flagged with an invalid-filter state, not "unreachable", because retrying cannot fix it. |
| `ExternalSourceError` | Anything else: transport failure, a non-200, an unparseable body. | The last good cache is kept and shown as stale. |

### Outbound requests

Make provider requests through the SSRF-guarded helper the Jira source uses
(`from . import http` in `external_sources.py`), not a bare HTTP client.

## Registering a source

Register your class on the `EXTERNAL_TASK_SOURCES` registry, an instance of
`ProviderRegistry`, from your Django app's `AppConfig.ready()`. No OSS code changes and
no import of any Enterprise package are required:

```python
from django.apps import AppConfig


class MySourceConfig(AppConfig):
    name = "my_company.trueppm_linear"

    def ready(self) -> None:
        from trueppm_api.apps.integrations.external_sources import EXTERNAL_TASK_SOURCES

        from .source import LinearSource

        EXTERNAL_TASK_SOURCES.register(LinearSource.key, LinearSource)
```

Add the app to `INSTALLED_APPS`. Notes:

- `register(key, handler)` raises `ValueError` if the key is already taken, and
  `TypeError` if the class does not subclass `ExternalTaskSource`. A duplicate key is
  always a bug, so choose a distinct key rather than overriding an existing one.
- `EXTERNAL_TASK_SOURCES` is **not** the git-link registry. `TASK_LINK_PROVIDERS`
  (ADR-0049) handles "paste a URL on a task and show its status". The two solve
  different problems, and the same name can mean different things in each. For example,
  `jira` is a personal pull here and an Enterprise link provider there.
- Once registered, your `key` is accepted by the connection endpoints (`GET`, `PUT`,
  `PATCH` and `DELETE` on `/api/v1/me/connections/<key>/`) and by the sync trigger
  (`POST /api/v1/me/connections/<key>/sync/`), which refuse a key that is not in the
  registry.
- **Host allow-list.** Before verifying a token, the connection endpoint refuses any
  `base_url` whose host is not allowed for that key, so a token is never sent to an
  arbitrary host. `jira` has built-in rules, but a new key has no built-in hosts, so a
  connection to your source is accepted only for hosts an operator lists in
  `TRUEPPM_INTEGRATION_ALLOWED_HOSTS`, and the URL must be `https`. Tell your users'
  administrators to add the provider's host.
- Credentials are stored per user and per source, encrypted at rest. Your `secret`
  argument is the decrypted token.

## Worked example: the Jira source

`JiraSource` in the same module is the reference implementation, and it registers from
`IntegrationsConfig.ready()` through `OSS_EXTERNAL_TASK_SOURCES`. It shows the pattern
for every optional hook:

- **One key, two deployments.** `key = "jira"` covers both Jira Cloud and self-hosted
  Data Center or Server. `config["deployment"]` (`"cloud"` by default, or `"server"`)
  selects a backend strategy at call time, which changes the API version and the auth
  header. A stored row with no `deployment` is treated as Cloud.
- **`config` carries per-user settings.** Jira reads an optional `jql` (what to pull,
  defaulting to the assigned-and-not-done query), `project_keys` (ANDed on top of the
  query to narrow it) and, for Cloud, `account_email`. Your source defines which keys
  it reads, and rejects an unusable value with `ExternalSourceConfigError`.
- **Overrides `verify_credential`** to ping the provider, so a wrong token is refused
  when the user connects, not on the first pull.
- **Overrides `fetch_assigned_items_result`** because Jira reports the total number of
  matches, which makes truncation an exact statement instead of a guess from a full
  page.
- **Maps status to a bucket** from the provider's status category into the three
  `display_bucket` values.
- **Maps errors** to the exceptions above: 401 and 403 to `ExternalSourceAuthError`, 429
  to `ExternalSourceRateLimited` with the parsed `Retry-After`, a malformed filter to
  `ExternalSourceConfigError`.

Read it alongside its tests in `packages/api/tests/apps/integrations/test_external_sources.py`
before writing your own.

## What the platform does for you

You do not write any of the following, which is why a source stays small:

- the connection endpoints and credential storage;
- the host allow-list and token encryption;
- the background pull, retry and rate-limit handling, and the 500-item cache cap per
  connection;
- the `ExternalWorkItem` cache, marking items stale when they drop out of a successful
  pull, and My Work rendering.
