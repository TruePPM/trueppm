#!/usr/bin/env bash
# PreToolUse hook (matcher: "Bash") — before Claude runs a `glab mr create`
# command, inspect the branch diff and BLOCK the command until the gates the
# diff needs have run: rbac-check + security-review when API views, serializers,
# permissions, urls, consumers/routing, auth, sync or upload paths changed;
# broadcast-check when API code that can be a write path changed (the agent
# decides whether the resource is board-scoped and may record n/a). Web-,
# scheduler-, mcp-, test- and docs-only diffs are never blocked.
#
# ## Why PreToolUse, not UserPromptSubmit (issue #4867; same fix as macrodream/blueprint#11)
#
# This hook used to run on UserPromptSubmit and match the literal string
# "/mr" in the user's prompt. That never fired for an agent that opens the MR
# by reproducing `glab mr create` directly, which is exactly what CLAUDE.md
# tells every agent to do (`/mr` is `disable-model-invocation: true`), and it
# started a subprocess on every message for nothing. PreToolUse with a Bash
# matcher fires on the real event — the command that creates the MR — and a
# non-MR Bash call exits after one python tokenize (no diff is ever computed).
#
# Tradeoff: PreToolUse only fires once `glab mr create` is already assembled,
# so the message is "stop — run these first, then retry", not a heads-up.
#
# ## Output contract
#
# To BLOCK and hand Claude a message, a PreToolUse hook returns
# `permissionDecision: "deny"` with a `permissionDecisionReason`; that cancels
# the tool call and feeds the reason back so Claude can adjust and retry
# (https://code.claude.com/docs/en/hooks).
#
# ## Marker file (the opt-out)
#
# A retry is allowed only when a marker file for the CURRENT HEAD sha exists:
#
#   .claude/state/pre-mr-gate   ("<head-sha> <ran|skipped> <utc-timestamp> <worktree-hash>")
#
# It is written by this script's own `record` mode, run after the gates:
#
#   .claude/hooks/pre-mr-security-gate.sh record ran
#   .claude/hooks/pre-mr-security-gate.sh record skipped   # user said to skip
#   .claude/hooks/pre-mr-security-gate.sh record na        # gates ran/judged and do not apply
#
# `skipped` and `na` are distinct, recorded states so the MR's `## Gates` ledger
# says `skipped` (applied, user declined) or `n/a` (does not apply), never `0 findings`. Committing moves HEAD and so invalidates
# the marker; a fourth field fingerprints uncommitted work, so editing after
# the gates ran invalidates it too. The marker is agent-written, so it is a
# visible, auditable record and not a security boundary.
#
# ## Command detection
#
# The command is tokenized with shlex (python3). Contents of quoted arguments
# are never inspected, so prose in a --description cannot match or bypass.
# Detected forms: `glab [global flags] mr create`, behind wrappers (`env`,
# `command`, `sudo`, `time`, ...), in subshells and `$( )`, under
# `bash|sh|zsh -c "..."` and `eval` (recursively), `git push -o
# merge_request.create`, and `glab api -X POST .../merge_requests`.
#
# ## Fails closed
#
# If jq or python3 is missing the hook cannot parse the event. It then blocks
# (exit 2, message on stderr) any input that looks like `glab mr ...`,
# `glab api ...` or mentions `merge_request`, rather than exiting 0.

set -uo pipefail

STATE_REL=".claude/state/pre-mr-gate"

# $1: the work tree to resolve (default: the current directory). The hook passes the tree
# of the branch the MR opens, which is not always its own cwd.
state_file() {
  local top
  top="$(git -C "${1:-.}" rev-parse --show-toplevel 2>/dev/null)" || return 1
  printf '%s/%s\n' "$top" "$STATE_REL"
}

# Fingerprint of uncommitted work (tracked diff + untracked file names), so
# edits made after the gates ran also invalidate the marker, not just a commit.
tree_fingerprint() {
  local d="${1:-.}"
  { git -C "$d" diff HEAD 2>/dev/null; git -C "$d" ls-files -o --exclude-standard -- ':!.claude/state' 2>/dev/null; } | git hash-object --stdin
}

