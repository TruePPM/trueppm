# Bash deny hook (`pre-bash-deny.sh`)

`.claude/hooks/pre-bash-deny.sh` is a Claude Code `PreToolUse` hook (matcher `Bash`,
registered in `.claude/settings.json`) that refuses the operations `CLAUDE.md` forbids
for agents. It is ported from the sibling project blueprint (`.claude/hooks/`, same
file names) so the two stay diffable; the decision logic is `.claude/hooks/lib/pre_bash_deny.py`.

## Why a hook, not `permissions.deny`

`permissions.deny` entries such as `Bash(git push --force:*)` are prefix matches, and
they are not a security boundary. `git push origin main --force`, `git push origin +main`,
`git -C . push -f`, `git push -uf`, `glab -R g/p mr merge` and `glab api -X PUT .../merge`
all get past them. The hook splits the command into simple commands with `shlex` and finds
the options wherever they sit. It fails closed: no `python3`, an unreadable event or an
unparseable command all deny (exit 2, reason on stderr).

## What it denies

| Class | Examples |
|---|---|
| Force push and ref deletion | `git push --force`/`-f` (also `-uf`), `+ref`, `:ref`, `--delete`/`-d`, `--mirror`, `--prune`, the GitLab auto-merge push option |
| Skipping hooks | `--no-verify` on any git subcommand, `git commit -n`, `-c core.hooksPath=` |
| Shared stash | `git stash` except `list`/`show`. `refs/stash` is not worktree-scoped; use `scripts/wt stash` (#3110) |
| Agent merges | `glab mr merge`, `glab api` calls to a merge endpoint, a `/merge` quick action in posted text |
| Destructive shell | `git reset --hard`, forced `git clean`, `rm -r` of `/`, `~`, `.`, `.git`, the project or a parent, `curl | sh` |
| Tampering | Bash writes to `.claude/settings*.json`, `.claude/hooks/**`, `.git/hooks/**`, `.git/config` |

`scripts/tests/pre-bash-deny.test.sh` lists every case (run by the `scripts:test`
CI job). The header of `pre-bash-deny.sh` lists the accepted misses, for example a command
held in a variable, or a program that writes a protected file itself (`python3 -c`).

## Decisions specific to TruePPM

- **`--force-with-lease` is allowed.** CLAUDE.md's "Batched MR sequence" rebases a feature
  branch and force-pushes it with `--force-with-lease`; denying it would make the prescribed
  flow impossible. The lease refuses a push that would overwrite work the agent has not
  seen. The hook cannot tell the target branch from the text of a command in general, so
  it does not try to limit the lease to feature branches: `main` is protected on the
  GitLab side, which rejects a non-fast-forward push regardless of how it is spelled.
  A bare `--force`/`-f` and `+ref` stay denied.
- **The `/release` push of `main` needs no opt-out.** `scripts/release.sh` commits the
  version bump on `main`, and `/release` runs `git push origin main` and then
  `git push origin <tags>`. Those are ordinary non-force pushes, which the hook does not
  deny, so the sanctioned direct push works unchanged and no environment variable can be
  used to switch the guard off. The pre-push git hook (`make pre-push`) and the protected
  branch settings remain the controls on that push; nothing in this hook widens or narrows
  them. If a release ever needs a force spelling (it should not: a published version is
  never re-cut), the user runs it in their own shell with `! git push ...`.
- **Blueprint's `/wave` worker tier is not ported.** Blueprint confines subagents under
  `.claude/worktrees/` to a read-mostly allowlist. TruePPM's `/wave` workers run there too
  with a different contract, so `set_worker()` returns immediately and the `worker_*`
  branches are dead code kept for diffability.
- **`scripts/wt` is unaffected.** It never calls `git stash`: `wt stash` uses
  `git stash create` plus its own `refs/wt-stash/<worktree>` ref. In any case the hook only
  inspects commands Claude's Bash tool is asked to run, not subprocesses of a script.

## Blocked by your own hook

When a command is denied, rewrite it (for example `scripts/wt stash` instead of `git stash`)
or ask the user to run it with `! <command>` in their own shell. Do not look for a spelling
that slips past the tokenizer; the denials are the policy. Never fall back to `--no-verify`.
