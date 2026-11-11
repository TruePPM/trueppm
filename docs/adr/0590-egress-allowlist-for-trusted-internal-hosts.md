# ADR-0590: An operator allow-list for trusted internal hosts on the SSRF egress guard

## Status

Accepted (2026-07-22). Amended 2026-11-11 by #2851 / #3561: the allow-list is
scoped per egress purpose (see "Amendment" below).

> Narrows [ADR-0049](0049-external-integration-extension-points.md) §3 (the
> outbound SSRF egress chokepoint) with a single, operator-controlled escape
> hatch. It does not change
> the default posture: with the allow-list unset — the default — every resolved
> address must still be globally routable, exactly as before. Issue #2274.

## Context

`apps/integrations/http` is the single egress chokepoint for every request-cycle
outbound call (PAT verification, git-link refresh, SMTP relay reachability, and —
via `apps/sso` — OIDC discovery / token / JWKS). Its guard rejects any URL whose
host resolves to a private / loopback / link-local / reserved address. That is the
correct default: it stops a user- or operator-supplied URL from reaching cloud
metadata (`169.254.169.254`), loopback, or an RFC1918 host on the cluster network.

Two facts collide:

1. **A self-hoster may run their identity provider inside the same cluster.** Basic
   OIDC SSO is open-source-core and adoption-first; a common deployment is TruePPM
   and Keycloak (or Authentik / Zitadel) in one Kubernetes namespace. The OIDC
   issuer then resolves to a **private ClusterIP** (e.g. `keycloak.sso.svc`). The
   guard blocks discovery / token / JWKS, so **in-cluster SSO is impossible** — the
   issuer is unreachable and "Test connection" fails. The only workaround today is
   to route the IdP back out through a public ingress hostname, which many operators
   cannot or will not do.
2. **We want a nightly CI smoke that completes a real OIDC handshake** against a
   live Keycloak (#2274). In CI, Keycloak is a service on the private runner
   network; Django reaches it at `http://keycloak:8080`, a private address the guard
   blocks. There is no way to give a co-located service a globally-routable address,
   so the smoke cannot run without the guard admitting the host.

Both are the same problem: a co-located, operator-run, trusted internal service the
guard has no way to distinguish from an SSRF target — because at the IP layer it
genuinely cannot. The only actor who can assert "this internal host is trusted" is
the operator.

## Decision

Add `EGRESS_ALLOWLISTED_HOSTS` (env: `TRUEPPM_EGRESS_ALLOWLISTED_HOSTS`,
comma-separated, **default empty**). A host whose name is in the list bypasses the
private-address deny-list in both `assert_url_allowed` and `assert_host_allowed`.

Constraints that keep the escape hatch narrow:

- **Configuration only.** The value comes from settings / environment, never from
  request data or any user-supplied field. An attacker cannot widen it.
- **Exact, case-insensitive hostname match.** No wildcards, no suffix matching, so
  allow-listing `keycloak` cannot be tricked into admitting `keycloak.attacker.example`.
- **The scheme gate still applies.** An allow-listed host must still be `http`/
  `https`; `file://keycloak/...` stays blocked.
- **Empty by default.** An install that does not set it is byte-for-byte the
  ADR-0049 behavior — this is purely additive and off unless an operator opts in.

## Consequences

- **In-cluster SSO becomes possible** without exposing the IdP publicly — the
  operator names the issuer host and nothing else changes.
- **The nightly `sso:integration` smoke can reach its Keycloak service** by setting
  `TRUEPPM_EGRESS_ALLOWLISTED_HOSTS=keycloak`, exercising the real discovery /
  token / JWKS path that every other SSO test mocks.
- **The allow-list is global to the chokepoint, not SSO-scoped.** Every egress
  caller (PAT verification, git-link refresh, webhook delivery, SMTP relay check,
  SSO) honors it, and some of those take user-supplied URLs. An allow-listed host
  is therefore reachable through those surfaces too. This is acceptable because the
  entry is a single exact host the operator has declared trusted, but the operator
  guidance (`administration/single-sign-on.md`) states it explicitly so a host more
  sensitive than the IdP issuer is never added.
- **Residual risk is the operator's own trust decision.** An allow-listed host
  skips the resolved-IP check, so if an attacker controlled DNS for that exact
  hostname they could redirect the call — but controlling in-cluster DNS already
  implies cluster compromise, and the match is exact so no lookalike is admitted.
  This is a strict, bounded widening of ADR-0049, documented for operators in
  `administration/single-sign-on.md`.
- **Not an Enterprise line.** This is table-stakes self-hosting ergonomics for the
  open-source core (the adoption-vs-governance split is unaffected).

## Amendment (2026-11-11, #2851 / #3561): one list per egress purpose

The "global to the chokepoint" consequence above was too wide. The intended use is
an operator-configured destination (the IdP issuer). The same exemption applied to
surfaces whose destination is chosen by a project Admin (webhook URLs) or by any
user (a pasted git link, a Connected Account base URL). An operator who followed the
SSO guidance and allow-listed `keycloak` thereby let a project Admin register
`https://keycloak/admin/...` as a webhook and receive internal responses.

Decision: every chokepoint entry point (`assert_url_allowed`, `assert_host_allowed`,
`get`, `post_form`, `build_guarded_opener`) takes a `purpose` (`EgressPurpose`), and
each purpose reads only its own list:

| Purpose | Setting | Callers |
|---|---|---|
| `sso` | `EGRESS_ALLOWLISTED_HOSTS_SSO` ∪ legacy `EGRESS_ALLOWLISTED_HOSTS` | OIDC discovery / token / JWKS, GitHub login |
| `smtp` | `EGRESS_ALLOWLISTED_HOSTS_SMTP` | workspace SMTP relay check |
| `integrations` | `EGRESS_ALLOWLISTED_HOSTS_INTEGRATIONS` | PAT verification, git-link refresh, external task sources |
| `webhooks` | `EGRESS_ALLOWLISTED_HOSTS_WEBHOOKS` | webhook registration and delivery |
| _(none)_ | — | the anonymous file-link unfurl, and any caller that declares nothing |

The purpose is bound into the guarded connection as well as the pre-flight, so
the connect-time check cannot honor a list that the pre-flight refused. A caller
that declares no purpose honors no list (fail closed). The legacy name stays
backward compatible for its documented SSO use and for the `sso:integration` CI
job. An install that used it for SMTP, a self-hosted integration host, or a webhook
receiver must move that host to the matching list. The 0.5 security changelog
entry says so.