# ── record mode: the gate run writes the marker keyed to HEAD ───────────
if [[ "${1:-}" == "record" ]]; then
  status="${2:-}"
  if [[ "$status" != "ran" && "$status" != "skipped" && "$status" != "na" ]]; then
    echo "usage: pre-mr-security-gate.sh record <ran|skipped|na>" >&2
    exit 64
  fi
  if ! file="$(state_file)" || ! head_sha="$(git rev-parse HEAD 2>/dev/null)"; then
    echo "pre-mr-security-gate: not in a git repo with a HEAD commit; cannot record." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$file")"
  printf '%s %s %s %s\n' "$head_sha" "$status" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(tree_fingerprint)" >"$file"
  echo "pre-mr-security-gate: recorded '$status' for ${head_sha:0:12}."
  if [[ "$status" == "na" ]]; then
    echo "Put 'gate: <name> — n/a (<why it does not apply>)' (not 'skipped') for the gates that do not apply in the MR's ## Gates section." >&2
  fi
  if [[ "$status" == "skipped" ]]; then
    echo "Put 'gate: <name> — skipped' (not '0 findings') for rbac-check, broadcast-check and security-review in the MR's ## Gates section." >&2
  fi
  exit 0
fi

input="$(cat 2>/dev/null || true)"

# Fail CLOSED when the parsers are missing (see header).
missing=()
command -v jq >/dev/null 2>&1 || missing+=("jq")
command -v python3 >/dev/null 2>&1 || missing+=("python3")
if [[ "${#missing[@]}" -gt 0 ]]; then
  if grep -qE 'glab[^"]*[[:space:]](mr|api)([[:space:]]|")|merge_request' <<<"$input"; then
    {
      echo "Pre-MR security gate: BLOCKED because ${missing[*]} is not installed or not on PATH."
      echo "This hook cannot inspect the command without it, and fails closed rather than open."
      echo "Install ${missing[*]}, then retry."
    } >&2
    exit 2
  fi
  exit 0
fi

tool_name="$(jq -r '.tool_name // empty' <<<"$input" 2>/dev/null || true)"
bash_command="$(jq -r '.tool_input.command // empty' <<<"$input" 2>/dev/null || true)"

# Defensive — the "Bash" matcher in settings.json already restricts which
# events reach this script, but a widened matcher must not silently apply
# MR-detection logic to a non-Bash tool call.
if [[ "$tool_name" != "Bash" || -z "$bash_command" ]]; then
  exit 0
fi

# Is this command (or anything nested in it) an MR-creating invocation?
# The detector is held in a variable (not a heredoc inside $( )) because bash 3.2
# on macOS mis-parses quotes inside a heredoc nested in a command substitution.
IFS= read -r -d '' DETECTOR <<'PYEOF' || true
import re
import shlex
import sys

command = sys.argv[1] if len(sys.argv) > 1 else ""

SEPARATORS = {";", "&", "&&", "|", "||", "|&", "(", ")", "\n", ";;", ";&"}
REDIRECTS = {"<", ">", ">>", "<<", "<<<", ">&", "<&", ">|", "<>", "&>", "&>>"}
KEYWORDS = {"{", "}", "!", "if", "then", "else", "elif", "do", "while", "until", "time"}
# wrapper -> flags that consume the next word
WRAPPERS = {
    "env": {"-u", "-C", "-S"},
    "command": set(),
    "exec": {"-a"},
    "nohup": set(),
    "sudo": {"-u", "-g", "-C", "-h", "-p", "-U", "-D", "-R", "-T"},
    "nice": {"-n"},
    "builtin": set(),
    "timeout": {"-s", "-k"},
    "xargs": {"-I", "-n", "-P", "-L", "-d", "-E", "-s"},
    "stdbuf": {"-i", "-o", "-e"},
    "setsid": set(),
}
SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}


