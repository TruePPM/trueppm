---
name: code-review
description: >
  Code review for TruePPM following project conventions. Use when reviewing PRs,
  auditing code quality, or checking adherence to CLAUDE.md standards. Checks Python
  (ruff, mypy, Django patterns), TypeScript (strict mode, React patterns), and
  cross-cutting concerns (Apache 2.0 boundary, API-first, test coverage).
---

# Code Review Skill

Review code for correctness, conventions, and TruePPM-specific rules.

## Review Priority (check in this order)

1. **Apache 2.0 boundary violation**: Does OSS code import from trueppm_enterprise? BLOCKER.
2. **Security**: Auth bypass, SQL injection, XSS, secrets in code. BLOCKER.
3. **Correctness**: Logic errors, race conditions, unhandled edge cases. HIGH.
4. **API-first**: Does new functionality have an API endpoint? Or is it UI-only? HIGH.
5. **Type safety**: Any `any` types in TS? Missing type hints in Python? MEDIUM.
6. **Test coverage**: New code has tests? Coverage ≥80% maintained? MEDIUM.
7. **Performance**: N+1 queries, unnecessary serialization, missing pagination. MEDIUM.
8. **Conventions**: Naming, formatting, commit messages, file organization. LOW.

## Python-Specific
- Models: UUID PKs, server_version field, proper indexes
- Views: DRF viewsets with explicit permission_classes (never empty)
- Serializers: validate all input, no raw request.data
- Queries: select_related / prefetch_related for FK/M2M (no N+1)
- Celery tasks: idempotent, with retry logic and dead letter handling
- Type hints on all function signatures

## TypeScript-Specific
- No `any` — use `unknown` and type guards
- React: functional components only, hooks follow rules-of-hooks
- TanStack Query for all server state (no manual fetch + useState)
- Zustand for client-only state
- Error boundaries around async-rendering components
- Memoization only when measured (no premature React.memo)

## Output Format
```
## Summary
<1-2 sentence overall assessment>

## Findings
### [BLOCKER/HIGH/MEDIUM/LOW] <title>
**File**: path:line
**Issue**: What's wrong
**Fix**: How to fix it
```

Only report actual issues. Do not comment on style choices that pass ruff/eslint.
Do not praise code that is merely correct — that's the baseline.
