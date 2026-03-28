---
name: mr
model: opus
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

## Step 1 — Gather context & pre-flight (Sonnet sub-agents, in parallel)

Spawn these sub-agents concurrently using the Agent tool with `model: "sonnet"`:

1. **Branch & diff analysis**: "Run `git branch --show-current`, `git status --short`, `git log main..HEAD --oneline`, `git diff main...HEAD --stat`, and `git status --porcelain`. Return all output verbatim. If there are uncommitted changes (porcelain output is non-empty), flag it prominently."

2. **Pre-flight checks**: "Run these checks and report results:
   (a) CHANGELOG: run `grep -A 30 '\\[Unreleased\\]' CHANGELOG.md | head -40` and report whether entries exist for the current branch's changes.
   (b) Branch naming: run `git branch --show-current` and verify it follows `feat/`, `fix/`, `docs/`, `chore/`, `test/`, `refactor/`, `perf/`, `ci/` prefix convention.
   (c) Existing MR: run `glab mr list --source-branch $(git branch --show-current) 2>/dev/null` and report any existing MRs with their titles and URLs."

Wait for both agents to return. Then evaluate:

- If there are uncommitted changes, **stop and tell the user**.
- If CHANGELOG is missing and the branch is **not** exempt (CI config, dependency bumps, test-only, docs-only, chores), add an entry first and commit it.
- If an existing MR exists, verify it belongs to the current work:
  - If the title matches the current commits, report the URL and stop.
  - If the title does **not** match, **stop and tell the user** with a clear conflict description.

**Exempt from CHANGELOG**: CI config changes, dependency bumps, test-only changes, docs-only changes, chores with no behavior change.

---

## Step 2 — Write the MR description

Using the research results from Step 1, analyse the commits and diff to produce:

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

## Step 3 — Create the MR

```bash
glab mr create \
  --title "<title>" \
  --target-branch main \
  --description "$(cat <<'EOF'
<body>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Always use a heredoc for the body** — never inline `\n` literals. This is required for correct multiline rendering.

Do not pass `--web` (opens browser unnecessarily). Do not pass `--squash` or `--remove-source-branch` unless the user explicitly asked.

---

## Step 4 — Confirm and report

After creation, output:
```
MR created: <URL>
```

If the pipeline hasn't started yet, note that CI will run automatically on push.

---

## Rules

- **Never force-push** to prepare for an MR — if the branch is behind main, tell the user and let them decide whether to rebase
- **Before any force-push to a remote branch**, check whether an open MR exists against that branch (`glab mr list --source-branch <branch>`). If one exists and belongs to different work, stop and tell the user — force-pushing will silently replace the MR's diff with unrelated commits
- **Never open an MR to a branch other than main** without explicit user instruction
- **Never create duplicate MRs** — check first
- **Heredoc syntax is mandatory** for multi-line MR bodies — never use inline `\n`
- **Stop and ask** if CHANGELOG is missing and the change is not clearly exempt
- If `glab` is not authenticated, tell the user to run `glab auth login` and stop