def strip_heredocs(text):
    """Blank out heredoc body lines (the shape /mr emits). Returns the
    cleaned text plus the bodies of heredocs fed to a shell (`bash <<EOF`),
    which are commands and must be scanned."""
    out, bodies, delim, shell, buf = [], [], None, False, []
    for line in text.split("\n"):
        if delim is not None:
            if line.strip() == delim:
                delim = None
                if shell:
                    bodies.append("\n".join(buf))
                buf = []
            else:
                buf.append(line)
            continue
        m = re.search(r"(?<!<)<<(?!<)-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1", line)
        if m:
            delim = m.group(2)
            shell = re.search(r"\b(bash|sh|zsh|dash|ksh|eval)\b", line[: m.start()]) is not None
        out.append(line)
    return "\n".join(out), bodies


def substitutions(text):
    """Bodies of $( ) and backtick command substitutions, wherever they
    appear (bash runs them even inside double quotes). Over-approximate on
    purpose: this fails closed."""
    found = [m.group(1) for m in re.finditer(r"`([^`]*)`", text)]
    i = 0
    while True:
        i = text.find("$(", i)
        if i < 0:
            break
        depth, j = 1, i + 2
        while j < len(text) and depth:
            depth += {"(": 1, ")": -1}.get(text[j], 0)
            j += 1
        found.append(text[i + 2 : j - 1])
        i += 2
    return found


def tokenize(text):
    text = text.replace("\\\n", " ")
    lex = shlex.shlex(text, posix=True, punctuation_chars=";&|()<>\n")
    lex.whitespace = " \t\r"
    lex.whitespace_split = True
    lex.commenters = ""
    return list(lex)


def statements(tokens):
    cur, skip = [], False
    for t in tokens:
        if t in SEPARATORS:
            if cur:
                yield cur
            cur, skip = [], False
        elif t in REDIRECTS:
            skip = True
        elif skip:
            skip = False
        else:
            cur.append(t.strip("`"))
    if cur:
        yield cur


def base(word):
    return word.rsplit("/", 1)[-1]


def is_assign(w):
    return re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w) is not None


def glab_hit(args):
    # args are everything after `glab`. Skip global flags (value-taking ones
    # consume the next word) to find the subcommand path.
    words, i = [], 0
    method, has_fields = None, False
    while i < len(args):
        a = args[i]
        if a in ("-R", "--repo", "--hostname"):
            i += 2
            continue
        if a.startswith(("--repo=", "--hostname=")):
            i += 1
            continue
        if a in ("-X", "--method") and i + 1 < len(args):
            method = args[i + 1].upper()
            i += 2
            continue
        m = re.match(r"^-X(\w+)$", a)
        if m:
            method = m.group(1).upper()
        elif a.startswith("--method="):
            method = a.split("=", 1)[1].upper()
        elif re.match(r"^(-[fF].*|--field(=.*)?|--raw-field(=.*)?|--input(=.*)?)$", a):
            has_fields = True
        elif a.startswith("-"):
            pass
        else:
            words.append(a)
        i += 1
    if len(words) >= 2 and words[0] == "mr" and words[1] in ("create", "new"):
        return True
    if words and words[0] == "api":
        post = method == "POST" or (method is None and has_fields)
        if post and any(re.search(r"merge_requests/?(\?.*)?$", w) for w in words[1:]):
            return True
    return False


def git_hit(args):
    i, sub = 0, None
    while i < len(args):
        a = args[i]
        if a in ("-C", "-c", "--git-dir", "--work-tree", "--namespace"):
            i += 2
            continue
        if a.startswith("-"):
            i += 1
            continue
        sub = a
        i += 1
        break
    if sub != "push":
        return False
    rest = args[i:]
    for j, a in enumerate(rest):
        if a in ("-o", "--push-option") and j + 1 < len(rest) and rest[j + 1].startswith("merge_request.create"):
            return True
        if a.startswith("--push-option=merge_request.create") or a.startswith("-omerge_request.create"):
            return True
    return False


