---
name: mr
description: >
  Open a GitLab merge request for the current branch targeting main. Runs
  pre-flight checks (clean branch, green local checks, CHANGELOG updated),
  writes a structured MR description, and creates the MR via glab. Use this
  whenever the user asks to open, create, or submit an MR.
---

# MR Skill

Create a GitLab merge request for the current branch.

## Invocation

```
/mr
```

No arguments. Always targets `main`. Always uses `glab mr create`.

---

## Step 1 — Gather context

Run these in parallel:

```bash
# Current branch and remote state
git branch --show-current
git status --short
git log main..HEAD --oneline

# Full diff vs main for description writing
git diff main...HEAD --stat

# Confirm no uncommitted changes
git status --porcelain
```

If there are uncommitted changes, **stop and tell the user** before proceeding. Do not create an MR with a dirty working tree.

---

## Step 2 — Pre-flight checks

### 2a. CHANGELOG
Check that `CHANGELOG.md` has an entry in `[Unreleased]` that covers the changes on this branch.

```bash
grep -A 30 '\[Unreleased\]' CHANGELOG.md | head -40
```

If missing and the branch is **not** exempt (see below), add an entry first and commit it:
```bash
git add CHANGELOG.md
git commit -m "docs: update CHANGELOG for <feature>"
```

**Exempt from CHANGELOG**: CI config changes, dependency bumps, test-only changes, docs-only changes, chores with no behavior change.

### 2b. Branch naming
Confirm the branch name follows `feat/`, `fix/`, `docs/`, `chore/`, `test/`, `refactor/`, `perf/`, `ci/` prefix convention. If not, warn the user (do not rename automatically).

### 2c. Existing MR
Check if an MR already exists for this branch:
```bash
glab mr list --source-branch $(git branch --show-current) 2>/dev/null
```
If one exists, report its URL and stop — do not create a duplicate.

---

## Step 3 — Write the MR description

Analyse `git log main..HEAD` and `git diff main...HEAD --stat` to understand all changes. Produce:

**Title** (≤70 chars): Use conventional commit style — `feat(scope): short description`. Derive from the most significant commit or the branch name.

**Body sections**:

```markdown
## Summary
- <bullet: what changed and why, 1–4 bullets>

## Changes
- <bullet per logical change group: component/file → what it does now>

## Test plan
- [ ] <specific thing to verify manually>
- [ ] <another verification step>
- [ ] Confirm CI pipeline is green

## Notes
<optional: migration steps, feature flags, known limitations, follow-up issues>
```

Rules for the description:
- Be specific about *what* changed, not just *that* it changed
- Link closing issues with `Closes #N` on a line after the Notes section if applicable
- If it's a UI change, add a Screenshots section placeholder: `## Screenshots\n<!-- attach before/after -->`
- Do not pad with filler text

---

## Step 4 — Create the MR

```bash
glab mr create \
  --title "<title>" \
  --target-branch main \
  --body "$(cat <<'EOF'
<body>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Always use a heredoc for the body** — never inline `\n` literals. This is required for correct multiline rendering.

Do not pass `--web` (opens browser unnecessarily). Do not pass `--squash` or `--remove-source-branch` unless the user explicitly asked.

---

## Step 5 — Confirm and report

After creation, output:
```
MR created: <URL>
```

If the pipeline hasn't started yet, note that CI will run automatically on push.

---

## Rules

- **Never force-push** to prepare for an MR — if the branch is behind main, tell the user and let them decide whether to rebase
- **Never open an MR to a branch other than main** without explicit user instruction
- **Never create duplicate MRs** — check first
- **Heredoc syntax is mandatory** for multi-line MR bodies — never use inline `\n`
- **Stop and ask** if CHANGELOG is missing and the change is not clearly exempt
- If `glab` is not authenticated, tell the user to run `glab auth login` and stop
