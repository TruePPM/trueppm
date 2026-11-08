#!/usr/bin/env bash
# PreToolUse hook (matcher: "Bash") — deny the operations CLAUDE.md forbids,
# by TOKENIZING the command instead of prefix-matching it (issue blueprint#124).
#
# ## Why a hook and not permission deny rules
#
# `permissions.deny` entries such as `Bash(git push --force:*)` are prefix
# matches, and the Claude Code docs say permission rules are not a security
# boundary. `git push origin main --force`, `git push origin +main`,
# `git -C . push -f`, `git push -uf`, `git push origin :branch`,
# `glab -R g/p mr merge` and `glab api -X PUT .../merge` all slip past them.
# This hook splits the command into simple commands with `shlex`, so options
# are found wherever they sit. The deny rules in settings.json stay as a
# convenience; this hook and the sandbox (blueprint#104) are the boundary.
# <!-- cc-claim: https://code.claude.com/docs/en/permissions checked: 2026-10-17 -->
#
# ## Output contract
#
# Exit 2 blocks the tool call and feeds stderr back to Claude; exit 0 with no
# output allows it.
# <!-- cc-claim: https://code.claude.com/docs/en/hooks checked: 2026-10-17 -->
#
# ## Denied (see scripts/tests/pre-bash-deny.test.sh for every case)
#
#   git push   --force / -f (also inside a cluster such as -uf) / +ref /
#              :ref / --delete / -d / --mirror / the GitLab auto-merge push option
#   git        --no-verify (any subcommand, unique abbreviations included),
#              `git commit -n`, `-c core.hooksPath=...`
#   git stash  everything except `list` and `show` (read-only); the shared
#              refs/stash is not worktree-scoped, use `scripts/wt stash`
#   git reset --hard, git clean with force
#   glab mr merge (also with -R/--repo first), glab api calls to a merge
#   endpoint or a GraphQL mergeRequestAccept mutation
#   rm -r / -rf aimed at /, ~, $HOME, ., .., *, .git or a top-level path
#   curl/wget piped into a shell
#   (blueprint#165) rm -r of an absolute path outside the project and the temp dirs, of the
#              project or a parent of it, or of ~/a/b (two levels under home)
#   (blueprint#165) `git diff|log|show --output=<file>` (writes a file)
#   (blueprint#165) a glab/curl/wget argument, or a heredoc in the same command, with a line
#              starting `/merge` or `/merge_when_pipeline_succeeds` (GitLab quick action)
#   (blueprint#165) Bash writes (`>`/`>>`, tee, sed -i, perl -i, cp/mv/install onto, rm, chmod,
#              truncate, dd of=) to .claude/settings*.json, .claude/hooks/** and the
#              top-level hooks/**. The Edit/Write deny rules do not cover Bash.
#   (blueprint#168) the same writes to the INSTALLED hooks (.git/hooks/**, any spelling, including
#              `$(git rev-parse --git-common-dir|--git-dir|--git-path hooks)` and the main
#              checkout's absolute path) and to .git/config / config.worktree (core.hooksPath);
#              `git config include.path`, `git -c include.path=`, GIT_CONFIG_GLOBAL/SYSTEM
#   (blueprint#168) mv/rm of the project's .git, the project root or a directory above it, and
#              cp/rsync/scp of a .git directory onto the project root or its .git (as final as
#              rm -rf .git). From a session inside a linked worktree, the main checkout that owns
#              the shared .git (found through the worktree's gitdir and commondir files) is
#              protected the same way.
#   (blueprint#168) a find that deletes or rewrites what it visits (-delete, -exec rm, -exec sh -c, -exec
#              chmod/truncate/sed -i ...) over /, ~, a top-level or system path, .., .git, or the
#              project itself without a narrowing test. Each -name/-path/-regex pattern is tried
#              against sample paths the way find applies it (basename for -name, case folded for
#              the -i forms, a full match for -regex): one that matches .git, the hooks or the
#              settings is denied, and one that matches every ordinary path (`-path './*'`,
#              `-regex '.+'`) does not narrow. Only those tests and -empty narrow, and only with
#              no -o, ! or -not; -type, -mtime, -newer and -size do not. So
#              `find . -name '*.pyc' -delete` stays allowed. A wrapper in front of the -exec
#              command (`-exec env rm`, `-exec timeout 9 rm`) is looked through.
#   (blueprint#168) `rsync --delete` (any --del* option) onto the project root, a parent of it, .git or
#              .claude, and `rsync --remove-source-files` from a protected path; the destination
#              is the last operand after option values are skipped (`--exclude node_modules`)
#   (blueprint#168) a command word produced by a substitution (`$(which git) push`, `$(echo rm) -rf`,
#              `"$(which git)"`, a backtick word), also behind sudo/env/timeout/nice and the like;
#              a substitution that only prefixes a literal path (`$(npm bin)/eslint`) is fine,
#              because the basename is inspected
#   (blueprint#168) busybox/toybox applets, `env -S '...'` and `flock -c '...'` (the string is re-split
#              and checked), `tar -x`/`unzip` of a protected member named on the command line or
#              into .git, .claude or a protected cwd, scp, `cpio -i`/`cpio -p DEST`,
#              gtar/bsdtar/ditto/xxd/uniq/base64 -o/
#              awk -i inplace/gunzip and the like, `git clone`/`checkout-index --prefix` into a
#              protected path, `git -C DIR rm`, and `ln` whose source is the project, .git or a hook
#   (blueprint#168) an unquoted $( ) or backtick in the middle of a command is one word, so it no longer
#              hides the options after it (`git push $(true) --force`), and one glued to an
#              option counts as that option (`--force$(true)`); a git subcommand from one is denied.
#              `$(( ... ))` arithmetic is one inert word; only the substitutions inside it run.
#   (blueprint#168) a shell or `source` reading /dev/stdin, /dev/fd/N or `-`, and `sh -c` with no script
#   (blueprint#168) a /merge body that is URL-encoded or JSON-escaped, printed by echo/printf inside a
#              command substitution, or read from a file (`-d @f`, `-F body=@f`, `--input f`,
#              `< f`, `$(cat f)`, `glab mr note -F f`): the file on disk, or the heredoc/echo/
#              printf that wrote it earlier on the same line; and an echo/printf substitution
#              glued to literal text (`"$(echo /mer)ge"`)
#
# Matching is by path, not by name: operands are normalized (`..`, `//`, `./`), case-folded,
# brace-expanded (`.cla{ude,}/hooks`), glob-matched (`.claude/h*/x`), resolved against the
# working directory (the event cwd, and since blueprint#168 any literal `cd DIR`/`pushd DIR` earlier on
# the line), and reduced to the project root (CLAUDE_PROJECT_DIR, the git top level above the
# cwd, and the cwd). A `( ... )` or `$( ... )` ends its own cd; `cd -` and `popd` go back; a cd
# to an unknown target (`cd "$D"`) falls back to project-relative matching. After `cd DIR ;` (or
# `||`, or a newline), and after the `;` that ends a `cd DIR && ...` list or the `fi`/`done` of
# `if cd DIR; then`, the cd may have failed, so operands are judged in BOTH directories;
# `cd DIR || exit` counts as succeeded. Wrappers (env, sudo, timeout, flock, xargs, nice, busybox, ...) are looked
# through. A quoted ">" is never a redirect. One writer table (write_hit) serves the tamper
# guard and `find -exec`, so the two cannot drift (blueprint#168). `find` and `tar` are denied only when
# they write; `ln` when the link is protected or its source is the project, .git or a hook;
# `git rm|mv`, `git format-patch|archive -o` and `git bundle create` on a protected path.
# In `case WORD in PAT) ...;; esac`, WORD and the patterns are data, not command words.
#
# Warned, not denied (blueprint#168): a cd that may have failed (the cases above) followed later on the
# line by a command that changes
# files (any command in the writer table, a mutating git subcommand, a script, make; the list
# is built from the same table as the tamper guard, so it cannot drift). The hook exits 0 with
# hookSpecificOutput.additionalContext saying to chain with `&&`. A deny would block every
# `cd x; make` in the project. The cases that destroy the repository or the hooks (.git, the
# project root, protected files) are already denied by the two-directory rule above. What is
# left is not always recoverable: `git checkout -- .`, `git clean`-like scripts or an `rm` of
# untracked files in the wrong directory lose work that git never had. The warning is a nudge
# toward `&&`, not a guarantee; that residue is an accepted miss.
#
# Home and project spellings count: `~/`, `$HOME/`, `$PWD/`, `$(pwd)/`,
# `$(git rev-parse --show-toplevel)/` and `$CLAUDE_PROJECT_DIR/` reach the project's hooks/.
# A heredoc or here-string piped into a `glab`/`curl`/`wget` post is checked for a `/merge` line.
#
# Accepted misses (blueprint#168), each with the control that covers it or the reason it is final:
#   - tools that write the files themselves: `python3 -c`, `node -e`, `make`, `awk` or
#     `sed 'w file'` programs, `git checkout|restore|apply`, `patch < x.diff`, and `tar -xf` /
#     `unzip` of a whole archive (the member names are inside it). Final: the write happens
#     inside a program the hook does not parse. Covered for the tracked files (hooks/**,
#     .claude/hooks/**, .claude/settings.json) by the MR diff a person reviews; for the
#     installed .git/hooks by CI, whose jobs are the merge-blocking copy of the local gates
#     (the git hooks are only the earliest catch). .claude/settings.local.json is untracked
#     and has no second control.
#   - a path or a command held in a variable (`f=hooks/x; echo > $f`, `cd "$D"`, `sudo $G`),
#     except `$VAR/hooks/...`, and a cd through `cd -`, `popd` or a function. Final: the
#     value exists only at run time. Same review and CI controls as above.
#   - `HOME=/tmp/x` or `XDG_CONFIG_HOME=/tmp/x git commit` reading a crafted config with
#     core.hooksPath, `GIT_DIR=`/`--git-dir=` pointing git at another repository (and its hooks),
#     and `GIT_EXEC_PATH`. Final: these overrides are routine in test commands. Covered by CI.
#   - a symlink to the project, .git or a hook that already exists before the line runs (one
#     made on the line with `ln` is denied). Final: the hook reads text, not the filesystem
#     layout; it does not resolve every operand with realpath.
#   - names that reach a remover or a writer on stdin (`find / -print0 | xargs -0 rm -rf`,
#     `git ls-files -z | xargs -0 sed -i ...`). Final: the names exist only at run time; the
#     opt-in sandbox (blueprint#104) bounds writes when enabled, and the MR diff covers tracked files.
#   - arguments produced by a substitution (`git push $(echo --force)`, `git push origin
#     "$(echo +main)"`). Final: `git push origin $(git branch --show-current)` is routine, and
#     the value exists only at run time. A force push to main or production is still refused
#     by the remote's protected-branch settings; on a feature branch nothing else stops it.
#   - copying a directory whose contents include a .git over the project root (`cp -r
#     /tmp/tpl/. .`, `rsync -a /tmp/tpl/ .`). Final: the contents are not in the command text.
#   - a /merge body from a variable (`-m "$BODY"`), from another command's output
#     (`$(git log -1 --format=%B)`), or from a file another program writes earlier on the same
#     line. Final: the text exists only at run time.
#   - a sibling worktree's hooks/ other than hooks/pre-commit and hooks/pre-push (blueprint#165)
#   - `rm -r` of a path three or more levels under home that is not the project or above it
#     (there is no sensitivity list, so `rm -rf ~/.ssh/keys/old` is allowed), and a sibling
#     worktree or project outside home that sits under no directory the hook knows (blueprint#165)
#   - (blueprint#197) four classes where the scanner and a shell disagreed about which
#     text is a command are now closed by denying: a `#` is a comment only after an unescaped
#     source blank or separator (blueprint#209); a `"` inside a double-quoted `${ }`
#     (blueprint#210), a heredoc body line starting with `)` inside a `$( )`
#     (blueprint#211) and a `<<` inside `[[ ]]` (blueprint#212) are denied.
# Over-matches kept on purpose (a person runs these in their own shell): `chmod`, `mkdir` or
# `touch` on `.claude/hooks`; the `.claude/hooks` or `.claude/settings.json` names under any
# directory; `$VAR/hooks/...` for any variable; `/any/dir/hooks/pre-commit|pre-push` (so
# `cp x /tmp/hooks/pre-commit` is denied); any glab/curl/wget argument that starts with
# `/merge` (so `glab mr list --search "/merge"` is denied); (blueprint#168) writes to any .git/hooks or
# .git/config, a scratch repo's included (`ln -s hooks/pre-commit .git/hooks/pre-commit` is
# denied: run `make setup`); `/merge` anywhere in an echo/printf inside a post's substitution;
# the `;`-after-cd warning inside a loop too (`for d in a b; do cd $d; make; done`); a relative
# path after an unknown cd matched against the project root; a link to a hook (`ln -s
# hooks/pre-commit /tmp/x`); removing anything in .git but a *.lock file; a deleting find whose
# pattern matches a protected sample anywhere (`-name config`, `-name '*.sh'`, which would
# reach .claude/hooks), including `-exec chmod +x` writers, or that uses -o/!/-not (so `find . -path ./.git -prune -o -name '*.pyc' -delete` is
# denied: write `find . -name '*.pyc' -delete`); a post body file over 1 MiB; a gzip-family
# command on a protected operand without -c/-k; and an operand checked in both directories
# after `cd DIR ;`, so `cd /tmp/s ; mv .git x` is denied (write `cd /tmp/s && mv .git x`).
# Read-only `git config` (a --get/--list flag, or a lone key) is allowed; any other form that names
# alias.*, core.hooksPath, include.* or a push option is treated as a write, even when it only reads.
# `-u<mode>` on `git commit` is --untracked-files, and the values of -m/-F/-C/-c/-t are text, so
# `git commit -m "stop advertising --no-verify"` is allowed.
#
# Allowed on purpose: --force-with-lease, --force-if-includes, ordinary
# pushes, `git stash list|show`, `git clean -n`, `rm -rf "$TMP"`.
#
# Nested code is scanned too: $(...), backticks, `bash -c '...'`, `eval ...`, `env -S '...'`.
# Heredoc bodies are skipped (a commit message may quote a denied command); since blueprint#168 a $( )
# or backtick in a heredoc runs only when its delimiter is unquoted (<<EOF), as in the shell, so
# a commit message under <<'EOF' may quote `git push --force` in backticks. That holds inside
# `"$(cat <<'EOF' ... EOF)"` too: the `)` that closes a $( ) is found with quoted text and heredoc
# bodies skipped, so a body line such as `1) item`, `:)`, an unbalanced `(` or `don't` neither
# closes it early nor fails to parse.
#
# Heredocs (blueprint#197): the heredoc scan accepts a small grammar and denies the rest,
# instead of guessing how each shell reads an unusual shape (the four classes where the scanner and
# some shell disagreed, blueprint#209 to blueprint#212, are closed by denying). A delimiter word is one or
# more segments with nothing between them, each an unquoted run of [A-Za-z0-9_], or '...' or "..."
# holding only [A-Za-z0-9_.:/-]; it ends at a blank, a newline, ; & | < > or the end of the command.
# Removing the quotes gives the delimiter (`<<E"O"F` and `<<'E'OF` end at a line `EOF`, `<<EOF'X'`
# at `EOFX`), and a quote anywhere makes the body literal. Any other word is denied (a backslash,
# `$`, `${ }`, `$[ ]`, `$'..'`, a backtick, a glob or brace character, `#`, a blank inside quotes,
# no word at all): rewrite it as a plain word such as EOF. The terminator is the line equal to the
# delimiter (leading tabs stripped for `<<-`). Bash and ksh also end a body inside a `$( )`, `<( )`
# or `( )` at some lines that only start with the delimiter (`EOF )`, `EOF);`), so in a substitution's
# own text, or once the command has opened a `(` or a backtick, a body line that starts with the
# delimiter but is not exactly it is denied. A backtick substitution is cut at its closing backtick
# first, as the shell does, so a heredoc in it ends there. In `$(( ))`, `(( ))` and `$[ ]` a `<<` is
# a shift, and a `)` that closes no `(` is denied (bash may read the `((` as nested subshells, where
# `<<` starts a heredoc); a `<<` in `${ }` and bash 5.3's `${ cmd; }` are denied. A `$( )` or
# backtick inside `${ }`, arithmetic or double quotes is scanned on its own with the same rules, so
# the scan does not end the outer text at a quote or `)` in its heredoc body; a `case` statement
# inside a `$( )` is denied, since its `pat)` would end the scan's `$( )` early. The text of a
# backtick substitution is unescaped as the shell does (`\$`, `\``, `\\` lose the backslash) before
# it is checked, so an escaped backtick nests a checked substitution; a `\"` in one inside double
# quotes is denied. In an unquoted body quotes are literal text, so `it's $(cmd)` is checked, and a
# body line that ends in a backslash is denied (the shell joins it with the next line before it
# looks for the terminator). Also denied: a heredoc with no terminator line, a heredoc whose
# enclosing `$( )` or `( )` closes before its body starts, and an unbalanced `$(( ))`, `(( ))`,
# `${ }`, `$[ ]`, `$( )` or backtick. The cost is over-denial of some valid commands (an exotic
# delimiter such as `<<\EOF`, `$(case ... esac)`, `${x:-<<y}`; see docs/harness/pre-bash-deny.md);
# scripts/tests/pre-bash-deny.test.sh says which shells each deny case was replayed in.
#
# Fails closed: no python3, an unreadable event, or an unparseable command
# all deny, because a silent allow is the failure this hook exists to stop.

set -uo pipefail

if ! command -v python3 >/dev/null 2>&1; then
  echo "pre-bash-deny: python3 is required to inspect Bash commands and was not found; denying (fail closed). Install python3." >&2
  exit 2
fi

LIB="$(dirname "${BASH_SOURCE[0]}")/lib/pre_bash_deny.py"
if [ ! -f "$LIB" ]; then
  echo "pre-bash-deny: decision logic $LIB is missing; denying (fail closed)." >&2
  exit 2
fi

exec python3 -I "$LIB"