def check_statement(words, depth):
    i = 0
    while i < len(words):
        w = words[i]
        if is_assign(w) or w in KEYWORDS:
            i += 1
            continue
        b = base(w)
        if b in WRAPPERS:
            i += 1
            # skip the wrapper's own flags / assignments / duration
            while i < len(words) and (words[i].startswith("-") or is_assign(words[i])):
                if words[i] in WRAPPERS[b]:
                    i += 1
                i += 1
            if b == "timeout" and i < len(words):
                i += 1
            continue
        break
    if i >= len(words):
        return False
    b, args = base(words[i]), words[i + 1:]
    if b == "glab":
        return glab_hit(args)
    if b == "git":
        return git_hit(args)
    if b in SHELLS:
        for j, a in enumerate(args):
            if re.match(r"^-[A-Za-z]*c[A-Za-z]*$", a) and j + 1 < len(args):
                return scan(args[j + 1], depth + 1)
        return False
    if b == "eval":
        return scan(" ".join(args), depth + 1)
    return False


def scan(text, depth=0):
    if depth > 5:
        return True  # fail closed on pathological nesting
    cleaned, bodies = strip_heredocs(text)
    if any(scan(b, depth + 1) for b in bodies):
        return True
    if any(scan(sub, depth + 1) for sub in substitutions(cleaned)):
        return True
    try:
        tokens = tokenize(cleaned)
    except ValueError:
        # Unparseable: fail closed if it looks like MR creation at all.
        return re.search(r"glab.*\b(mr|merge_requests)\b|merge_request\.create", cleaned, re.S) is not None
    return any(check_statement(s, depth) for s in statements(tokens))


print("1" if scan(command) else "0")
PYEOF
is_mr_create="$(python3 -I -c "$DETECTOR" "$bash_command")"

# The detector must answer explicitly. An empty or odd answer (a python3 shim
# that exists but cannot run, a crash) must not read as "not an MR command".
if [[ "$is_mr_create" != "0" && "$is_mr_create" != "1" ]]; then
  echo "Pre-MR security gate: BLOCKED because the command detector (python3) failed to run." >&2
  echo "Fix python3 (it must be able to run 'python3 -I -c \"print(1)\"'), then retry." >&2
  exit 2
fi

# Not an MR-creating command at all — the common case, and cheap: no diff
# was ever computed.
if [[ "$is_mr_create" != "1" ]]; then
  exit 0
fi

# ── Which tree does this MR open? ──
# Never the hook process's own directory: an orchestrator may open a worker's MR
# from the main checkout, and a diff taken there is empty, so the gate silently stopped
# firing. In order: `--source-branch B` / `-s B` (refs are shared, so diff origin/main...B,
# and read the marker in the worktree that has B checked out); a literal `cd DIR &&` before
# the glab call; the event's `cwd`. A cd to a run-time path fails closed. Fields are split
# on \x1f, not a tab: IFS whitespace would collapse the empty leading fields.
IFS= read -r -d '' TARGETER <<'PYEOF' || true
import re
import shlex
import sys

# Prints branch \x1f cd_dir \x1f unknown \x1f found. unknown=1 means a glab mr create was seen
# (or implied) but which tree it opens cannot be told from the text: the hook then DENIES.
cmd = sys.argv[1] if len(sys.argv) > 1 else ""
SEP = {";", "&", "&&", "|", "||", "|&", "(", ")", "\n"}
WRAP = {"env", "command", "nohup", "time", "sudo", "doas", "nice", "timeout", "exec", "builtin", "stdbuf", "setsid", "xargs"}
GLAB_VAL = set("abdlmstep")  # glab mr create short options that take a value
try:
    lex = shlex.shlex(cmd.replace("\\\n", " "), posix=True, punctuation_chars=";&|()<>\n")
    lex.whitespace = " \t\r"
    lex.whitespace_split = True
    lex.commenters = ""
    toks = list(lex)
