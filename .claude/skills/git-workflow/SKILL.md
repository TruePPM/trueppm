---
name: git-workflow
description: >
  Git branching, commit, and PR management for TruePPM. Use when creating branches,
  writing commit messages, preparing PRs, or managing releases. Enforces conventional
  commits, branch naming conventions, and the two-repo workflow (OSS vs Enterprise).
---

# Git Workflow Skill

## Branch Naming
- `feature/<issue-number>-<brief-description>` (e.g., `feature/3-cpm-engine`)
- `fix/<issue-number>-<brief-description>` (e.g., `fix/42-sync-conflict`)
- `docs/<topic>` (e.g., `docs/api-reference`)
- `release/v<version>` (e.g., `release/v0.1.0`)

## Commit Format (Conventional Commits)
```
<type>(<scope>): <description>

[optional body]

[optional footer: Refs #<issue-number>]
```
Types: feat, fix, docs, test, chore, refactor, perf, ci
Scopes: scheduler, api, web, mobile, helm, sync

## PR Checklist
- [ ] Branch name follows convention
- [ ] All commits follow conventional commit format
- [ ] Tests added/updated for changes
- [ ] No lint or type errors (`ruff check`, `npx tsc --noEmit`)
- [ ] API changes: OpenAPI schema updated
- [ ] Database changes: migration included and reversible
- [ ] OSS/Enterprise boundary: no cross-repo imports
- [ ] Changelog entry added (for user-facing changes)

## Two-Repo Workflow
- OSS changes: PR to `trueppm/trueppm-suite` on GitLab
- Enterprise changes: PR to `trueppm/trueppm-enterprise` on GitLab
- Never mix OSS and Enterprise changes in the same PR
- Enterprise PRs should reference the OSS plugin interface they depend on

## Release Process
1. Create `release/v<version>` branch from main
2. Update version in pyproject.toml / package.json
3. Generate changelog from conventional commits
4. Tag: `git tag v<version>`
5. Push tag → CI publishes to PyPI (scheduler) + Docker registry + Helm chart
