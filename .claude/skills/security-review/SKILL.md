---
name: security-review
model: opus
description: >
  Security architecture review and code audit for TruePPM. Use when reviewing
  authentication flows, authorization logic, API endpoints, data handling,
  dependency vulnerabilities, or deployment configurations. Covers OWASP Top 10,
  Django-specific security, React XSS prevention, mobile data-at-rest encryption,
  and Kubernetes security contexts. Flags issues by severity (Critical/High/Medium/Low).
---

# Security Review Skill

You are a security architect reviewing TruePPM code, configuration, or design.

## When Invoked

### Phase 1 — Research (Sonnet sub-agents, in parallel)

Spawn these sub-agents concurrently using the Agent tool with `model: "sonnet"`:

1. **Auth & permission scan**: "Search all viewsets and views in packages/api/src/ for `permission_classes`, `authentication_classes`, `IsAuthenticated`, and any custom permission class. For each view, report the file, class name, and the permission/auth classes applied. Flag any viewset missing explicit `permission_classes`."

2. **Input handling scan**: "Search packages/api/src/ for: `request.data` used outside serializer validation, `raw` SQL queries, `RawSQL`, `extra()`, `dangerouslySetInnerHTML` in packages/web/src/, and file upload handlers. Also report: (a) outbound HTTP clients (`requests.`, `httpx.`, `urllib.request`, `aiohttp`) and the source of each URL/host argument — flag any whose destination derives from user input (webhooks, callbacks, link/preview fetchers, import-from-URL); (b) XML / structured-document parsing of untrusted input (`etree`, `minidom`, `xml.sax`, `lxml`, `xmltodict`) and whether it routes through `defusedxml`. Report file paths and line numbers for each finding."

3. **Secrets & config scan**: "Search the entire repo for hardcoded secrets: API keys, passwords, tokens, connection strings in source files (not .env.example). Check Helm values files for inline secrets vs K8s Secret references. Check CORS settings in Django settings files. Report all findings."

Wait for all three agents to return before proceeding.

### Phase 2 — Audit (Opus, main context)

Using the research results, evaluate each finding against the checklist below. Produce the output format at the end.

## Review Checklist

### Authentication & Authorization
- [ ] JWT tokens: short-lived access (15min), refresh rotation enabled, secure storage
- [ ] API keys: hashed in DB, scoped per-project, revocable
- [ ] RBAC: every viewset has explicit permission classes (no default allow)
- [ ] Object-level permissions: users cannot access other projects' data
- [ ] **Destructive/replace operations keyed on a natural key verify caller ownership** — any delete-or-replace path that locates its target by a user-supplied natural key (code, slug, name, email, external id) must verify the caller's ownership/membership of the matched row *and* honor any sample/seed/tombstone guard before deleting. A natural key collides across users — it is never a cross-user identity. Flag any "look up by natural key, then delete/overwrite" path that skips the membership check or the protected-row guard.
- [ ] WebSocket auth: JWT validated on connect, not just in headers
- [ ] Mobile: tokens stored in Keychain (iOS) / Keystore (Android), never AsyncStorage
- [ ] Enterprise SSO: SAML/OIDC token validation, session fixation prevention

### API Security
- [ ] Input validation: DRF serializers validate all input (no raw request.data usage)
- [ ] SQL injection: ORM-only queries (no raw SQL without parameterization)
- [ ] Rate limiting: per-endpoint, per-user, per-API-key
- [ ] **Brute-force throttle on credential and token endpoints** — every endpoint that verifies a secret or issues/refreshes a token (login / token-obtain, token-refresh, password-reset request *and* confirm, invite or share-link accept, 2FA verify) needs an explicit anti-brute-force throttle (DRF `throttle_classes` with a scoped rate, or equivalent). A generic per-user throttle does not cover these: pre-auth endpoints have no authenticated user, so the throttle scope must key on client IP and/or the submitted identifier. Flag any credential-verifying or token-issuing view with no throttle as the credential-stuffing surface it is.
- [ ] **SSRF on user-controlled outbound requests** — any server-initiated request whose URL, host, or scheme derives from user input (outgoing webhooks, callback URLs, link/preview fetchers, import-from-URL, avatar-from-URL) must validate the *resolved* destination: reject private / loopback / link-local / cloud-metadata ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, `::1`, `fc00::/7`), enforce an `https` scheme allowlist, disable or re-validate redirects, and guard DNS-rebinding by checking the IP actually connected to (not just the hostname). For each outbound client found in the input-handling scan, trace the URL argument to its source and flag any user-controlled destination with no egress guard.
- [ ] **Hardened parser for user-supplied XML / structured documents** — any parse of user-uploaded or user-supplied XML (MS Project import, SAML, OPML, SVG, any `.xml`/`.mpp`-adjacent format) must use a hardened parser (`defusedxml`), never stdlib `xml.etree` / `xml.dom.minidom` / `xml.sax` or bare `lxml` on untrusted input. This is the class behind XXE (external-entity file read and SSRF) and entity-expansion DoS (billion-laughs). Grep `grep -rnE '\b(etree|minidom|xml\.sax|lxml|xmltodict)\b' packages/api/` and confirm every untrusted-input parse path is `defusedxml`-backed.
- [ ] CORS: explicit allowlist, no wildcard origins
- [ ] CSRF: enforced on session-auth endpoints, exempt on JWT-only endpoints
- [ ] File uploads: type validation, size limits, malware scanning, S3 storage (never local)
- [ ] Pagination: enforced maximums (prevent full-table dumps)
- [ ] Batch operations: size limits (prevent DoS via bulk create)
- [ ] **Diff each mutation's guards against its sibling actions on the same resource** — when auditing any create/update/delete/replace path, enumerate the parallel mutation paths on the same resource and compare their guard sets. A check present on one mutation (e.g. an ownership or sample-guard on `destroy`) and absent on a parallel path (e.g. a `replace`/`update_or_create`/bulk-upsert) is a finding: the sibling proves the intended invariant, so the gap is a regression, not a design choice. Treat the most-guarded sibling as the baseline every other path must meet.
- [ ] **ORM instances captured in `transaction.on_commit()` closures** — closures registered with `transaction.on_commit()` (and Celery `delay()` callbacks, signal handlers that defer work, any "fire after the request" hook) must capture *plain values* (dicts, integer/UUID PKs), not ORM instances or live querysets. ORM rows captured in such closures may have already been modified, deleted, or be cross-thread by the time the closure runs, leading to stale-read leaks on broadcast or `DoesNotExist` crashes. Grep: `grep -rnB2 -A5 'transaction.on_commit' packages/api/` and verify no closure references a model instance bound by the outer scope.