except ValueError:
    print("\x1f\x1f1\x1f0")
    sys.exit(0)
seq, cur = [], []
for t in toks:
    if t in SEP:
        seq.append((cur, t))
        cur = []
    else:
        cur.append(t)
seq.append((cur, ""))


def base(w):
    return w.rsplit("/", 1)[-1]


def source_branch(args):
    """The LAST --source-branch value, as glab takes it (`-s B -s C` opens C)."""
    k, found = 0, ""
    while k < len(args):
        a = args[k]
        if a in ("-s", "--source-branch"):
            found = args[k + 1] if k + 1 < len(args) else ""
            k += 2
            continue
        if a.startswith("--source-branch="):
            found = a.split("=", 1)[1]
        elif a.startswith("-") and not a.startswith("--") and len(a) > 1:
            for j, ch in enumerate(a[1:], 1):
                if ch == "s":
                    rest = a[j + 1:].lstrip("=")
                    if rest:
                        found = rest
                    else:
                        found = args[k + 1] if k + 1 < len(args) else ""
                        k += 1
                    break
                if ch in GLAB_VAL:
                    if j == len(a) - 1:
                        k += 1  # its value is the next word
                    break
        k += 1
    return found


branch, cd_dir, unknown, found, last_cd, any_cd = "", "", "0", "0", None, False
for words, sep in seq:
    # `{ cd /a; glab mr create; }`, `! cmd`, `then cmd`: the grouping word is not the command.
    words = list(words)
    while words and words[0] in ("{", "}", "!", "then", "do", "else", "elif", "if", "while", "until"):
        words.pop(0)
    if not words:
        continue
    if base(words[0]) in ("cd", "pushd", "popd"):
        any_cd = True
        last_cd = (words[1] if len(words) > 1 else "~") if sep == "&&" and base(words[0]) != "popd" else None
        continue
    g = next((i for i, w in enumerate(words) if base(w) == "glab"), None)
    if g is not None and not all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", w) or base(w) in WRAP
                                 or re.fullmatch(r"[0-9.]+[smhd]?", w) for w in words[:g]):
        # A glab behind a prefix the scan cannot read (`env -u X`, `env -C /a`, any wrapper
        # option) may run in another directory: unknown, so the hook denies.
        unknown, found = "1", "1"
        break
    if g is not None:
        args, k, pos = words[g + 1:], 0, []
        while k < len(args):
            a = args[k]
            if a in ("-R", "--repo", "--hostname"):
                k += 2
                continue
            if not a.startswith("-"):
                pos.append(a)
            if len(pos) == 2:
                break
            k += 1
        if pos[:1] == ["mr"] and pos[1:2] in (["create"], ["new"]):
            found = "1"
            branch = source_branch(args[k + 1:])
            if last_cd is not None:
                if not last_cd or re.search(r"[$`*?~]", last_cd):
                    unknown = "1"
                else:
                    cd_dir = last_cd
            elif any_cd:
                unknown = "1"  # a cd that may or may not have applied (`cd /a; glab mr create`)
            break
    if sep != "&&":
        last_cd = None
if found == "0" and any_cd:
    unknown = "1"  # MR creation the scan cannot place (bash -c, eval, git push -o) after a cd
print(branch + "\x1f" + cd_dir + "\x1f" + unknown + "\x1f" + found)
PYEOF
src_branch="" cd_dir="" cd_unknown="0"
mr_found="0"
IFS=$'\x1f' read -r src_branch cd_dir cd_unknown mr_found < <(python3 -I -c "$TARGETER" "$bash_command") || true
if [[ "${mr_found:-0}" != "1" ]]; then
  # The MR is created somewhere the scan cannot place a glab segment (bash -c, eval,
  # git push -o merge_request.create, glab api): the tree is the event cwd, and the
  # default-branch check below still denies it from the main checkout.
  src_branch="" cd_dir=""
fi

