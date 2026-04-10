# Changelog Fragments

Each branch that introduces a user-visible change adds a fragment file here.
Fragments are assembled into `CHANGELOG.md` at release time by `scripts/assemble-changelog.sh`.

## Fragment naming

```
<slug>.<type>.md
```

- **slug** — short identifier for the change (issue number or description, e.g. `56` or `auth-retry-race`)
- **type** — one of: `added`, `changed`, `fixed`, `security`

Examples:
```
56.fixed.md
board-view.added.md
api-token-refresh.security.md
```

## Fragment content

Write one or more bullet points describing the user-visible change:

```markdown
- **Auth 401-retry race**: after logging in, TanStack Query retried stale 401
  errors before the new token was stored. Fixed by gating renders on Zustand
  hydration and suppressing 401 retries at the query level.
```

## CI enforcement

The `changelog:check` CI job verifies that every MR targeting `main` contains at
least one fragment file (unless the branch is exempt — `chore/*`, `ci/*`, `docs/*`).

## Assembly

At release time, `scripts/release.sh` calls `scripts/assemble-changelog.sh` which:
1. Collects all fragment files
2. Groups entries by type (Added / Changed / Fixed / Security)
3. Appends them to the `[Unreleased]` section of `CHANGELOG.md`
4. Deletes the fragment files