### Real-time / Push-Channel Security
- [ ] **Per-recipient field filtering on Channels group_send** — when a serializer's `to_representation` strips a field for a subset of viewers (admin-only metadata, PII, internal state, audit fields) on the REST surface, every WebSocket consumer that uses the same serializer needs an equivalent gate at the consumer layer (`Consumer.<event_handler>`). A REST-stripped field shipped intact via `channel_layer.group_send()` is the same leak as exposing it on REST. Audit every `group_send` call site against every `to_representation` override on the serializer it uses.
- [ ] **Post-revocation data retention on push surfaces** — when a write removes a user's access to a resource (`Membership.delete`, group leave, role demotion, project archival), audit every endpoint that surfaces the resource's *historical* content to that user (notifications, activity feeds, mention digests, search results, recent-views lists). If access is revoked but historical project/task/group names are still served, that is an information-retention leak. The fix is either to filter at read time (re-check membership) or purge on the revocation event. Flag any new revocation flow that does neither.

### Data Protection
- [ ] **Team-signal exposure passes the signal-privacy suppression gate (ADR-0104)** — any serializer field, endpoint, or broadcast payload that exposes team-signal data (velocity, throughput, burndown, capacity, forecast bands) must route through the project's signal-privacy suppression gate. Trace every new exposure path to the gate helper and flag any that reads the raw value directly and bypasses suppression — a new signal surface that skips the gate leaks data the project chose to suppress.
- [ ] PII handling: email, names in encrypted columns or with access logging
- [ ] Secrets management: no secrets in code, environment variables or K8s secrets
- [ ] Database: SSL connections, credentials rotated, backups encrypted
- [ ] Redis: password-protected, no public exposure
- [ ] Mobile offline data: SQLite database encrypted at rest (SQLCipher)
- [ ] Sync protocol: HTTPS only, certificate pinning on mobile

### Frontend Security
- [ ] XSS: no dangerouslySetInnerHTML, sanitize user-generated content
- [ ] CSP headers: strict Content-Security-Policy
- [ ] Dependencies: no known CVEs (npm audit, pip audit)
- [ ] Sensitive data: never in URL params, localStorage, or console.log

### Infrastructure
- [ ] K8s: non-root containers, read-only root filesystem, resource limits
- [ ] Network policies: pod-to-pod communication restricted
- [ ] Ingress: TLS 1.2+, HSTS enabled, certificate auto-renewal
- [ ] Docker images: minimal base (distroless/alpine), no unnecessary packages
- [ ] Helm values: secrets reference K8s Secrets, not inline values

### Dependency Supply Chain
- [ ] All dependencies pinned to exact versions (lock files committed)
- [ ] Dependabot or Renovate enabled for automated updates
- [ ] No dependencies with known CVEs of severity High or Critical
- [ ] License audit: no GPL/AGPL dependencies in Apache 2.0 codebase

## Output Format

For each finding:
```
### [SEVERITY] Finding Title
**Location**: file:line or component
**Description**: What the issue is
**Risk**: What could happen if exploited
**Remediation**: How to fix it
**Priority**: Fix now / Fix before release / Track
```

Severities: CRITICAL (exploitable, data exposure), HIGH (likely exploitable),
MEDIUM (defense-in-depth gap), LOW (hardening opportunity), INFO (best practice).

## Apache 2.0 Boundary Security

Enterprise security features (SSO, audit trail, custom roles) must NOT create
security regressions in the community edition. The community edition must be
secure by default without the enterprise package installed. Verify:
- No auth bypass if enterprise middleware is absent
- Default RBAC (5 roles) enforces least-privilege without enterprise custom roles
- Audit logging in community edition (basic change log) works independently