deny_target() {
  jq -n --arg reason "Pre-MR security gate (.claude/hooks/pre-mr-security-gate.sh): $1" '{
    hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason}
  }'
  exit 0
}

event_cwd="$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null || true)"
base_dir="${event_cwd:-$PWD}"
target_dir="$base_dir"   # the work tree whose uncommitted changes and marker count; empty: none
target_ref="HEAD"
if [[ "${cd_unknown:-0}" == "1" ]]; then
  deny_target "cannot tell which branch this MR opens: the cd before glab names a run-time path. Run glab mr create from the branch's worktree, or pass --source-branch <branch>."
fi
if [[ -n "${src_branch:-}" ]]; then
  target_ref="refs/heads/$src_branch"
  git -C "$base_dir" rev-parse --verify --quiet "$target_ref" >/dev/null 2>&1 || target_ref="refs/remotes/origin/$src_branch"
  git -C "$base_dir" rev-parse --verify --quiet "$target_ref" >/dev/null 2>&1 \
    || deny_target "--source-branch $src_branch is not a local or origin branch here; fetch or push it, then retry."
  target_dir="$(git -C "$base_dir" worktree list --porcelain 2>/dev/null | awk -v b="branch refs/heads/$src_branch" '/^worktree /{p=substr($0,10)} $0==b{print p}' | sed -n 1p)"
  # With no worktree the marker cannot be read; deny
  # rather than skip the check.
  [[ -n "$target_dir" ]] || deny_target "no worktree has --source-branch $src_branch checked out, so its gate marker cannot be read. Open the MR while the branch's worktree exists."
