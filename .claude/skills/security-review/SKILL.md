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

2. **Input handling scan**: "Search packages/api/src/ for: `request.data` used outside serializer validation, `raw` SQL queries, `RawSQL`, `extra()`, `dangerouslySetInnerHTML` in packages/web/src/, and file upload handlers. Report file paths and line numbers for each finding."

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
- [ ] WebSocket auth: JWT validated on connect, not just in headers
- [ ] Mobile: tokens stored in Keychain (iOS) / Keystore (Android), never AsyncStorage
- [ ] Enterprise SSO: SAML/OIDC token validation, session fixation prevention

### API Security
- [ ] Input validation: DRF serializers validate all input (no raw request.data usage)
- [ ] SQL injection: ORM-only queries (no raw SQL without parameterization)
- [ ] Rate limiting: per-endpoint, per-user, per-API-key
- [ ] CORS: explicit allowlist, no wildcard origins
- [ ] CSRF: enforced on session-auth endpoints, exempt on JWT-only endpoints
- [ ] File uploads: type validation, size limits, malware scanning, S3 storage (never local)
- [ ] Pagination: enforced maximums (prevent full-table dumps)
- [ ] Batch operations: size limits (prevent DoS via bulk create)

### Data Protection
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