elif [[ -n "${cd_dir:-}" ]]; then
  case "$cd_dir" in /*) target_dir="$cd_dir" ;; *) target_dir="$base_dir/$cd_dir" ;; esac
  git -C "$target_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || deny_target "the MR is opened after cd $cd_dir, which is not a git work tree; run it from the branch's worktree."
fi
git_dir="${target_dir:-$base_dir}"

# With no --source-branch, the MR opens the current
# branch of the resolved tree. On the default branch, or a detached HEAD, that is the
# main checkout talking about some other branch: deny rather than diff the wrong tree.
if [[ -z "${src_branch:-}" ]] && git -C "$git_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  cur_branch="$(git -C "$git_dir" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [[ -z "$cur_branch" || "$cur_branch" == "main" || "$cur_branch" == "master" ]]; then
    deny_target "this MR would open from ${cur_branch:-a detached HEAD} in $git_dir. Pass --source-branch <branch> ."
  fi
fi

# Diff vs the default branch + uncommitted. Bail silently if not a git repo / no main.
committed="$(git -C "$git_dir" diff --name-only "origin/main...$target_ref" 2>/dev/null || true)"
uncommitted=""
[[ -n "$target_dir" ]] && uncommitted="$(git -C "$target_dir" diff --name-only HEAD 2>/dev/null || true)"
all_changed="$(printf '%s\n%s\n' "$committed" "$uncommitted" | sort -u | sed '/^$/d' || true)"

if [[ -z "$all_changed" ]]; then
  exit 0
fi

# Which gates does this diff need? Only packages/api/src Python can be a view,
# serializer, permission, consumer or write path; web-, scheduler-, mcp-, test-,
# docs- and CI-only diffs are never blocked (CLAUDE.md fast-path table).
api_src="$(grep -E '^packages/api/src/.*\.py$' <<<"$all_changed" | grep -vE '(^|/)(migrations|tests?)/|(^|/)test_[^/]*\.py$|(^|/)conftest\.py$' || true)"
if [[ -z "$api_src" ]]; then
  exit 0
fi

# rbac-check + security-review: endpoints, serializers, permissions, realtime entry points, auth/input handling.
sensitive=0
if grep -qE \
  -e '(^|/)views[^/]*\.py$' \
  -e '(^|/)serializers[^/]*\.py$' \
  -e '(^|/)permissions[^/]*\.py$' \
  -e '(^|/)urls[^/]*\.py$' \
  -e '(^|/)consumers\.py$' \
  -e '(^|/)routing\.py$' \
  -e '(^|/)auth/' \
  -e '(^|/)sync/' \
  -e 'file_?handl' \
  -e '(^|/)uploads?/' \
  <<<"$api_src"; then
  sensitive=1
fi

# broadcast-check: anything that can be a write path. The hook cannot know whether the resource
# is board-scoped, so the agent decides and records n/a when it is not.
write_path=0
if grep -qE \
  -e '(^|/)views[^/]*\.py$' \
  -e '(^|/)serializers[^/]*\.py$' \
  -e '(^|/)models[^/]*\.py$' \
  -e '(^|/)services?[^/]*\.py$' \
  -e '(^|/)signals[^/]*\.py$' \
  -e '(^|/)tasks[^/]*\.py$' \
  -e '(^|/)consumers\.py$' \
  <<<"$api_src"; then
  write_path=1
fi

required=()
reason_line=""
if [[ "$sensitive" -eq 1 ]]; then
  required+=("rbac-check" "security-review")
  reason_line+="API views/serializers/permissions/urls/consumers/routing/auth/sync/upload paths changed — rbac-check and security-review are required. "
fi
if [[ "$write_path" -eq 1 ]]; then
  required+=("broadcast-check")
  reason_line+="API code that can be a write path changed — broadcast-check is required. This hook cannot tell whether the resource is board-scoped: you decide, and if it is not, record the gate as n/a. "
fi
if [[ "${#required[@]}" -eq 0 ]]; then
  exit 0
fi

# Marker check: gates recorded for exactly this branch tip (moving it invalidates), in the
# tree that has the branch checked out.
head_sha="$(git -C "$git_dir" rev-parse "$target_ref" 2>/dev/null || true)"
if [[ -n "$target_dir" ]] && file="$(state_file "$target_dir")" && [[ -f "$file" ]]; then
  read -r m_sha m_status _ m_tree <"$file" || true
  if [[ -n "$head_sha" && "${m_sha:-}" == "$head_sha" && "${m_tree:-}" == "$(tree_fingerprint "$target_dir")" ]]; then
    if [[ "${m_status:-}" == "ran" ]]; then
      exit 0
    elif [[ "${m_status:-}" == "skipped" ]]; then
      jq -n '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: "Security gates were recorded as SKIPPED for this HEAD. The MR ## Gates section must say `gate: <name> — skipped (<reason>)` for each required gate, not a findings count."}}'
      exit 0
    elif [[ "${m_status:-}" == "na" ]]; then
      jq -n '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: "Security gates were recorded as N/A for this HEAD. The MR ## Gates section must say `gate: <name> — n/a (<why it does not apply>)`, not `skipped` and not a findings count."}}'
      exit 0
    fi
  fi
fi

reason=$'Pre-MR security gate (.claude/hooks/pre-mr-security-gate.sh fired):\n\n'"$reason_line"$'\n\nThis MR-creating call is blocked until the required gates run. Run the following gates, in order, as a single parallel agent batch, then consolidate:\n\n'"$(printf -- '- %s\n' "${required[@]}")"$'\nFinding-handling rules:\n- Any 🔴 finding (including `unconfirmed:`) → do not retry this command. Surface the findings to the user and ask whether to proceed.\n- 🟡/🟢 findings → summarize inline, then proceed.\n\nOnce the gates have actually run against the current HEAD, record that and retry the same command:\n\n  .claude/hooks/pre-mr-security-gate.sh record ran\n\nIf a gate does not apply (e.g. the resource is not board-scoped), run `record na` and report `n/a (<why>)` in the MR ## Gates section. If the user explicitly told you to skip the gates, run `record skipped` instead and report `skipped` there; never use `skipped` for a gate that does not apply. The record is keyed to the current HEAD sha; a new commit invalidates it.'

jq -n --arg reason "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
