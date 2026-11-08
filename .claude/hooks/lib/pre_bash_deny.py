import json
import re
import shlex
import signal
import sys
import time
import os
from urllib.parse import unquote_plus

SHELLS = {"sh", "bash", "zsh", "dash", "ksh"}
WRAPPERS = {
    "env",
    "command",
    "sudo",
    "nohup",
    "time",
    "exec",
    "nice",
    "builtin",
    "setsid",
    "stdbuf",
    "timeout",
    "xargs",
    "find",
    "watch",
    "ionice",
    "flock",
    "caffeinate",
    "parallel",
    "doas",
    "chronic",
    "noglob",
    "nocorrect",
    "busybox",
    "toybox",  # multi-call binaries: `busybox sed -i ...` runs the applet named next (blueprint#168)
}
# Wrappers that run the next word as the command, and the options of each that take a value.
# Used to find the real command word behind them (blueprint#168): `sudo -u root $(which git) push`.
SIMPLE_WRAPPER_VALUE_OPTS = {
    "env": {"-u", "--unset", "-C", "--chdir", "-P"},
    "command": set(),
    "builtin": set(),
    "exec": {"-a"},
    "sudo": {
        "-u",
        "-g",
        "-C",
        "-D",
        "-h",
        "-p",
        "-r",
        "-t",
        "-U",
        "--user",
        "--group",
        "--chdir",
        "--host",
        "--prompt",
        "--role",
        "--type",
        "--other-user",
        "--close-from",
    },
    "doas": {"-u", "-C"},
    "nohup": set(),
    "time": {"-f", "-o", "--format", "--output"},
    "nice": {"-n", "--adjustment"},
    "setsid": set(),
    "stdbuf": {"-i", "-o", "-e", "--input", "--output", "--error"},
    "timeout": {"-s", "-k", "--signal", "--kill-after"},
    "ionice": {"-c", "-n", "-p", "--class", "--classdata", "--pid"},
    "chronic": set(),
    "noglob": set(),
    "nocorrect": set(),
    "caffeinate": {"-t", "-w"},
    "busybox": set(),
    "toybox": set(),
    # blueprint#168 security review: wrappers whose command word also comes after options or a positional.
    "xargs": {
        "-I",
        "-L",
        "-n",
        "-P",
        "-s",
        "-d",
        "-E",
        "-a",
        "--max-args",
        "--max-procs",
        "--delimiter",
        "--arg-file",
        "--replace",
    },
    "flock": {"-w", "--timeout", "-E", "--conflict-exit-code"},
    "watch": {"-n", "--interval", "-d"},
    "chroot": set(),
    "unshare": set(),
    "nsenter": {"-t", "--target"},
}
# Wrappers that take one positional argument (flock's lock file) before the command word.
WRAPPER_POSITIONALS = {"flock": 1}
# Shell reserved words and grouping that can precede a command in a segment.
KEYWORDS = {
    "{",
    "}",
    "!",
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "while",
    "until",
    "do",
    "done",
    "for",
    "case",
    "esac",
    "function",
}
WATCHED = {"git", "glab", "rm", "curl", "wget"} | SHELLS | {"eval"}
# Heredoc bodies are skipped by preprocess() but kept here: a note posted through
# `glab ... -m "$(cat <<EOF ... EOF)"` carries its text in one (blueprint#165).
HEREDOC_BODIES = []  # HEREDOC_BODIES[id] = lines of the id-th heredoc body
HEREDOC_QUOTED = []  # HEREDOC_QUOTED[id]: the delimiter was quoted, so the body is literal (no $(...) runs)
# cwds: where a relative path in the current segment may resolve. None is the session's own
# working directory; a string is a directory a `cd` earlier on the line moved to. A `cd` chained
# with `;` may have failed, so both stay possible (blueprint#168).
UNKNOWN = "\x00unknown"  # a cwd the text does not tell (`cd "$D"`); relative paths fall back to the project root
STATE = {
    "posts": False,
    "stdin_post": False,
    "tokens": [],
    "event_cwd": "",
    "cwds": [None],
    "warn": [],
    "heredoc_files": {},
    "subst": [],
    "oldpwd": None,
    "cdpath": bool(os.environ.get("CDPATH")),
}


def deny(msg):
    sys.stderr.write("pre-bash-deny: blocked. " + msg + "\n")
    sys.exit(2)


class Parse(Exception):
    pass


# --- /wave worker tier (blueprint#118, ADR 0010): an ALLOWLIST that fails closed ---
# A pinned /wave worker is an `isolation: worktree` subagent. The tier is on when the event names
# the agent (`agent_type: wave-worker`) OR its cwd lies under $CLAUDE_PROJECT_DIR/.claude/worktrees/.
# It holds in every permission mode: a subagent's permissionMode is ignored under an
# auto/acceptEdits/bypassPermissions parent, a hook is not. WORKER_ALLOWLIST_V2 marks this version
# (scripts/tests/wave-worker-pin.test.sh keys its round-2 cases on it).
#
# What the tier allows, and nothing else of these families:
#   wrappers   env (NAME=value, -i, -u only), time -p, nohup, nice -n, timeout, command, and find
#              without an action that runs or writes; every other wrapper (sudo, xargs, exec, ...)
#   git        the subcommands and options in WORKER_GIT_*; any other subcommand, global option,
#              or option of a write subcommand (abbreviations included) is denied
#   make       the options in WORKER_MAKE_*; a VAR=value argument is denied
#   glab       reads only (WORKER_GLAB_OK)
#   scripts/   check-* gates, scripts/tests/*, and `scripts/wt adopt|stash|list|harness-diff`;
#              .claude/hooks/* never
#   writes     only inside the worker's own worktree and outside the harness
#              (scripts/lib/harness-paths.txt), or in a scratch temp dir that is not a checkout
#   cd         only inside the worktree or a scratch temp dir; no `cd -`, `popd`, bare `pushd`
#   network    curl, wget, ssh, scp, sftp denied (hygiene; the sandbox, blueprint#104, contains)
# `scripts/wt harness-diff` is the deterministic backstop for writes this text scan cannot see
# (python3 -c, a test file, a build tool).
import fnmatch  # noqa: E402

WORKER = {"root": "", "harness": []}
WORKER_ALLOWLIST_V2 = True
WORKER_ALLOWLIST_V6 = True  # round 6 (2026-10-30): path carve-out tied to the tree, more env, config parsing
WORKER_ALLOWLIST_V5 = True  # round 5 (2026-10-30): exact git config reads, path commands, reset paths, loader vars
WORKER_ALLOWLIST_V4 = True  # round 4 (2026-10-30): no trap/hash, PATH/BASH_ENV/ENV, in-place rewriters, **/ names
# In-place rewriters: (subcommand or None, flags that make it write, flags that make it check-only,
# writes by default). A write form aimed at a harness path, or at the worktree root or above
# (a bare run defaults to `.`), is denied; the check-only forms are fine.
WORKER_REWRITERS = {
    "ruff": None,
    "black": None,
    "isort": None,
    "prettier": None,
    "eslint": None,
    "shfmt": None,
    "gofmt": None,
    "yq": None,
    "gunzip": None,
    "zip": None,
    "iconv": None,
    "mktemp": None,
}
WORKER_ALLOWLIST_V3 = True  # round 3 (2026-10-30): `--` after wrappers, a command-word allowlist, checkout/bisect, pathspecs
# Round 3: the command words a worker may run besides git/glab/make, the shells and interpreters
# (script argument checked) and a path-invoked command (the scripts/ allowlist). Anything else is
# denied: arch, taskset, script, npx, su, unbuffer, strace, docker, an unknown function name.
WORKER_CMDS = {
    "echo",
    "printf",
    "cat",
    "head",
    "tail",
    "wc",
    "sort",
    "uniq",
    "cut",
    "tr",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "sed",
    "awk",
    "gawk",
    "diff",
    "cmp",
    "comm",
    "ls",
    "pwd",
    "test",
    "[",
    "[[",
    "true",
    "false",
    ":",
    "mkdir",
    "rmdir",
    "touch",
    "cp",
    "mv",
    "rm",
    "ln",
    "chmod",
    "stat",
    "date",
    "basename",
    "dirname",
    "realpath",
    "readlink",
    "mktemp",
    "seq",
    "tac",
    "rev",
    "nl",
    "fold",
    "paste",
    "join",
    "expr",
    "bc",
    "du",
    "df",
    "tar",
    "gzip",
    "gunzip",
    "zcat",
    "zip",
    "unzip",
    "sha1sum",
    "sha256sum",
    "shasum",
    "md5",
    "md5sum",
    "base64",
    "iconv",
    "column",
    "tee",
    "xxd",
    "od",
    "file",
    "which",
    "type",
    "export",
    "declare",
    "typeset",
    "local",
    "set",
    "unset",
    "shift",
    "read",
    "exit",
    "return",
    "wait",
    "eval",
    "let",
    "printenv",
    "sleep",
    "jq",
    "yq",
    "shellcheck",
    "shfmt",
    "npm",
    "pnpm",
    "yarn",
    "go",
    "gofmt",
    "cargo",
    "rustc",
    "pytest",
    "tox",
    "uv",
    "pip",
    "pip3",
    "ruff",
    "mypy",
    "black",
    "isort",
    "eslint",
    "prettier",
    "tsc",
    "jest",
    "vitest",
    "playwright",
}
# Resolved from this file, not the cwd: the copy in the main checkout, outside a worker's reach.
# (`globals()`: the test suite execs this module without a __file__.)
HARNESS_FILE = os.path.join(
    os.path.dirname(os.path.abspath(globals().get("__file__", "."))),
    "..",
    "..",
    "..",
    "scripts",
    "lib",
    "harness-paths.txt",
)
WORKER_ENV = {
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_EXEC_PATH",
    "GIT_ASKPASS",
    "GIT_TEMPLATE_DIR",
    "GIT_CEILING_DIRECTORIES",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_EDITOR",
    "GIT_SEQUENCE_EDITOR",
    "GIT_PAGER",
    "GIT_EXTERNAL_DIFF",
    "GIT_PROXY_COMMAND",
    "HOME",
    "XDG_CONFIG_HOME",
    "MAKEFLAGS",
    "MFLAGS",
    "GNUMAKEFLAGS",
    "MAKEFILES",
    "SKIP",
    "PRE_COMMIT_ALLOW_NO_CONFIG",
    "BLUEPRINT_ALLOW_PROTECTED_EDIT",
    # round 4: PATH/BASH_ENV/ENV pick what runs
    "CLAUDE_PROJECT_DIR",
    "PATH",
    "BASH_ENV",
    "ENV",
    # rounds 5 and 6: loader and interpreter injection
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "NODE_OPTIONS",
    "RUBYOPT",
    "PERL5OPT",
    "LD_LIBRARY_PATH",
    "DYLD_FALLBACK_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "LD_AUDIT",
    "PERL5LIB",
    "NODE_PATH",
    "PYTHONHOME",
    "RUBYLIB",
}
WORKER_DECLARE = {
    "export",
    "declare",
    "typeset",
    "local",
    "readonly",
    "read",
    "getopts",
}
WORKER_NET = {"curl", "wget", "ssh", "scp", "sftp"}
WORKER_GLAB_OK = {
    ("issue", "view"),
    ("issue", "list"),
    ("mr", "view"),
    ("mr", "list"),
    ("mr", "diff"),
    ("ci", "status"),
    ("ci", "view"),
    ("ci", "list"),
    ("ci", "trace"),
}
WORKER_TMP = ("/tmp", "/private/tmp", "/var/folders", "/private/var/folders")
WORKER_DEV = {"/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"}
WORKER_WT_OK = {"adopt", "stash", "list", "ls", "harness-diff", "help", "--help", "-h"}
WORKER_INTERP = (
    {"python", "python3", "node", "perl", "ruby", "php"} | SHELLS | {"source", "."}
)
WORKER_MSG = " (/wave worker allowlist, ADR 0010: you work only in your own worktree; stop and report if the issue needs this)"

# git: read-only subcommands take any option except these (and their unique abbreviations).
WORKER_GIT_READ = {
    "status",
    "diff",
    "log",
    "show",
    "rev-parse",
    "rev-list",
    "ls-files",
    "ls-tree",
    "cat-file",
    "merge-base",
    "blame",
    "shortlog",
    "describe",
    "name-rev",
    "cherry",
    "range-diff",
    "for-each-ref",
    "show-ref",
    "check-ignore",
    "check-attr",
    "var",
    "version",
    "grep",
    "diff-tree",
    "diff-files",
    "diff-index",
    "whatchanged",
    "count-objects",
    "show-branch",
}
WORKER_GIT_READ_DANGER = (
    "--output",
    "--open-files-in-pager",
    "--ext-diff",
    "--no-index",
)
# git write subcommands: (short flags, short flags taking a value, long flags, long options taking a value,
# max positionals before `--` or None, operands are paths to check)
WORKER_GIT_WRITE = {
    "add": (
        "AuNvn",
        "",
        {
            "--all",
            "--update",
            "--intent-to-add",
            "--verbose",
            "--dry-run",
            "--renormalize",
        },
        set(),
        None,
        False,
    ),
    "commit": (
        "aqvesoi",
        "mFCct",
        {
            "--all",
            "--quiet",
            "--verbose",
            "--amend",
            "--no-edit",
            "--edit",
            "--signoff",
            "--allow-empty",
            "--allow-empty-message",
            "--reset-author",
            "--only",
            "--include",
            "--status",
            "--no-status",
            "--dry-run",
        },
        {
            "--message",
            "--file",
            "--author",
            "--date",
            "--fixup",
            "--squash",
            "--reuse-message",
            "--reedit-message",
            "--cleanup",
            "--template",
            "--trailer",
        },
        None,
        False,
    ),
    "rm": (
        "rfqn",
        "",
        {"--cached", "--quiet", "--dry-run", "--force", "--ignore-unmatch"},
        set(),
        None,
        True,
    ),
    "mv": ("fknv", "", {"--force", "--dry-run", "--verbose"}, set(), None, True),
    "restore": (
        "WSq",
        "s",
        {
            "--staged",
            "--worktree",
            "--quiet",
            "--ours",
            "--theirs",
            "--merge",
            "--ignore-unmerged",
            "--overlay",
            "--no-overlay",
        },
        {"--source", "--conflict"},
        None,
        True,
    ),
    "reset": (
        "q",
        "",
        {"--soft", "--mixed", "--quiet", "--no-refresh"},
        set(),
        None,
        True,
    ),
    "rebase": (
        "qvnrf",
        "",
        {
            "--continue",
            "--abort",
            "--skip",
            "--quit",
            "--keep-base",
            "--quiet",
            "--verbose",
            "--stat",
            "--no-stat",
            "--rebase-merges",
            "--committer-date-is-author-date",
            "--signoff",
            "--autostash",
            "--no-autostash",
            "--fork-point",
            "--no-fork-point",
            "--no-ff",
            "--force-rebase",
        },
        {"--onto"},
        1,
        False,
    ),
    "merge": (
        "qnv",
        "m",
        {
            "--no-edit",
            "--edit",
            "--ff",
            "--no-ff",
            "--ff-only",
            "--abort",
            "--continue",
            "--quit",
            "--squash",
            "--no-squash",
            "--stat",
            "--no-stat",
            "--log",
            "--no-log",
            "--quiet",
            "--verbose",
        },
        {"--message"},
        None,
        False,
    ),
    "cherry-pick": (
        "nxe",
        "m",
        {
            "--continue",
            "--abort",
            "--skip",
            "--quit",
            "--no-commit",
            "--edit",
            "--no-edit",
            "--allow-empty",
            "--ff",
        },
        {"--mainline"},
        None,
        False,
    ),
    "revert": (
        "ne",
        "m",
        {
            "--continue",
            "--abort",
            "--skip",
            "--quit",
            "--no-commit",
            "--edit",
            "--no-edit",
        },
        {"--mainline"},
        None,
        False,
    ),
    "fetch": (
        "pqv",
        "",
        {
            "--prune",
            "--quiet",
            "--verbose",
            "--tags",
            "--no-tags",
            "--unshallow",
            "--dry-run",
        },
        {"--depth", "--deepen", "--shallow-since"},
        None,
        False,
    ),
    "pull": (
        "qvr",
        "",
        {
            "--rebase",
            "--no-rebase",
            "--ff-only",
            "--ff",
            "--no-ff",
            "--quiet",
            "--verbose",
            "--autostash",
            "--no-autostash",
            "--no-edit",
            "--prune",
        },
        set(),
        None,
        False,
    ),
    "checkout": (
        "fq",
        "",
        {"--force", "--quiet", "--ours", "--theirs", "--merge"},
        set(),
        1,
        True,
    ),
}
WORKER_GIT_SUBSUB = {
    "stash": {"list", "show"},
    "worktree": {"list"},
    "remote": {"-v", "--verbose", "show", "get-url"},
    "bisect": {"start", "good", "bad", "new", "old", "skip", "reset", "log", "terms"},
}
# make: no -C/-f/-e/-i/-I/-W/-o and no VAR=value; j, l take an optional number, O an optional type.
WORKER_MAKE_SHORT = "knsqBSwd"
WORKER_MAKE_LONG = {
    "--keep-going",
    "--dry-run",
    "--just-print",
    "--recon",
    "--silent",
    "--quiet",
    "--question",
    "--always-make",
    "--no-keep-going",
    "--stop",
    "--print-directory",
    "--no-print-directory",
    "--trace",
    "--jobs",
    "--load-average",
    "--output-sync",
    "--debug",
}


def load_harness():
    try:
        with open(HARNESS_FILE) as f:
            lines = f.read().splitlines()
    except OSError:
        deny(
            "cannot read scripts/lib/harness-paths.txt, the harness list (fail closed)"
            + WORKER_MSG
            + "."
        )
    pats = [ln.split("#", 1)[0].strip().lower() for ln in lines]
    pats = [p for p in pats if p]
    if not pats:
        deny(
            "scripts/lib/harness-paths.txt lists no paths (fail closed)"
            + WORKER_MSG
            + "."
        )
    WORKER["harness"] = pats


def set_worker(event):
    # TruePPM does not ship blueprint's /wave worker tier: its subagents live under
    # <main>/.claude/worktrees/agent-*, which this tier would otherwise confine to a
    # read-mostly allowlist. Returning here leaves WORKER["root"] empty, so every
    # worker_* branch below is dead code kept only so the file stays diffable
    # against blueprint's copy.
    return
    proj = os.environ.get("CLAUDE_PROJECT_DIR", "")
    cwd = STATE["event_cwd"]
    named = event.get("agent_type") == "wave-worker"
    under = bool(
        proj.startswith("/")
        and cwd.startswith("/")
        and inside(
            os.path.realpath(cwd),
            os.path.join(os.path.realpath(proj), ".claude", "worktrees"),
        )
    )
    if not (named or under):
        return
    top = git_toplevel(cwd) if cwd.startswith("/") else ""
    if not top:
        deny(
            "cannot resolve the worker's worktree from the event cwd (fail closed)."
            + WORKER_MSG
        )
    WORKER["root"] = os.path.realpath(top)
    load_harness()


def worker_scan_text(command):
    """Assignments the per-word scan cannot see: `${GIT_DIR:=/x}`, `${HOME=/x}`."""
    m = re.search(r"\$\{(" + "|".join(sorted(WORKER_ENV)) + r")\s*:?=", command)
    if m:
        deny(
            "`${"
            + m.group(1)
            + ":=...}` assigns a variable that redirects git, make or the hooks"
            + WORKER_MSG
            + "."
        )


def worker_resolve(path):
    """(full path, path relative to the worktree root or None when outside), once per directory the
    segment may run in (a `cd` earlier on the line moves it)."""
    ev = STATE["event_cwd"] if STATE["event_cwd"].startswith("/") else WORKER["root"]
    out = []
    for c in STATE["cwds"]:
        base = (
            ev
            if c is None
            else (WORKER["root"] if c == UNKNOWN else os.path.join(ev, c))
        )
        raw = os.path.normpath(os.path.join(base, os.path.expanduser(path)))
        full = os.path.realpath(raw)
        rel = (
            os.path.relpath(full, WORKER["root"]).lower()
            if inside(full, WORKER["root"])
            else None
        )
        out.append((raw, full, rel))
    return out


def worker_scratch(raw, full):
    if (
        raw in WORKER_DEV
        or full in WORKER_DEV
        or raw.startswith("/dev/fd/")
        or full.startswith("/dev/fd/")
    ):
        return True
    return any(inside(full, d) for d in WORKER_TMP) and not git_toplevel(full)


def harness_match(rel, pats):
    """rel (lower-case, worktree-relative) is harness: its first component matches a pattern, or,
    for a `**/name` pattern, any component does (nested CLAUDE.md, lint configs; round 4)."""
    parts = rel.split("/")
    for p in pats:
        if p.startswith("**/"):
            if any(fnmatch.fnmatchcase(c, p[3:]) for c in parts):
                return True
        elif fnmatch.fnmatchcase(parts[0], p):
            return True
    return False


def harness_rel(rel):
    return harness_match(rel, WORKER["harness"])


def worker_write_bad(path):
    """True when writing `path` leaves the worker's worktree (other than a scratch dir) or hits the harness."""
    if not WORKER["root"] or not isinstance(path, str) or not path:
        return False
    for raw, full, rel in worker_resolve(path):
        if rel is None:
            if not worker_scratch(raw, full):
                return True
        elif rel != "." and harness_rel(rel):
            return True
    return False


def worker_env(toks):
    decl = bool(toks) and os.path.basename(toks[0]) in WORKER_DECLARE
    for k, t in enumerate(toks):
        m = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)\+?=.*", t)
        name = m.group(1) if m else (t if decl and k > 0 else "")
        if k > 0 and toks[k - 1] == "-v" and os.path.basename(toks[0]) == "printf":
            name = t
        if name in WORKER_ENV:
            deny(
                "setting "
                + name
                + " redirects git, make or the hooks"
                + WORKER_MSG
                + "."
            )


def worker_cd(name, plain, t):
    if (
        name == "popd"
        or plain[:1] in (["-"], ["~-"])
        or (name == "pushd" and (not plain or plain[0].startswith(("+", "-"))))
    ):
        deny(
            "`"
            + " ".join([name] + plain)
            + "` jumps to a directory the command text does not name"
            + WORKER_MSG
            + "."
        )
    if t is None:
        deny("a cd whose target is not in the command text" + WORKER_MSG + ".")
    for raw, full, rel in worker_resolve(t):
        if rel is None and not worker_scratch(raw, full):
            deny("`cd " + t + "` leaves your worktree" + WORKER_MSG + ".")


def worker_unwrap(toks):
    """The real command words behind the allowed wrappers; deny any other wrapper. A `--` right
    after a wrapper's own options ends them (round 3: `command -- make -C /x` hid the make)."""
    k = 0
    after_wrapper = False
    while k < len(toks):
        if after_wrapper and toks[k] == "--":
            k += 1
            after_wrapper = False
            continue
        after_wrapper = True
        w = os.path.basename(toks[k])
        if w == "env":
            k += 1
            while k < len(toks):
                a = toks[k]
                if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", a):
                    worker_env([a])
                    k += 1
                elif a in ("-i", "--ignore-environment", "-0", "--null"):
                    k += 1
                elif a in ("-u", "--unset"):
                    k += 2
                elif a.startswith("--unset="):
                    k += 1
                elif a == "--":
                    k += 1
                    break
                elif a.startswith("-"):
                    deny(
                        "`env "
                        + a
                        + "`: only NAME=value, -i and -u are allowed (no -C/--chdir, -S)"
                        + WORKER_MSG
                        + "."
                    )
                else:
                    break
            continue
        if w == "time":
            k += 1
            while k < len(toks) and toks[k].startswith("-"):
                if toks[k] != "-p":
                    deny("`time " + toks[k] + "`" + WORKER_MSG + ".")
                k += 1
            continue
        if w == "nohup":
            k += 1
            continue
        if w == "command":
            k += 1
            if k < len(toks) and toks[k] in ("-v", "-V"):
                return []  # a lookup, nothing runs
            if k < len(toks) and toks[k] == "-p":
                k += 1
            continue
        if w == "nice":
            k += 1
            if k < len(toks) and toks[k] in ("-n", "--adjustment"):
                k += 2
            elif k < len(toks) and re.fullmatch(
                r"-n?-?[0-9]+|--adjustment=-?[0-9]+", toks[k]
            ):
                k += 1
            continue
        if w == "timeout":
            k += 1
            while k < len(toks) and toks[k].startswith("-"):
                a = toks[k]
                if a in ("-s", "-k", "--signal", "--kill-after"):
                    k += 2
                elif a in (
                    "--preserve-status",
                    "--foreground",
                    "-v",
                    "--verbose",
                ) or a.startswith(("--signal=", "--kill-after=")):
                    k += 1
                else:
                    deny("`timeout " + a + "`" + WORKER_MSG + ".")
            k += 1  # the duration
            continue
        if w == "find":
            if any(
                a
                in (
                    "-exec",
                    "-execdir",
                    "-ok",
                    "-okdir",
                    "-delete",
                    "-fprint",
                    "-fprint0",
                    "-fprintf",
                    "-fls",
                )
                for a in toks[k + 1 :]
            ):
                deny(
                    "`find` with an action that runs a command or writes a file"
                    + WORKER_MSG
                    + "."
                )
            return []
        if w in WRAPPERS or w in ("exec", "builtin", "chroot", "unshare", "nsenter"):
            deny(
                "`"
                + w
                + "` is not an allowed wrapper (env, time, nohup, nice, timeout, command)"
                + WORKER_MSG
                + "."
            )
        return toks[k:]
    return []


def worker_opts(cmd, args, short_flags, short_vals, long_flags, long_vals):
    """Positional words of `args`; deny any option outside the allowlist (no abbreviations)."""
    pos, k = [], 0
    while k < len(args):
        a = args[k]
        if a == "--":
            return pos, args[k + 1 :]
        if a.startswith("--"):
            name = a.split("=", 1)[0]
            if name in long_flags and "=" not in a:
                k += 1
                continue
            if name in long_vals:
                k += 1 if "=" in a else 2
                continue
            deny(
                "`"
                + cmd
                + " "
                + a
                + "` is not on the worker allowlist"
                + WORKER_MSG
                + "."
            )
        if a.startswith("-") and len(a) > 1 and not re.fullmatch(r"-[0-9]+", a):
            j = 1
            while j < len(a):
                ch = a[j]
                if ch in short_vals:
                    if j + 1 == len(a):
                        k += 1  # the value is the next word
                    break
                if ch not in short_flags:
                    deny(
                        "`"
                        + cmd
                        + " "
                        + a
                        + "` (-"
                        + ch
                        + ") is not on the worker allowlist"
                        + WORKER_MSG
                        + "."
                    )
                j += 1
            k += 1
            continue
        pos.append(a)
        k += 1
    return pos, []


def worker_git(args):
    k = 0
    while k < len(args) and args[k].startswith("-"):
        if args[k] in (
            "--no-pager",
            "-P",
            "--literal-pathspecs",
            "--no-optional-locks",
            "--version",
        ):
            k += 1
            continue
        deny(
            "`git "
            + args[k]
            + "` (a global option: -C, -c, --git-dir, --work-tree, --config-env, --exec-path, ...)"
            + WORKER_MSG
            + "."
        )
    if k >= len(args):
        return
    sub, rest = args[k], args[k + 1 :]
    if sub in WORKER_GIT_READ:
        for a in rest:
            if a == "--":
                break
            if a.startswith("--"):
                name = a.split("=", 1)[0]
                if len(name) > 3 and any(
                    d.startswith(name) for d in WORKER_GIT_READ_DANGER
                ):
                    deny(
                        "`git "
                        + sub
                        + " "
                        + a
                        + "` writes a file or runs a program"
                        + WORKER_MSG
                        + "."
                    )
            elif sub == "grep" and a.startswith("-") and "O" in a:
                deny("`git grep -O` opens files in a program" + WORKER_MSG + ".")
        return
    if sub == "bisect" and rest[:1] == ["reset"] and len(rest) > 1:
        deny(
            "`git bisect reset <ref>` checks out <ref>; plain `git bisect reset` is fine"
            + WORKER_MSG
            + "."
        )
    if sub in WORKER_GIT_SUBSUB:
        if not rest or rest[0] not in WORKER_GIT_SUBSUB[sub]:
            if not (sub == "remote" and not rest):
                deny(
                    "`git "
                    + " ".join([sub] + rest[:1])
                    + "` is not on the worker allowlist"
                    + WORKER_MSG
                    + "."
                )
        return
    if sub == "config":
        # Round 5: only these exact read forms. A read flag elsewhere did not make it a read:
        # `git config core.hooksPath /tmp/h --list` wrote the shared .git/config (a linked
        # worktree has none of its own), which harness-diff cannot see.
        ok = rest in (["--list"], ["-l"], ["list"]) or (
            len(rest) == 2
            and rest[0] in ("--get", "--get-all", "--get-regexp", "get")
            and not rest[1].startswith("-")
        )
        if not ok:
            deny(
                "`git config "
                + " ".join(rest)
                + "`: a worker may only run `git config --get|--get-all|--get-regexp <name>` or `--list`"
                + WORKER_MSG
                + "."
            )
        return
    if sub == "branch":
        pos, _ = worker_opts(
            "git branch",
            rest,
            "arlv",
            "",
            {"--show-current", "--all", "--remotes", "--list", "--verbose"},
            {
                "--contains",
                "--no-contains",
                "--merged",
                "--no-merged",
                "--format",
                "--sort",
                "--points-at",
            },
        )
        if pos and not any(a in ("-l", "--list") for a in rest):
            deny(
                "`git branch <name>` creates a branch; `scripts/wt adopt` names yours"
                + WORKER_MSG
                + "."
            )
        return
    if sub == "tag":
        if rest and not any(a in ("-l", "--list") for a in rest):
            deny("`git tag` that is not a --list read" + WORKER_MSG + ".")
        return
    if sub == "clean":
        if not any(
            a in ("-n", "--dry-run") or re.fullmatch(r"-[a-zA-Z]*n[a-zA-Z]*", a)
            for a in rest
        ):
            deny("`git clean` without --dry-run" + WORKER_MSG + ".")
        return
    if sub not in WORKER_GIT_WRITE:
        deny(
            "`git "
            + sub
            + "` is not on the worker allowlist (push, switch, apply, am, worktree, submodule, hook, "
            "send-pack, archive, bundle, difftool, mergetool, notes, gc, ... are not)"
            + WORKER_MSG
            + "."
        )
    sf, sv, lf, lv, max_pos, paths = WORKER_GIT_WRITE[sub]
    pos, after = worker_opts("git " + sub, rest, sf, sv, lf, lv)
    if sub == "checkout" and "--" not in rest:
        deny(
            "`git checkout` without `--`: switching branches is not allowed; use `git checkout -- <paths>` or `git restore`"
            + WORKER_MSG
            + "."
        )
    if max_pos is not None and len(pos) > max_pos:
        deny(
            "`git "
            + sub
            + "` with more than "
            + str(max_pos)
            + " positional argument(s) would act on another branch"
            + WORKER_MSG
            + "."
        )
    if sub in ("fetch", "pull"):
        if pos and pos[0] != "origin":
            deny("`git " + sub + " " + pos[0] + "`: only origin" + WORKER_MSG + ".")
        for r in pos[1:]:
            if ":" in r or r.startswith("+"):
                deny(
                    "`git "
                    + sub
                    + "` refspec "
                    + r
                    + " writes a local ref"
                    + WORKER_MSG
                    + "."
                )
    if paths:
        if sub == "checkout" and not after:
            deny(
                "`git checkout <ref> --` with no path switches the branch; name the paths after `--`"
                + WORKER_MSG
                + "."
            )
        for t in (
            (pos if sub in ("rm", "mv") else [])
            + after
            + (pos if sub == "restore" else [])
            + (pos[1:] if sub == "reset" else [])
        ):
            # Round 3: pathspec magic, globs and a bare . or .. reach paths the write check never sees.
            if (
                t.startswith(":")
                or re.search(r"[*?\[]", t)
                or os.path.normpath(t) in (".", "..")
            ):
                deny(
                    "`git "
                    + sub
                    + " "
                    + t
                    + "`: a pathspec with magic (`:/`, `:(top)`), a glob or a bare . can reach the harness; name the files"
                    + WORKER_MSG
                    + "."
                )
            if worker_write_bad(t):
                deny(
                    "`git "
                    + sub
                    + "` would write "
                    + t
                    + ", outside your worktree or in the harness"
                    + WORKER_MSG
                    + "."
                )


def worker_glab(args):
    words, k = [], 0
    while k < len(args):
        a = args[k]
        if a in ("-R", "--repo", "--hostname"):
            k += 2
            continue
        if not a.startswith("-"):
            words.append(a)
        k += 1
    if tuple(words[:2]) not in WORKER_GLAB_OK:
        deny(
            "`glab "
            + " ".join(words[:2])
            + "`: a worker reads the forge only (issue/mr view and list, ci status); the orchestrator opens the MR"
            + WORKER_MSG
            + "."
        )


def worker_make(args):
    for a in args:
        if a.startswith("--"):
            if a.split("=", 1)[0] not in WORKER_MAKE_LONG:
                deny(
                    "`make "
                    + a
                    + "` is not on the worker allowlist (abbreviations included)"
                    + WORKER_MSG
                    + "."
                )
        elif a.startswith("-") and len(a) > 1:
            j = 1
            while j < len(a):
                ch = a[j]
                if ch in "jl":
                    if not re.fullmatch(r"[0-9.]*", a[j + 1 :]):
                        deny(
                            "`make "
                            + a
                            + "`: -"
                            + ch
                            + " takes only a number"
                            + WORKER_MSG
                            + "."
                        )
                    break
                if ch == "O":
                    break  # -O[type]
                if ch not in WORKER_MAKE_SHORT:
                    deny(
                        "`make "
                        + a
                        + "` (-"
                        + ch
                        + ") is not on the worker allowlist (no -C, -f, -e, -i, -I, -W, -o)"
                        + WORKER_MSG
                        + "."
                    )
                j += 1
        elif "=" in a:
            deny("`make " + a + "` overrides a Makefile variable" + WORKER_MSG + ".")


def worker_script(path, args):
    p = path.replace("\\", "/")
    parts = [x for x in os.path.normpath(p).split("/") if x not in ("", ".")]
    if ".claude" in parts and "hooks" in parts:
        deny("running a hook script by hand (" + path + ")" + WORKER_MSG + ".")
    if len(parts) >= 2 and parts[-2] == "scripts":
        base = parts[-1]
        if base == "wt":
            if not args or args[0] not in WORKER_WT_OK:
                deny(
                    "`scripts/wt "
                    + (args[0] if args else "")
                    + "`: a worker may run only wt adopt, stash, list and harness-diff"
                    + WORKER_MSG
                    + "."
                )
            return
        if base.startswith("check-"):
            return
        deny(
            "`"
            + path
            + "` is not on the worker allowlist (scripts/check-*, scripts/tests/*, scripts/wt)"
            + WORKER_MSG
            + "."
        )
    if len(parts) >= 3 and parts[-3] == "scripts" and parts[-2] == "tests":
        return


def worker_rewrite_targets(name, args):
    """The paths an in-place rewriter would write, or [] for a read-only / check-only run."""
    flags = [a for a in args if a.startswith("-")]
    ops = [a for a in args if not a.startswith("-")]
    check = any(
        f
        in (
            "--check",
            "--diff",
            "--check-only",
            "-c",
            "-l",
            "--list",
            "--list-different",
        )
        for f in flags
    )
    if name == "ruff":
        sub, rest = (ops[0], ops[1:]) if ops else ("", [])
        if sub == "format" and not check:
            return rest or ["."]
        if (
            sub == "check"
            and any(f.startswith(("--fix", "--unsafe-fixes")) for f in flags)
            and "--no-fix" not in flags
        ):
            return rest or ["."]
        return []
    if name in ("black", "isort"):
        return [] if check else (ops or ["."])
    if name == "prettier":
        return (ops or ["."]) if any(f in ("--write", "-w") for f in flags) else []
    if name == "eslint":
        return (ops or ["."]) if any(f == "--fix" for f in flags) else []
    if name in ("shfmt", "gofmt"):
        return (ops or ["."]) if any(f in ("-w", "--write") for f in flags) else []
    if name == "yq":
        return ops[1:] if any(f in ("-i", "--inplace") for f in flags) else []
    if name == "gunzip":
        return ops + [o[:-3] for o in ops if o.endswith(".gz")]
    if name == "zip":
        return ops[:1]
    out = []
    for k, a in enumerate(args):
        if name == "iconv" and a in ("-o", "--output") and k + 1 < len(args):
            out.append(args[k + 1])
        elif name == "iconv" and a.startswith("--output="):
            out.append(a.split("=", 1)[1])
        elif name == "mktemp" and a in ("-p", "--tmpdir") and k + 1 < len(args):
            out.append(args[k + 1])
    if name == "mktemp":
        out += ops
    return out


def worker_holds_harness(t):
    """True when `t` resolves to the worktree root or above: a rewriter run there reaches the harness."""
    for raw, full, rel in worker_resolve(t):
        if rel is None:
            if not worker_scratch(raw, full) and inside(WORKER["root"], full):
                return True
        elif rel == ".":
            return True
    return False


def worker_segment(toks):
    real = worker_unwrap(toks)
    if not real:
        return
    name, args = os.path.basename(real[0]), real[1:]
    if name in WORKER_REWRITERS:
        for t in worker_rewrite_targets(name, args):
            if worker_write_bad(t) or worker_holds_harness(t):
                deny(
                    "`"
                    + name
                    + "` would rewrite "
                    + t
                    + " in place, which is (or holds) the harness or lies outside your worktree; "
                    "name the files, or use the check-only form" + WORKER_MSG + "."
                )
    if name in WORKER_NET:
        deny(
            "`"
            + name
            + "`: network tools are off in the worker tier (hygiene; the sandbox, blueprint#104, is the containment)"
            + WORKER_MSG
            + "."
        )
    if name in ("git", "glab", "make", "gmake"):
        {
            "git": worker_git,
            "glab": worker_glab,
            "make": worker_make,
            "gmake": worker_make,
        }[name](args)
        return
    if name in WORKER_INTERP:
        k = 0
        while k < len(args) and args[k].startswith("-"):
            if args[k] in ("-c", "-e", "-m") or re.fullmatch(r"-[A-Za-z]*c", args[k]):
                return  # inline code: `bash -c` is analyzed on its own; python -c is the accepted miss
            k += 1
        if k < len(args):
            worker_script(args[k], args[k + 1 :])
        return
    if "/" in real[0]:
        parts = [x for x in os.path.normpath(real[0]).split("/") if x not in ("", ".")]
        under_scripts = len(parts) >= 2 and (
            parts[-2] == "scripts"
            or (len(parts) >= 3 and parts[-3:-1] == ["scripts", "tests"])
        )
        inside_tree = all(
            rel is not None for _raw, _full, rel in worker_resolve(real[0])
        )
        # Round 6: the scripts/ and .claude/ carve-out holds only inside the worktree or the main
        # checkout's scripts/; `~/.claude/local/claude` or `/tmp/x/scripts/check-y` is judged by name.
        proj = os.environ.get("CLAUDE_PROJECT_DIR", "")
        main_scripts = bool(proj.startswith("/")) and all(
            inside(full, os.path.join(os.path.realpath(proj), "scripts"))
            for _raw, full, _rel in worker_resolve(real[0])
        )
        if inside_tree or (under_scripts and main_scripts):
            worker_script(real[0], args)
            return
        # Round 5: a command run by a path outside the worktree is the program its basename
        # names: /usr/bin/git and /usr/bin/make get their allowlists, /usr/bin/script,
        # /usr/bin/nc and /usr/bin/osascript fall to the command-word allowlist below.
        if name in ("git", "glab", "make", "gmake"):
            {
                "git": worker_git,
                "glab": worker_glab,
                "make": worker_make,
                "gmake": worker_make,
            }[name](args)
            return
        if name in WORKER_INTERP:
            return worker_segment([name] + args)
    if len(real) > 1 and real[1] == "in":
        return  # a `for x in ...` / `select x in ...` header, not a command
    if name not in WORKER_CMDS:
        deny(
            "`"
            + name
            + "` is not on the worker command allowlist (git, make, glab, the shells and interpreters, "
            "common text tools, the language toolchains and test runners)"
            + WORKER_MSG
            + "."
        )


# Heredocs (blueprint#197). The scan below accepts only shapes it can place with
# certainty and raises Parse, so the hook denies, on everything else. It does not try to mirror
# every shell: an exotic command is denied and can be rewritten with a plain delimiter.
#
# Delimiter grammar: after `<<` or `<<-` and optional blanks, the word is one or more segments with
# nothing between them, each an unquoted run of [A-Za-z0-9_], or '...' or "..." holding one or more
# of [A-Za-z0-9_.:/-]; the word ends at the end of the text, a blank, a newline, or one of ; & | < >.
# The delimiter is the word with its quote characters removed, and the body is literal (no
# expansion) when the word holds a quote. So `<<E"O"F` and `<<'E'OF` end at a line `EOF`, and
# `<<EOF'X'` at `EOFX`. Any other word (a backslash, `$`, a backtick, a glob or brace character, a
# blank inside quotes, a missing word, a word glued to `(` or `#`) raises Parse.
HEREDOC_WORD = re.compile(
    r"""(?:[A-Za-z0-9_]+|'[A-Za-z0-9_.:/-]+'|"[A-Za-z0-9_.:/-]+")+"""
)
HEREDOC_WORD_END = " \t\n;&|<>"
# Constructs whose text the shell does not split into commands, each with its closer. Inside the
# arithmetic ones `<<` is a shift; inside ${ } a `<<` raises Parse.
NEST_OPEN = (("$((", "))"), ("((", "))"), ("${", "}"), ("$[", "]"))
NEST_INNER = {"))": "(", ")": "(", "]": "[", "}": "{"}


def heredoc_word(s, i):
    """(delimiter, quoted, end, dash) for the `<<` at s[i], under the grammar above, else Parse."""
    j = i + 2
    dash = s.startswith("-", j)
    j += dash
    while j < len(s) and s[j] in " \t":
        j += 1
    m = HEREDOC_WORD.match(s, j)
    if not m or (m.end() < len(s) and s[m.end()] not in HEREDOC_WORD_END):
        raise Parse(
            "a heredoc delimiter outside the accepted grammar; use a plain word such as EOF or 'EOF'"
        )
    word = m.group(0)
    delim = word.replace("'", "").replace('"', "")
    return delim, delim != word, m.end(), dash


def ends_heredoc(line, delim, dash, subst):
    """Whether `line` is the terminator: the delimiter exactly, after leading tabs are stripped for
    `<<-`. Inside a `$( )`, `( )` or backtick (`subst`), bash and ksh also end the body at some
    lines that start with the delimiter and go on (`EOF )`, `EOF);`, and in bash 3.2 ` EOF)`).
    Rather than list those forms, any such line there that starts with the delimiter after blanks
    but is not exactly it raises Parse."""
    text = line.lstrip("\t") if dash else line
    if text == delim:
        return True
    if subst and text.lstrip(" \t").startswith(")"):
        # bash 3.2 closes the enclosing `$( )` at a body line that starts with `)`, even for a quoted
        # delimiter, and runs the next lines as commands (blueprint#211).
        raise Parse("a heredoc body line in a substitution that starts with `)`")
    if subst and text.lstrip(" \t").startswith(delim):
        raise Parse(
            "a heredoc body line in a substitution that starts with the delimiter but is not exactly it"
        )
    return False


def prev_src(s, i):
    """Index of the source character before s[i] once backslash-newline pairs are removed, or -1."""
    j = i - 1
    while j >= 1 and s[j] == "\n" and s[j - 1] == "\\" and not escaped(s, j - 1):
        j -= 2
    return j


def word_start(s, i):
    """Whether the shell starts a new word at s[i]: the last SOURCE character before it, after a
    backslash-newline is removed as the shell removes it, is a blank, newline, `;`, `|`, `&` or `(`
    that no backslash escapes (blueprint#209). The output chunk cannot say, because an
    escape or a removed line continuation also leaves a blank or operator there."""
    j = prev_src(s, i)
    if j < 0:
        return True
    return s[j] in " \t\n;|&(" and not escaped(s, j)


def command_start_paren(s, p):
    """Whether the `(` at s[p] is a `$(` or sits where a command starts (after the start, a newline
    or one of `;|&(`, blanks skipped), so that a `#` after it is a comment in every shell."""
    if p >= 1 and s[p - 1] == "$" and not escaped(s, p - 1):
        return True
    r = prev_src(s, p)
    while r >= 0 and s[r] in " \t" and not escaped(s, r):
        r = prev_src(s, r)
    return r < 0 or (s[r] in "\n;|&(" and not escaped(s, r))


def escaped(s, j):
    """Whether an odd run of backslashes ends just before s[j]."""
    k = j
    while k > 0 and s[k - 1] == "\\":
        k -= 1
    return (j - k) % 2 == 1


def check_funsub(s, i):
    if s[i + 2 : i + 3] in (" ", "\t", "\n", "|"):
        raise Parse("`${ cmd; }` and `${| cmd; }` run a command in bash 5.3")


def nest_step(s, i, stack):
    """Track NEST_OPEN on unquoted text: the number of characters at s[i] that open or close one of
    them, or a paren, bracket or brace nested in one, else 0. Inside $(( )) and (( )) every `(` must
    close with `)`: a stray `)` means bash may read the `((` as nested subshells, where `<<` starts a
    heredoc, so it raises Parse."""
    top = stack[-1] if stack else None
    for o, closer in NEST_OPEN:
        if s.startswith(o, i) and not (o == "((" and top in ("))", ")")):
            if o == "${":
                check_funsub(s, i)
            stack.append(closer)
            return len(o)
    if top is None:
        return 0
    if s[i] == NEST_INNER[top]:
        stack.append(")" if top == "))" else top)
        return 1
    if s.startswith(top, i):
        stack.pop()
        return len(top)
    if top == "))" and s[i] == ")":
        raise Parse("a `)` that closes no `(` inside $(( )) or (( ))")
    return 0


def backtick_end(s, i):
    """Index just past the backtick that closes the one at s[i] (a backslash escapes the next
    character), or None when there is none."""
    j, n = i + 1, len(s)
    while j < n:
        if s[j] == "\\":
            j += 2
        elif s[j] == "`":
            return j + 1
        else:
            j += 1
    return None


def embedded_end(s, i, level):
    """Index just past the backtick, `$(( ))` or `$( )` substitution that starts at s[i]."""
    if s[i] == "`":
        j = backtick_end(s, i)
        if j is None:
            raise Parse("an unterminated backtick")
        return j
    if s.startswith("$((", i):
        return scan(s, i, nested=True, stop="))", record=False, level=level + 1)[1]
    return scan(s, i + 2, nested=True, stop=")", record=False, level=level + 1)[1]


def scan(s, i=0, nested=False, stop=None, record=True, level=0):
    """One left-to-right pass over shell text, shared by preprocess() and close_paren() so they agree
    on quotes, comments, heredoc bodies and the constructs in NEST_OPEN.
    stop=None: scan to the end and return (text, len(s)); in the text unquoted newlines are ' ; '
      and each heredoc body is dropped (kept in HEREDOC_BODIES when `record`, with a \\x03N marker).
    stop=")": s[i] is just inside a `$(`; return (text, index just past its closing `)`).
    stop="))": s[i] is the `$` of a `$((`; return (text, index just past its `))`).
    nested: s is already inside a substitution (see ends_heredoc).
    A substitution inside double quotes, inside a NEST_OPEN construct or in backticks is copied
    through whole; the caller analyzes its text separately (substitutions())."""
    if level > 20:
        raise Parse("substitutions nest too deeply")
    out, n, q = [], len(s), None
    dqb = 0  # open `${` inside the current double-quoted string
    dbk_paren = 0  # parens open inside the current `[[ ]]`
    dbk = False  # inside an unquoted `[[ ]]`, where ksh93 reads a `<<` after `=~` as a heredoc
    pending = []  # (delimiter, dash, body id or None, paren depth) for bodies that start at the next newline
    stack = []  # closers of the open NEST_OPEN constructs, innermost last
    depth = 1  # parens open since the start (for stop=")", the `$(` itself)
    subst = nested  # a `(` or backtick came first: see ends_heredoc
    while i < n:
        c = s[i]
        if q == "'":
            out.append(c)
            if c == "'":
                q = None
            i += 1
            continue
        if q == '"':
            if c == "\\" and i + 1 < n:
                out.append(s[i : i + 2])
                i += 2
                continue
            if c == '"':
                if dqb:
                    # bash and dash nest a double-quoted word in a double-quoted `${ }`; zsh and ksh
                    # end the string here. Deny rather than pick one (blueprint#210).
                    raise Parse('a `"` inside a double-quoted ${ }')
                q = None
            elif s.startswith("${", i):
                check_funsub(s, i)
                dqb += 1
                out.append("${")
                i += 2
                continue
            elif dqb and c in "{'":
                # bash also counts a bare `{` inside the expansion and may read `'...'` there as
                # quoting a `}`, so dqb could reach 0 while the shell is still inside it.
                raise Parse("a `{` or `'` inside a double-quoted ${ }")
            elif c == "}" and dqb:
                dqb -= 1
            elif c == "`" or s.startswith("$(", i):
                # Parsed on its own: a quote or heredoc body inside it does not end the outer string.
                j = embedded_end(s, i, level)
                out.append(s[i:j])
                i = j
                continue
            out.append(c)
            i += 1
            continue
        if c == "\\" and i + 1 < n:
            out.append(" " if s[i + 1] == "\n" else s[i : i + 2])
            i += 2
            continue
        if c in "'\"":
            q = c
            out.append(c)
            i += 1
            continue
        if c == "#" and not stack:
            p = prev_src(s, i)
            if p >= 0 and s[p] == ")" and not escaped(s, p):
                # Shells differ on a # glued to a `)`: a comment, or a word that can open a quote.
                raise Parse("a `#` right after a `)`; put a blank before the comment")
            if (
                p >= 1
                and s[p] == "("
                and not escaped(s, p)
                and not command_start_paren(s, p)
            ):
                # An extglob `@(` or a zsh extended-glob flag `(#i)` makes the # part of a word.
                raise Parse("a `#` right after a `(` that is not a subshell or `$(`")
            if word_start(s, i):
                # An unquoted word-initial # starts a comment: skip to end of line.
                j = s.find("\n", i)
                i = n if j < 0 else j
                continue
        if c == "`" or (stack and s.startswith("$(", i) and not s.startswith("$((", i)):
            # In backticks the shell ends a heredoc body at the closing backtick, so the text is
            # copied through whole and analyzed on its own, like a `$( )` in ${ } or arithmetic.
            subst = subst or c == "`"
            j = embedded_end(s, i, level)
            out.append(s[i:j])
            i = j
            continue
        if not stack:
            if dbk and c == "(":
                dbk_paren += (
                    1  # blanks are allowed inside a paren group on the right of =~
                )
            elif dbk and c == ")" and dbk_paren:
                dbk_paren -= 1
            if (
                dbk
                and not dbk_paren
                and s.startswith("]]", i)
                and s[i - 1] in " \t\n"
                and not escaped(s, i - 1)
                and (i + 2 >= n or s[i + 2] in " \t\n;&|)")
            ):
                dbk = False
            elif (
                not dbk
                and s.startswith("[[", i)
                and (
                    s[i + 2 : i + 3] in (" ", "\t", "\n") or s.startswith("\\\n", i + 2)
                )
                and word_start(s, i)
            ):
                dbk, dbk_paren = True, 0
        k = nest_step(s, i, stack)
        if k:
            out.append(s[i : i + k])
            i += k
            if stop == "))" and not stack:
                return "".join(out), i
            continue
        if dbk and s.startswith("<<", i):
            raise Parse("a `<<` inside [[ ]], where ksh93 starts a heredoc")
        if s.startswith("<<<", i):
            out.append(
                "<<<"
            )  # a here-string: its word is data, no body follows on later lines
            i += 3
            continue
        if s.startswith("<<", i):
            if stack and stack[-1] == "}":
                raise Parse("a `<<` inside ${ }")
            if stack:
                out.append("<<")  # a shift in arithmetic
                i += 2
                continue
            delim, quoted, end, dash = heredoc_word(s, i)
            hid = None
            if record:
                HEREDOC_BODIES.append([])
                HEREDOC_QUOTED.append(quoted)
                hid = len(HEREDOC_BODIES) - 1
                out.append(" \x03%d " % hid)  # marker: the body belongs to this command
            else:
                out.append(" ")
            pending.append((delim, dash, hid, depth, quoted))
            i = end
            continue
        if c == "\n":
            out.append(" ; ")
            i += 1
            if pending and stack:
                raise Parse(
                    "a newline inside $(( )), (( )), ${ } or $[ ] while a heredoc waits for its body"
                )
            while pending:
                delim, dash, hid, _, quoted = pending.pop(0)
                while True:
                    if i >= n:
                        raise Parse("a heredoc with no terminator line")
                    j = s.find("\n", i)
                    line = s[i:] if j < 0 else s[i:j]
                    i = n if j < 0 else j + 1
                    if not quoted and (len(line) - len(line.rstrip("\\"))) % 2:
                        # In an unquoted body the shell joins this line with the next one before it
                        # looks for the terminator; rather than join, deny.
                        raise Parse(
                            "an unquoted heredoc body line that ends in a backslash; quote the delimiter (<<'EOF')"
                        )
                    if ends_heredoc(line, delim, dash, subst):
                        break
                    if hid is not None:
                        HEREDOC_BODIES[hid].append(line)
            continue
        if c == "(":
            subst = True
            depth += 1
        elif c == ")":
            depth -= 1
            if pending and depth < min(p[3] for p in pending):
                # `$(cat <<EOF)`: the body would start after the substitution has closed.
                raise Parse(
                    "a `)` that closes a substitution before its heredoc body starts"
                )
            if stop == ")" and depth == 0:
                return "".join(out), i + 1
        elif (
            stop
            and s.startswith("case", i)
            and s[i + 4 : i + 5] in (" ", "\t", "\n")
            and "".join(out).rstrip(" \t")[-1:] in ("", ";", "&", "|", "(")
        ):
            # A `pat)` in a case statement would end the substitution here before the shell does.
            raise Parse("a case statement inside a $( ) substitution")
        out.append(c)
        i += 1
    if q:
        raise Parse("unterminated quote")
    if stack:
        raise Parse(
            "an unbalanced $(( )), (( )), ${ } or $[ ]"
        )  # fail closed: a `<<` in it was a guess
    if pending:
        raise Parse("a heredoc with no body")
    if stop:
        raise Parse("an unterminated $( ) or $(( ))")
    return "".join(out), n


def preprocess(cmd, nested=False):
    """Unquoted newlines become ';' and heredoc bodies are dropped (see scan())."""
    return scan(cmd, nested=nested)[0]


def close_paren(s, i):
    """Index just past the `)` that closes a `$(` whose text starts at s[i]; for a `$((`, s[i] is its
    second `(` and the index is just past the `))`. It uses the same scan as preprocess(), so quoted
    text, comments and heredoc bodies (a body line `1) item` or `:)`) do not close it early (blueprint#168)."""
    if s.startswith("(", i):
        return scan(s, i - 2, nested=True, stop="))", record=False)[1]
    return scan(s, i, nested=True, stop=")", record=False)[1]


def substitutions(cmd, body=False):
    """Inner text of $(...) and `...` outside single quotes. body: cmd is the body of an unquoted
    heredoc, where quotes are literal text, so `it's $(cmd)` still runs cmd (blueprint#197)."""
    subs, i, n, q = [], 0, len(cmd), None
    while i < n:
        c = cmd[i]
        if q == "'":
            if c == "'":
                q = None
        elif c == "\\":
            i += 1
        elif body and c in "'\"":
            pass
        elif c == "'" and q is None:
            q = "'"
        elif c == '"':
            q = None if q == '"' else '"'
        elif cmd.startswith("$((", i):
            # Arithmetic is not a command; only the substitutions inside it run (blueprint#168 round 2).
            j = close_paren(cmd, i + 2)
            subs.extend(substitutions(cmd[i + 3 : max(i + 3, j - 2)]))
            i = j - 1
        elif cmd.startswith("$(", i):
            j = close_paren(cmd, i + 2)
            subs.append(cmd[i + 2 : j - 1])
            # The inner text is analyzed on its own, where a quoted heredoc in it is literal; scanning
            # on through it here would run the backticks of `$(cat <<'EOF' ... EOF)` (blueprint#168).
            i = j - 1
        elif c == "`":
            j = backtick_end(cmd, i)
            if j:
                subs.append(backtick_text(cmd, i, j, q == '"' or body))
                i = j - 1
        i += 1
    return subs


def backtick_text(s, i, j, in_dq):
    """The command text of the backtick substitution s[i:j]. The shell removes the backslash of
    \\$, \\` and \\\\ inside backticks before it parses the text, so `echo \\`cmd\\`` nests a
    substitution; the inner text is unescaped the same way (blueprint#197). Inside
    double quotes (or a heredoc body) shells differ on \\", so that is denied."""
    text = s[i + 1 : j - 1]
    if in_dq and '\\"' in text:
        raise Parse('a \\" inside a backtick substitution in double quotes')
    return re.sub(r"\\([$`\\])", r"\1", text)


def strip_redirects(seg):
    """Drop leading redirections (`>f`, `2>&1`, `<in`) so the real command is first."""
    seg = list(seg)
    while seg:
        if (
            re.fullmatch(r"[0-9]+", seg[0])
            and len(seg) > 1
            and re.fullmatch(r"[<>&]+", seg[1])
        ):
            seg.pop(0)
        if seg and re.fullmatch(r"[<>&]+", seg[0]):
            seg = seg[2:]
        else:
            break
    return seg


MASKED = "<>;&|()"
MASK = {ch: chr(0x10 + k) for k, ch in enumerate(MASKED)}
UNMASK = {v: k for k, v in MASK.items()}


def mask_quoted(s):
    """Replace shell operator characters that are quoted or escaped with inert sentinels, so a
    quoted `">"` is never taken for a redirect (and a quoted `;` never for a separator)."""
    out, q, i, n = [], None, 0, len(s)
    while i < n:
        c = s[i]
        if q == "'":
            out.append(MASK.get(c, c))
            if c == "'":
                q = None
        elif q == '"':
            if c == "\\" and i + 1 < n:
                out.append(c)
                out.append(MASK.get(s[i + 1], s[i + 1]))
                i += 2
                continue
            out.append(MASK.get(c, c))
            if c == '"':
                q = None
        else:
            if c == "\\" and i + 1 < n:
                out.append(c)
                out.append(MASK.get(s[i + 1], s[i + 1]))
                i += 2
                continue
            if c in "'\"":
                q = c
            out.append(c)
        i += 1
    return "".join(out)


_REVPARSE = r"\$\(\s*git\s+(?:-C\s+\.\s+)?rev-parse\s+(?:--path-format=[a-z]+\s+)?"
GIT_DIR_SUBST = re.compile(
    _REVPARSE + r"(?:--git-common-dir|--git-dir|--absolute-git-dir)\s*\)"
)
GIT_PATH_SUBST = re.compile(_REVPARSE + r"--git-path\s+([^\s()`$;&|<>]+)\s*\)")
READLINK_SUBST = re.compile(
    r"\$\(\s*(?:readlink\s+-[fem]|realpath)\s+([^\s()`$;&|<>]+)\s*\)"
)
SUBST_PREFIX = re.compile(r"(?:\$\(([^()`]*)\)|`([^`]*)`)(?=/[^\s/;&|()<>$`]+)")
# Substitutions that only print a directory, so `$(npm bin)/eslint` keeps a literal, inspectable
# basename. Anything else (`$(echo 'git push -f')/y`) is word-split by the shell and can become
# any command, so it stays a substituted word (blueprint#168 security review).
SAFE_PREFIX_INNER = re.compile(
    r"\s*(?:npm\s+(?:bin|root)(?:\s+-g)?|pnpm\s+(?:bin|root)|yarn\s+bin|go\s+env\s+[A-Z]+|brew\s+--prefix(?:\s+[\w@.+-]+)?"
    r"|python3?\s+-m\s+site\s+--user-base|dirname\s+[^()`;&|<>]+)\s*"
)
SUBST_WORD = re.compile(r"\$__SUBSTX([0-9]+)__")


def collapse_substitutions(pre):
    """Replace each unquoted $( ... ) or `...` with one word, $__SUBSTX<n>__ (the inner text is kept
    in STATE["subst"][n] and analyzed on its own). Without this the `)` splits the simple command,
    so `git push $(true) --force` hid --force in a separate segment (blueprint#168 security review)."""
    out, i, n, q = [], 0, len(pre), None
    while i < n:
        c = pre[i]
        if q == "'":
            out.append(c)
            if c == "'":
                q = None
            i += 1
            continue
        if c == "\\" and i + 1 < n:
            out.append(pre[i : i + 2])
            i += 2
            continue
        if c == "'" and q is None:
            q = "'"
        elif c == '"':
            q = None if q == '"' else '"'
        elif q is None and pre.startswith("$((", i):
            # Arithmetic expands to a number. Any $( ) inside it was analyzed by substitutions();
            # keep the expansion one inert word so `n=$(( $(git rev-list --count HEAD) + 1 ))` is
            # not read as a substituted command word (blueprint#168 round 2).
            out.append("0")
            i = close_paren(pre, i + 2)
            continue
        elif q is None and pre.startswith("$(", i):
            j = close_paren(pre, i + 2)
            STATE["subst"].append(pre[i + 2 : j - 1])
            out.append("$__SUBSTX%d__" % (len(STATE["subst"]) - 1))
            i = j
            continue
        elif q is None and c == "`":
            j = backtick_end(pre, i)
            if j:
                STATE["subst"].append(backtick_text(pre, i, j, False))
                out.append("$__SUBSTX%d__" % (len(STATE["subst"]) - 1))
                i = j
                continue
        out.append(c)
        i += 1
    return "".join(out)


def split_segments(pre):
    """Split already preprocessed text into simple commands. Returns (segs, seps, hds, rds):
    rds[i] are the output-redirect targets of segs[i]."""
    pre = re.sub(
        r"\$\(\s*(?:pwd|git\s+rev-parse\s+--show-toplevel)\s*\)|`\s*pwd\s*`",
        "$PWD",
        pre,
    )
    # The git dir spellings reach the installed hooks in .git/hooks (blueprint#168).
    pre = GIT_PATH_SUBST.sub(
        lambda m: ".git/" + m.group(1), GIT_DIR_SUBST.sub(".git", pre)
    )
    pre = READLINK_SUBST.sub(lambda m: m.group(1), pre)
    # A substitution that only prints a directory and prefixes a literal path (`$(npm bin)/eslint`)
    # leaves the basename inspectable (blueprint#168).
    pre = SUBST_PREFIX.sub(
        lambda m: (
            "$__SUBST__"
            if SAFE_PREFIX_INNER.fullmatch(
                m.group(1) if m.group(1) is not None else m.group(2)
            )
            else m.group(0)
        ),
        pre,
    )
    pre = collapse_substitutions(pre)
    lex = shlex.shlex(mask_quoted(pre), posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    lex.commenters = (
        ""  # comments are already removed by scan(); a `#` inside a word is part of it
    )
    try:
        toks = list(lex)
    except ValueError as e:
        raise Parse(str(e))
    segs, cur, seps, hds, curh = [], [], [], [], []
    for t in toks:
        if t and (
            all(ch in ";&|()" for ch in t)
            or (t.endswith("(") and all(ch in "<>(" for ch in t))
        ):  # includes <( and >( process substitution
            segs.append(cur)
            hds.append(curh)
            seps.append(t)
            cur, curh = [], []
        elif t.startswith("\x03") and t[1:].isdigit():
            curh.append(int(t[1:]))
        else:
            cur.append(t)
    segs.append(cur)
    hds.append(curh)
    rds = [redirect_targets(sg) for sg in segs]
    segs = [[t.translate(UNMASK_TABLE) for t in strip_redirects(sg)] for sg in segs]
    # seps[i] is the separator after segs[i]
    return segs, seps, hds, rds


UNMASK_TABLE = str.maketrans(UNMASK)


def cluster(arg):
    """Short-option letters of a single-dash cluster like -uf, else ''."""
    return arg[1:] if re.fullmatch(r"-[A-Za-z0-9]+", arg) else ""


def abbrev(arg, longopt, minlen=4):
    a = arg.split("=", 1)[0]
    return a.startswith("--") and len(a) >= minlen and longopt.startswith(a)


GIT_VALUE_OPTS = {
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--super-prefix",
    "--config-env",
    "--exec-path",
}
STASH_HINT = "git stash uses the refs/stash shared by every worktree; use `scripts/wt stash` instead (only `git stash list|show` is allowed)."
OUTPUT_SUBCOMMANDS = {
    "diff",
    "log",
    "show",
    "reflog",
    "stash",
    "cherry",
    "whatchanged",
    "diff-tree",
    "diff-files",
    "diff-index",
    "range-diff",
    "format-patch",
}
AUTOMERGE = "merge_request.merge"
AUTOMERGE_ALT = "merge_request.auto_merge"


def is_automerge(text):
    return AUTOMERGE in text or AUTOMERGE_ALT in text


def check_git_config(kv):
    k = kv.lower()
    if k.startswith("core.hookspath"):
        deny(
            "`git -c core.hooksPath=...` disables the repository hooks; CLAUDE.md forbids skipping hooks."
        )
    if re.match(r"(remote\.[^=]*\.push|push\.pushoption)", k):
        deny(
            "a configured push refspec or push option can force-push or auto-merge past this hook; pass real flags."
        )
    if k.startswith("alias."):
        deny(
            "`git -c alias.*` can smuggle a denied git command past this hook; spell the command out."
        )
    if k.startswith(("include.", "includeif.")):
        deny(
            "`git -c include.path=...` loads another config file, which can set core.hooksPath; ask the user."
        )


MESSAGE_SUBCOMMANDS = {"commit", "merge", "tag", "notes", "revert"}
OPT_VALUE_LONG = (
    "--message",
    "--file",
    "--author",
    "--date",
    "--reuse-message",
    "--reedit-message",
    "--template",
)


def option_words(rest):
    """The arguments that are options or operands, without the values of -m/-F/-C/-c/-t and their long forms."""
    kept, skip = [], False
    for a in rest:
        if skip:
            skip = False
            continue
        kept.append(a)
        if a in OPT_VALUE_LONG:
            skip = True
            continue
        c = cluster(a)
        for idx, ch in enumerate(c):
            if ch in "mFCct":
                skip = (
                    idx == len(c) - 1
                )  # bare -m takes the next argument; -mfix has its value attached
                break
            if ch in "uS":
                break
    return kept


GIT_CONFIG_WRITE = {
    "--add",
    "--unset",
    "--unset-all",
    "--replace-all",
    "--edit",
    "-e",
    "--rename-section",
    "--remove-section",
}
GIT_CONFIG_READ = {
    "--get",
    "--get-all",
    "--get-regexp",
    "--get-urlmatch",
    "--get-color",
    "--get-colorbool",
    "--list",
    "-l",
    "--show-origin",
    "--show-scope",
}
GIT_CONFIG_VALUE_OPTS = {"-f", "--file", "--blob", "--type", "--default"}


def config_is_write(rest):
    """False for the read-only forms of `git config`: a read flag with a lone key, or a lone key.
    Round 5 (blueprint#118): a name plus a value, or a set/unset/edit subcommand, is a write
    whatever the read flags (`git config core.hooksPath /tmp/h --list` wrote the config)."""
    if any(a in GIT_CONFIG_WRITE for a in rest):
        return True
    pos, skip, key_seen = [], False, False
    for a in rest:
        if key_seen:
            # Round 6: git stops option parsing at the first non-option, so after the key every
            # word is a value (`git config core.hooksPath -x` writes `-x`); `--` is no separator.
            if a != "--":
                pos.append(a)
        elif skip:
            skip = False
        elif a in GIT_CONFIG_VALUE_OPTS:
            skip = True
        elif not a.startswith("-"):
            pos.append(a)
            # A get/list subcommand takes options after it (`get --all <name>`); a key does not.
            key_seen = a not in (
                "get",
                "list",
                "set",
                "unset",
                "edit",
                "rename-section",
                "remove-section",
            )
    if pos[:1] and pos[0] in (
        "set",
        "unset",
        "edit",
        "rename-section",
        "remove-section",
    ):
        return True
    if pos[:1] and pos[0] in ("get", "list"):
        return len(pos) > (2 if pos[0] == "get" else 1)
    if len(pos) >= 2:
        return True
    if any(a in GIT_CONFIG_READ for a in rest):
        return False
    return len(pos) != 1


UNLOCK_TTL = 4 * 3600
UNLOCK_SKILLS = ("mass_merge", "release")
UNLOCK = {"skill": ""}


def load_unlock(event):
    """Sets UNLOCK["skill"] when a user-typed /mass_merge or /release left a valid marker.

    `.claude/hooks/user-skill-unlock.sh` (a UserPromptExpansion hook, documented to run when a
    user-typed command expands into a prompt) writes `.claude/state/skill-unlock.json`. This is
    a guard against agent mistakes, not a security boundary: the docs do not say whether a
    scheduled /loop or cross-session slash command also fires that event, and the Bash/Edit
    tamper guards miss routes such as `python3 -c`. The marker counts only for the session that
    wrote it, for UNLOCK_TTL seconds, and only in the main session: an event that carries
    agent_id or agent_type (a subagent) never unlocks. Anything unreadable or malformed leaves
    the denies in force.
    """
    if event.get("agent_id") or event.get("agent_type"):
        return
    sid = event.get("session_id")
    proj = os.environ.get("CLAUDE_PROJECT_DIR", "") or STATE["event_cwd"]
    if not (isinstance(sid, str) and sid and proj.startswith("/")):
        return
    path = os.path.join(proj, ".claude", "state", "skill-unlock.json")
    try:
        if os.path.islink(path) or not os.path.isfile(path):
            return
        with open(path) as fh:
            m = json.load(fh)
        age = time.time() - float(m["ts"])
        if (
            m.get("session_id") == sid
            and m.get("skill") in UNLOCK_SKILLS
            and -60 <= age <= UNLOCK_TTL
        ):
            UNLOCK["skill"] = m["skill"]
    except Exception:
        return


def check_git(args):
    args = strip_redirects(args)
    i, sub = 0, None
    while i < len(args):
        a = args[i]
        if a in GIT_VALUE_OPTS:
            if a == "-c" and i + 1 < len(args):
                check_git_config(args[i + 1])
            i += 2
            continue
        if a.startswith("--config-env="):
            check_git_config(a.split("=", 1)[1].split("=", 1)[0] + "=")
        if a.startswith("-c") and len(a) > 2:
            check_git_config(a[2:])
        if a.startswith("-"):
            i += 1
            continue
        sub = a
        break
    if sub is None:
        return
    if (
        "__SUBSTX" in sub
        or "$(" in sub
        or "`" in sub
        or re.fullmatch(r"\$\{?[A-Za-z_][A-Za-z0-9_]*\}?", sub)
    ):
        deny(
            "a git subcommand produced by a substitution or a variable cannot be inspected by this hook; spell it out."
        )
    # `git -C DIR rm x` removes DIR/x (blueprint#168 security review).
    cdirs = [args[k + 1] for k in range(i) if args[k] == "-C" and k + 1 < i]
    rest = strip_redirects(args[i + 1 :])

    def under_c(a):
        return os.path.join(cdirs[-1], a) if cdirs and not a.startswith("/") else a

    if (
        sub == "config"
        and config_is_write(rest)
        and any(
            x.lower().startswith(
                (
                    "alias.",
                    "core.hookspath",
                    "push.pushoption",
                    "include.",
                    "includeif.",
                )
            )
            or re.match(r"remote\.[^=]*\.push", x.lower())
            for x in rest
        )
    ):
        deny(
            "`git config alias.*` / `core.hooksPath` / `include.path` can smuggle denied git commands or disable hooks; ask the user."
        )
    for a in option_words(rest) if sub in MESSAGE_SUBCOMMANDS else rest:
        if a == "--no-verify" or abbrev(a, "--no-verify", 6):
            if sub == "push" and UNLOCK["skill"] == "mass_merge":
                continue  # /mass_merge pushes its rebased branches with --no-verify
            deny(
                "`--no-verify` skips the git hooks; CLAUDE.md forbids it. Fix what the hook reports instead."
            )
    if sub in OUTPUT_SUBCOMMANDS:
        for a in rest:
            if a == "--":
                break
            if abbrev(a, "--output", 5):
                deny(
                    "`git "
                    + sub
                    + " --output=<file>` writes an arbitrary file; read the output from stdout."
                )
    if sub in ("rm", "mv") and any(
        protected(under_c(a), True) for a in rest if not a.startswith("-")
    ):
        deny(
            "`git "
            + sub
            + "` of settings or hook files deletes protected files; ask the user."
        )
    if sub == "clone":
        pos = [a for a in rest if not a.startswith("-")]
        if len(pos) > 1 and protected(under_c(pos[-1]), parent=True, git=True):
            deny(
                "`git clone` into a protected path (settings, hooks, .git) overwrites it; ask the user."
            )
    if sub == "checkout-index" and any(
        a.startswith("--prefix=")
        and protected(under_c(a.split("=", 1)[1]), parent=True, git=True)
        for a in rest
    ):
        deny(
            "`git checkout-index --prefix` into a protected path (settings, hooks, .git) overwrites it; ask the user."
        )
    if sub in ("format-patch", "archive"):
        for k, a in enumerate(rest):
            val = None
            if a.startswith(("--output=", "--output-directory=")):
                val = a.split("=", 1)[1]
            elif a in ("-o", "--output", "--output-directory") and k + 1 < len(rest):
                val = rest[k + 1]
            elif re.fullmatch(r"-o.+", a):
                val = a[2:]
            if val is not None and protected(val):
                deny(
                    "`git "
                    + sub
                    + " -o` would write into a protected path (settings, hooks); ask the user."
                )
    if (
        sub == "bundle"
        and rest[:1] == ["create"]
        and len(rest) > 1
        and protected(rest[1])
    ):
        deny(
            "`git bundle create` would write a protected path (settings, hooks); ask the user."
        )
    if sub == "commit":
        for a in option_words(rest):
            for ch in cluster(a):
                if (
                    ch in "mFCctuS"
                ):  # the rest of the cluster is this option's (attached or optional) value
                    break
                if ch == "n":
                    deny(
                        "`git commit -n` is `--no-verify`; CLAUDE.md forbids skipping the hooks."
                    )
    if sub == "push":
        for k, a in enumerate(rest):
            if a == "--force" or "f" in cluster(a):
                deny(
                    "force push is forbidden (CLAUDE.md). Use `--force-with-lease` on your own feature branch after a rebase."
                )
            if a.startswith("+"):
                deny(
                    "a `+ref` refspec is a force push; CLAUDE.md forbids it. Use `--force-with-lease`."
                )
            if a.startswith(":"):
                deny(
                    "a `:ref` refspec deletes the remote ref; delete branches through an MR or ask the user."
                )
            if (
                "d" in cluster(a)
                or abbrev(a, "--delete")
                or abbrev(a, "--mirror")
                or abbrev(a, "--prune")
            ):
                deny(
                    "`git push --delete/-d/--mirror` deletes remote refs; ask the user."
                )
            if is_automerge(
                a
            ):  # whatever the spelling of the push-option flag (--push-opt, -uo, ...)
                deny(
                    "a push option that enables auto-merge is forbidden; a person merges (CLAUDE.md)."
                )
    elif sub == "stash":
        if not rest or rest[0] not in ("list", "show"):
            deny(
                "bare `git stash` (and push/pop/apply/drop/clear) is forbidden. "
                + STASH_HINT
            )
    elif (
        sub == "reset"
        and any(abbrev(a, "--hard", 4) for a in rest)
        and not (UNLOCK["skill"] == "release" and rest in (["--hard", "origin/main"],))
    ):
        deny(
            "`git reset --hard` discards uncommitted work silently; commit or copy aside first, or ask the user."
        )
    elif sub == "clean" and any(a == "--force" or "f" in cluster(a) for a in rest):
        deny(
            "forced `git clean` deletes untracked files irrecoverably; use `git clean -n` to preview and ask the user."
        )


def check_glab(args):
    pos, i = [], 0
    while i < len(args) and len(pos) < 2:
        a = args[i]
        if a in ("-R", "--repo", "-g", "--group", "--hostname"):
            i += 2
            continue
        if not a.startswith("-"):
            pos.append(a)
        i += 1
    if pos[:1] == ["alias"]:
        deny(
            "`glab alias` can rename a denied subcommand past this hook; spell the command out."
        )
    if pos[:2] in (["mr", "merge"], ["mr", "accept"]) and not (
        UNLOCK["skill"] == "mass_merge" and pos[:2] == ["mr", "merge"]
    ):
        deny(
            "`glab mr merge` is forbidden: a coding agent never merges an MR (CLAUDE.md). Hand the MR URL to the user."
        )
    if pos[:1] == ["api"]:
        blob = " ".join(args)
        if (
            MERGE_ENDPOINT.search(endpoint_text(args))
            or "mergeRequestAccept" in blob
            or "mergeRequestSetAutoMerge" in blob
        ):
            deny(
                "merging through `glab api` is forbidden: a coding agent never merges an MR (CLAUDE.md)."
            )


SAFE_ROOTS = (
    "/tmp",
    "/private/tmp",
    "/var/tmp",
    "/private/var/tmp",
    "/var/folders",
    "/private/var/folders",
)
HOME_RE = re.compile(r"/(?:Users|home)/[^/]+(?:/|$)")


SYSTEM_TOP = {
    "usr",
    "etc",
    "var",
    "opt",
    "bin",
    "sbin",
    "lib",
    "lib64",
    "tmp",
    "private",
    "system",
    "library",
    "volumes",
    "mnt",
    "dev",
    "proc",
    "sys",
    "root",
    "boot",
    "applications",
}


def git_toplevel(path):
    """The nearest directory at or above `path` that holds a .git (directory, or a worktree's
    .git file), so `../hooks/x` typed in a subdirectory still reaches the top-level hooks/ (blueprint#168)."""
    d = os.path.normpath(path)
    for _ in range(40):
        if os.path.exists(os.path.join(d, ".git")):
            return d
        up = os.path.dirname(d)
        if up == d:
            break
        d = up
    return ""


def common_checkout(top):
    """For a linked worktree (its .git is a `gitdir: ...` file), the main checkout that owns the
    shared git dir, found through the worktree's `commondir` file; else "" (blueprint#168 round 2: the
    main checkout's .git must be protected from a session started inside a scripts/wt worktree)."""
    try:
        dotgit = os.path.join(top, ".git")
        if not os.path.isfile(dotgit):
            return ""
        with open(dotgit, encoding="utf-8", errors="replace") as fh:
            m = re.match(r"gitdir:\s*(.+)", fh.read(4096).strip())
        if not m:
            return ""
        gitdir = os.path.normpath(os.path.join(top, m.group(1).strip()))
        common = gitdir
        cfile = os.path.join(gitdir, "commondir")
        if os.path.isfile(cfile):
            with open(cfile, encoding="utf-8", errors="replace") as fh:
                common = os.path.normpath(os.path.join(gitdir, fh.read(4096).strip()))
        return os.path.dirname(common) if os.path.basename(common) == ".git" else ""
    except OSError:
        return ""


ROOTS_CACHE = {}
CWD_ONLY_ROOTS = set()  # roots that are only the session's cwd, not a project top


def project_roots():
    cwd = STATE["event_cwd"]
    key = (os.environ.get("CLAUDE_PROJECT_DIR", ""), cwd)
    if key in ROOTS_CACHE:
        return ROOTS_CACHE[key]
    roots = []
    top = git_toplevel(cwd) if cwd.startswith("/") else ""
    found = (
        {os.path.normpath(top), os.path.normpath(common_checkout(top))}
        if top
        else set()
    )
    # Outermost first: a path is reduced against the first root it is under, so the project
    # top must come before a subdirectory the session happens to be in.
    for r in (key[0], top, common_checkout(top) if top else "", cwd):
        if not r.startswith("/"):
            continue
        r = os.path.normpath(r)
        comps = [c for c in r.split("/") if c]
        # Any depth is a project (/workspaces/app, /app), but never the filesystem root, a
        # system directory, or a home directory itself. A directory found by its .git is a
        # project even under a system directory (a scratch repository in /tmp).
        if not comps or (comps[0] in ("Users", "home") and len(comps) <= 2):
            continue
        if comps[0].lower() in SYSTEM_TOP and r not in found:
            continue
        if r not in roots:
            roots.append(r)
    norm_cwd = os.path.normpath(cwd) if cwd.startswith("/") else ""
    if (
        norm_cwd in roots
        and norm_cwd not in found
        and norm_cwd != os.path.normpath(key[0] or "/")
    ):
        CWD_ONLY_ROOTS.add(norm_cwd.lower())
    ROOTS_CACHE[key] = roots
    return roots


def inside(path, root):
    return path == root or path.startswith(root.rstrip("/") + "/")


def broad_rm_target(tt):
    """True when an absolute or home-relative `rm -rf` target is too broad (blueprint#165)."""
    home = os.environ.get("HOME", "").rstrip("/")
    if tt.startswith("~/"):
        tt = (home or "/Users/~") + tt[1:]
    if not tt.startswith("/"):
        return False
    tt = os.path.normpath(tt)
    tmp = os.environ.get("TMPDIR", "").rstrip("/")
    safe = SAFE_ROOTS + (
        (os.path.normpath(tmp),) if tmp.startswith("/") and tmp.count("/") >= 2 else ()
    )
    roots = project_roots()
    for r in roots:
        if tt == r or r.startswith(tt + "/"):
            return True  # the project itself or any directory above it
    base = os.path.basename(tt)
    if base == ".git":
        return True
    # A glob that empties a scratch root (`/tmp/*`) is as bad as the root.
    glob_root = re.fullmatch(r"[*?.\[\]]+", base) is not None and any(
        os.path.dirname(tt) == s for s in safe + tuple(roots)
    )
    if glob_root:
        return True
    if tt in safe or (
        tt.startswith(("/var/folders/", "/private/var/folders/"))
        and tt.count("/") < (5 if tt.startswith("/var") else 6)
    ):
        return True  # the scratch root itself, or one user's whole temp tree
    if any(inside(tt, r) for r in roots) or any(inside(tt, s) for s in safe):
        return False
    if (home and inside(tt, home)) or HOME_RE.match(tt):
        # Under home: a project-local path was allowed above; ~/a/b is a repo or data
        # directory, not something an agent created for itself.
        rel = (
            tt[len(home) :]
            if home and inside(tt, home)
            else tt.split("/", 3)[3]
            if tt.count("/") >= 3
            else ""
        )
        return len([c for c in rel.split("/") if c]) < 3
    return True  # /etc/x, /usr/local/x, /opt/x: outside every directory the agent owns


def hits_project(full):
    """True when absolute path (or glob) `full` is a project root or a directory above one."""
    import fnmatch

    for r in project_roots():
        anc = r
        while anc not in ("/", ""):
            if full == anc or (
                any(ch in full for ch in "*?[") and fnmatch.fnmatchcase(anc, full)
            ):
                return True
            anc = os.path.dirname(anc)
    return False


def check_rm(args):
    rec = force = False
    targets = []
    for a in args:
        if a == "--":
            continue
        if abbrev(a, "--recursive", 4):
            rec = True
        elif abbrev(a, "--force", 4):
            force = True
        elif a.startswith("--"):
            pass
        elif cluster(a):
            c = cluster(a)
            rec = rec or "r" in c or "R" in c
            force = force or "f" in c
        else:
            targets.append(a)
    if (
        not rec
    ):  # `rm -r` deletes read-only files without asking when stdin is not a terminal
        return
    for t in targets:
        tt = t.replace("${HOME}", "~").replace("$HOME", "~").rstrip("/") or "/"
        # ~ itself, ~/*, or a direct child of home are all too broad to rm -rf blindly.
        top = (
            tt in ("/", "~", ".", "..", "*", ".git", "/*", "~/*", "./*")
            or re.fullmatch(r"~/[^/]*", tt) is not None
        )
        top = top or re.fullmatch(r"/[^/]*", tt) is not None or ".." in tt.split("/")
        rel = not tt.startswith(("/", "~"))
        # `./.git`, `sub/../.git` and `x/.git` are the same as `.git` (blueprint#168).
        top = top or (
            rel and (os.path.normpath(tt) in (".", "..") or ".git" in candidates(tt))
        )
        if top:
            deny(
                "`rm -r "
                + t
                + "` targets a root, home, repository or parent directory; name the exact subdirectory you created."
            )
        if rel and not tt.startswith("$"):
            # A relative target resolves under the working directory, or under X after `cd X`:
            # `cd ~/repos && rm -rf blueprint` removes the project (blueprint#168). Only the project and
            # the directories above it count here, so `rm -rf node_modules` in /usr/src/app is
            # not judged as an absolute path outside the project.
            for b in bases():
                if b is not None and hits_project(
                    os.path.normpath(os.path.join(b, tt))
                ):
                    deny(
                        "`rm -r "
                        + t
                        + "` after `cd` resolves to the project or a directory above it; name the exact subdirectory you created."
                        + cd_hint()
                    )
        m = re.match(r"^(?:\$\{?OLDPWD\}?|~-)(?=/|$)", t)
        if m and STATE["oldpwd"] is not None:
            # `cd /tmp && rm -rf $OLDPWD` removes the directory the line started in (blueprint#168).
            rest = t[m.end() :].lstrip("/")
            for b in bases_of(STATE["oldpwd"]):
                full = (
                    os.path.normpath(os.path.join(b, rest))
                    if b
                    else os.path.normpath(rest or ".")
                )
                if (b is None and full in (".", ".git")) or (
                    b is not None and (hits_project(full) or full.endswith("/.git"))
                ):
                    deny(
                        "`rm -r "
                        + t
                        + "` resolves to the directory the line started in (the project, or its .git); name the exact subdirectory you created."
                    )
        if broad_rm_target(tt):
            deny(
                "`rm -r "
                + t
                + "` is outside the project and the temp directories (or is the project, a parent of it, or a home directory two levels deep); remove only a subdirectory you created."
            )


# --- tamper guard: Bash writes to the files the Edit/Write deny rules protect (blueprint#165) ---
PROTECTED = re.compile(
    r"^(?:\./)*hooks(?:/|$)"
    r"|^\$\{?[a-z_][a-z0-9_]*\}?/hooks(?:/|$)"
    r"|(?:^|/)\.claude/(?:hooks(?:/|$)|settings(?:\.[^/]*)?\.json$)"
    r"|^/.*/hooks/(?:pre-commit|pre-push)$"  # a sibling worktree's hooks/
    r"|(?:^|/)\.claude/state(?:/|$)"  # the skill-unlock marker (#4868)
    r"|(?:^|/)scripts/lib/harness-paths\.txt$"  # the harness list itself (blueprint#118, ADR 0010)
    # The INSTALLED hooks and the config that can relocate them (blueprint#168): removing or relinking
    # .git/hooks/pre-push, or setting core.hooksPath in .git/config, amounts to --no-verify.
    # `make setup` (scripts/setup-hooks.sh) installs them; the hook never sees inside a script.
    r"|(?:^|/)\.git/(?:hooks(?:/|$)|config$|config\.worktree$|worktrees/[^/]+/config\.worktree$)",
    re.I,
)
DOTDOT = re.compile(r"\.\.(?:/\.\.)*")
# Protected prefixes, component by component, for operands that contain glob characters.
# (components, exact): `exact` means the path must end there, a prefix also covers children.
GLOB_PROTECTED = [
    ([".claude", "hooks"], False),
    ([".claude", "state"], False),
    (["hooks"], False),
    ([".claude", "settings.json"], True),
    ([".claude", "settings.local.json"], True),
    ([".git", "hooks"], False),
    ([".git", "config"], True),
    ([".git", "config.worktree"], True),  # blueprint#168
]
REDIRECT_OP = re.compile(r"(?:[0-9]*|&)>{1,2}[|&]?")
# Commands that write or remove every file operand.
WRITERS_ANY = {
    "tee",
    "truncate",
    "chmod",
    "chown",
    "touch",
    "mv",
    "ed",
    "ex",
    "patch",
    "unlink",
    "shred",
    "rmdir",
    "mkdir",
    "sponge",
    "rm",
}
REMOVERS = {"rm", "mv", "rmdir", "unlink", "shred"}
TAMPER_NAMES = WRITERS_ANY | {
    "sed",
    "perl",
    "ruby",
    "cp",
    "install",
    "rsync",
    "ln",
    "dd",
    "curl",
    "wget",
    "sort",
    "find",
    "tar",
    "unzip",
}
# blueprint#168 security review: more writers, and other names for the same tool.
COMPRESSORS = {
    "gzip",
    "gunzip",
    "bzip2",
    "bunzip2",
    "xz",
    "unxz",
    "zstd",
    "unzstd",
    "lzma",
    "unlzma",
}
TAMPER_NAMES |= COMPRESSORS | {
    "ditto",
    "base64",
    "xxd",
    "uniq",
    "awk",
    "gawk",
    "cpio",
    "gtar",
    "bsdtar",
    "scp",
}
TOOL_ALIASES = {"gtar": "tar", "bsdtar": "tar", "gawk": "awk"}
# Wrappers whose option values and positional arguments (timeout DURATION, flock FILE,
# env -u NAME, sudo -u USER, xargs -I{}) may sit between them and the real command.
TRANSPARENT = WRAPPERS | {"timeout"}


def brace_expand(p, limit=64):
    out = [p]
    for _ in range(6):
        nxt, changed = [], False
        for q in out:
            m = None
            for cand in re.finditer(r"\{([^{}]*)\}", q):
                if "," in cand.group(1):
                    m = cand
                    break
            if m is None:
                nxt.append(q)
                continue
            changed = True
            nxt.extend(
                q[: m.start()] + alt + q[m.end() :] for alt in m.group(1).split(",")
            )
        out = nxt[:limit]
        if not changed:
            break
    return out


def bases():
    """The directories a relative operand may be relative to in the current segment (blueprint#168):
    each possible cwd, made absolute against the session's working directory when it is known.
    None means "relative to the project root", the assumption when nothing is known."""
    return bases_of(STATE["cwds"])


def bases_of(cwds):
    ev = STATE["event_cwd"] if STATE["event_cwd"].startswith("/") else ""
    out = []
    for c in cwds:
        if c is None:
            b = ev or None
        elif c == UNKNOWN:
            b = None
        elif c.startswith("/") or not ev:
            b = c
        else:
            b = os.path.join(ev, c)
        if b not in out:
            out.append(b)
    return out


def candidates(path):
    """Normalized, case-folded spellings of a path operand, relative to the project root when possible."""
    p = path.split("=", 1)[1] if path.startswith("of=") else path
    res = []
    home = os.environ.get("HOME", "").rstrip("/")
    roots = [r.lower() for r in project_roots()]
    for q in brace_expand(p):
        if home.startswith("/"):
            q = re.sub(
                r"^(?:~|\$HOME|\$\{HOME\})(?=/|$)", home.replace("\\", "\\\\"), q
            )
        root_rel = re.match(r"^\$\{?claude_project_dir\}?(?=/|$)", q, re.I) is not None
        old = re.match(r"^(?:\$\{?OLDPWD\}?|~-)(?=/|$)", q) is not None
        if old and STATE["oldpwd"] is None:
            res.append(os.path.normpath(q).lower())
            continue
        q = re.sub(
            r"^(?:\$\{?(?:pwd|claude_project_dir|oldpwd)\}?|~-)(?=/|$)",
            ".",
            q,
            flags=re.I,
        )
        for b in bases_of(STATE["oldpwd"]) if old else bases():
            r = q
            # `$VAR/hooks/x` and `~user/x` do not move with a cd; keep them as written.
            if q and not q.startswith(("/", "$", "~")) and b and not root_rel:
                r = os.path.join(
                    b, q
                )  # resolved against the directory the command runs in
            r = os.path.normpath(r).lower() if r else r
            # Reduce against every project root the path is under (a worktree inside the main
            # checkout is under both), but not against a root that is only the session's cwd
            # when a real project top also holds the path (`docs/hooks/x` is not `hooks/x`).
            matches = [root for root in roots if r == root or r.startswith(root + "/")]
            if len(matches) > 1:
                matches = [m for m in matches if m not in CWD_ONLY_ROOTS] or matches
            for red in [r[len(m) :].lstrip("/") or "." for m in matches] or [r]:
                if red not in res:
                    res.append(red)
    return res


def glob_protected(q, parent):
    import fnmatch

    comps = [c for c in q.split("/") if c]
    if not comps or q.startswith("/") or not any(ch in q for ch in "*?["):
        return False
    if len(comps) == 1 and re.fullmatch(r"[*?]+", comps[0]):
        return False  # a bare `*` is not aimed at hooks

    def match(proto, exact):
        if len(comps) < len(proto) or (exact and len(comps) != len(proto)):
            return False
        for sample, pat in zip(proto, comps):
            if sample.startswith(".") and not pat.startswith("."):
                return (
                    False  # the shell never matches a dotfile with a leading wildcard
                )
            if not fnmatch.fnmatchcase(sample, pat):
                return False
        return True

    if parent and match([".claude"], True):
        return True
    return any(match(proto, exact) for proto, exact in GLOB_PROTECTED)


def git_tree_glob(q):
    """A glob whose first component can match .git (`.gi*`, `.[g]it`, `.g?t/objects`) (blueprint#168)."""
    import fnmatch

    comps = [c for c in q.split("/") if c]
    return (
        bool(comps)
        and comps[0].startswith((".", "["))
        and comps[0] != ".git"
        and any(ch in comps[0] for ch in "*?[")
        and fnmatch.fnmatchcase(".git", comps[0])
    )


def protected(path, parent=False, git=False, tree=False):
    """True when writing `path` tampers with settings, hooks or the repository itself.
    parent: the command removes the operand, so a directory above a protected file counts too.
    tree: the command removes or moves the operand outright (rm, mv, rmdir, unlink, shred), so
    the project's .git, the project root and any directory above it count as well (blueprint#168:
    `mv .git /tmp/x` is as final as `rm -rf .git`).
    git: the operand is a copy or link destination, where landing on .git itself overwrites it."""
    if worker_write_bad(path):
        return True  # the /wave worker tier (ADR 0010): outside the worker's worktree, or its harness
    roots = [r.lower() for r in project_roots()]
    for q in candidates(path):
        if PROTECTED.search(q) or glob_protected(q, parent):
            return True
        if parent and q == ".claude":
            return True
        if (tree or git) and (q == ".git" or git_tree_glob(q)):
            return True
        if tree and (
            q == "."
            or DOTDOT.fullmatch(q)
            or (
                q.startswith("/")
                and any(r.startswith(q.rstrip("/") + "/") for r in roots)
            )
        ):
            return True
        # Removing anything inside the project's .git (objects, HEAD, refs) breaks the repository;
        # a stale lock file (`rm -f .git/index.lock`) is the one routine exception.
        if tree and q.startswith(".git/") and not q.endswith(".lock"):
            return True
    return False


def cd_hint():
    """A `cd` chained with `;` may have failed; say why the original directory was checked too."""
    if len(STATE["cwds"]) > 1 and None in STATE["cwds"]:
        return " A `cd` followed by `;` runs the rest of the line in the original directory when the cd fails, so that directory is checked too; chain with `&&`."
    return ""


def redirect_targets(raw):
    """Redirect targets of one simple command, as (op, path): output `> f`, `>> f`, `>| f`, `2> f`,
    `&> f`, `>& f`, and input `< f`. Runs on the masked token stream, so a quoted ">" is never an
    operator. analyze() checks them once the segment's working directory is known (blueprint#168)."""
    out = []
    for k, t in enumerate(raw):
        if k + 1 >= len(raw):
            continue
        nxt = raw[k + 1].translate(UNMASK_TABLE)
        if REDIRECT_OP.fullmatch(t):
            if t.endswith("&") and (nxt.isdigit() or nxt == "-"):
                continue  # fd duplication such as 2>&1
            out.append((">>" if ">>" in t else ">", nxt))
        elif re.fullmatch(r"[0-9]*<", t):
            out.append(("<", nxt))
    return out


def check_redirects(rd):
    for op, path in rd:
        if op in (">", ">>") and protected(path):
            deny(
                "redirecting output into "
                + path
                + " rewrites a protected file (settings, hooks); the Edit/Write deny rules cover it and so does this hook. Ask the user."
                + cd_hint()
            )


def command_index(toks):
    k = 0
    while k < len(toks) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", toks[k]):
        k += 1
    return k


def check_tamper(toks):
    k = command_index(toks)
    if k >= len(toks):
        return
    first = os.path.basename(toks[k])
    if first in TAMPER_NAMES:
        tamper_one(TOOL_ALIASES.get(first, first), toks[k + 1 :])
        return
    if first in TRANSPARENT:
        # Behind a wrapper: its own options and positional arguments precede the real command
        # (`sudo find / -delete` included since blueprint#168).
        for j in range(k + 1, len(toks)):
            name = os.path.basename(toks[j])
            if name in TAMPER_NAMES:
                tamper_one(TOOL_ALIASES.get(name, name), toks[j + 1 :])
                return


def tar_hit(args, target):
    """tar writes to the -f archive when creating, and when extracting into the -C directory or,
    with no -C, onto each member named on the command line (blueprint#168: `tar -xzf x.tgz hooks/pre-push`)."""
    first = args[0] if args else ""
    clusters = [a[1:] for a in args if re.fullmatch(r"-[A-Za-z]+", a)]
    old_style = (
        bool(first)
        and not first.startswith("-")
        and re.fullmatch(r"[A-Za-z]+", first) is not None
    )
    if old_style:
        clusters.insert(0, first)  # old style: tar czf out.tgz dir
    letters = "".join(clusters)
    extract = "x" in letters or "--extract" in args or "--get" in args
    create = (
        "c" in letters or "--create" in args or "r" in letters or "u" in letters
    ) and not extract
    fval, cval, values = None, None, set()
    for i, a in enumerate(args):
        if a.startswith("--file="):
            fval = a[7:]
        elif a.startswith("--directory="):
            cval = a[12:]
        elif a == "--file" and i + 1 < len(args):
            fval = args[i + 1]
            values.add(i + 1)
        elif a in ("--directory", "-C") and i + 1 < len(args):
            cval = args[i + 1]
            values.add(i + 1)
        elif (
            re.fullmatch(r"-?[A-Za-z]*f", a)
            and i + 1 < len(args)
            and (a.startswith("-") or i == 0)
        ):
            fval = args[i + 1]
            values.add(i + 1)
        elif a.startswith("-C") and len(a) > 2:
            cval = a[2:]
        elif a in (
            "-T",
            "-X",
            "--files-from",
            "--exclude-from",
            "--exclude",
            "-b",
            "--blocking-factor",
        ) and i + 1 < len(args):
            values.add(i + 1)
    if create and fval is not None and target(fval):
        return fval
    if not extract:
        return None
    for a in args:
        if a.startswith("--one-top-level=") and target(a.split("=", 1)[1], "extract"):
            return a.split("=", 1)[1]
    if target(cval if cval is not None else ".", "extract"):
        return cval if cval is not None else "."
    if cval is not None:
        return None
    for i, a in enumerate(args):
        if i in values or a.startswith("-") or (i == 0 and old_style):
            continue
        if target(a):
            return a  # a named member lands at that path in the working directory
    return None


# Tests that narrow a deleting find to some files. -type, -size, -newer and -mtime do not:
# `-type f -delete` or `-size +0 -delete` empties .git (blueprint#168 security review).
FIND_NAME_TESTS = {
    "-name",
    "-iname",
    "-path",
    "-ipath",
    "-wholename",
    "-iwholename",
    "-regex",
    "-iregex",
    "-empty",
}
PROTECTED_NAMES = {
    "pre-commit",
    "pre-push",
    "settings.json",
    "settings.local.json",
    ".git",
    "hooks",
    ".claude",
    "config",
}
FIND_EXEC = ("-exec", "-execdir", "-ok", "-okdir")


def find_parts(args):
    """(start points, expression) of a find command line."""
    k = 0
    while k < len(args) and (
        args[k] in ("-H", "-L", "-P", "-D") or re.fullmatch(r"-O[0-9]*", args[k])
    ):
        k += 2 if args[k] == "-D" else 1
    starts = []
    while (
        k < len(args)
        and not args[k].startswith("-")
        and args[k] not in ("(", "!", ")", ",")
    ):
        starts.append(args[k])
        k += 1
    return starts, args[k:]


def find_exec_cmds(expr):
    out = []
    for i, a in enumerate(expr):
        if a in FIND_EXEC:
            sub = []
            for x in expr[i + 1 :]:
                if x in (";", "+"):
                    break
                sub.append(x)
            if sub:
                out.append(unwrap_exec(sub))
    return out


def unwrap_exec(sub):
    """The real command of a `find -exec` sub-command, behind any wrapper (`-exec env rm {} +`,
    `-exec timeout 9 rm`, `-exec nice sed -i`) (blueprint#168 completeness round). An `env -S '...'` string
    is returned as `sh -c '...'` so it counts as shell code."""
    k, split = real_command_word(sub)
    if split is not None:
        return ["sh", "-c", split[0] + (" " + shlex.join(split[1]) if split[1] else "")]
    sub = sub[k:] or sub
    if (
        os.path.basename(sub[0]) in WRAPPERS
    ):  # a wrapper without a known option table (parallel, watch)
        for j in range(1, len(sub)):
            if os.path.basename(sub[j]) in TAMPER_NAMES | SHELLS | REMOVERS:
                return sub[j:]
    return sub


def runs_shell_code(sub):
    return os.path.basename(sub[0]) in SHELLS and any(
        re.fullmatch(r"-[A-Za-z]*c[A-Za-z]*", x) for x in sub[1:]
    )


def find_writes(expr):
    """Does the find expression write or remove the files it visits (or a file it names)?"""
    if any(a in ("-delete", "-fprint", "-fprint0", "-fprintf", "-fls") for a in expr):
        return True
    for sub in find_exec_cmds(expr):
        # {} stands for each visited file, so it counts as a target wherever the writer puts it.
        if (
            write_hit(
                os.path.basename(sub[0]),
                sub[1:],
                lambda p, kind="": "{}" in p or tamper_target(p, kind),
            )
            is not None
        ):
            return True
        if runs_shell_code(sub):
            return True
    return False


def find_removes(expr):
    if "-delete" in expr:
        return True
    return any(
        os.path.basename(sub[0]) in REMOVERS or runs_shell_code(sub)
        for sub in find_exec_cmds(expr)
    )


def find_rewrites_visited(expr):
    """Does an -exec writer change the files find visits (`-exec chmod -x {} +`, `-exec sed -i`)?
    Those are judged by start point and pattern like a delete (blueprint#168 round 2)."""
    return any(
        write_hit(os.path.basename(sub[0]), sub[1:], lambda p, kind="": "{}" in p)
        is not None
        for sub in find_exec_cmds(expr)
    )


# Paths under the project a deleting or rewriting find must not reach, relative to its root, and
# ordinary paths: a pattern that matches all of the latter narrows nothing.
FIND_PROTECTED = [
    ".git",
    ".git/HEAD",
    ".git/config",
    ".git/objects/ab/cd",
    ".git/hooks",
    ".git/hooks/pre-push",
    "hooks",
    "hooks/pre-commit",
    "hooks/pre-push",
    ".claude",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/hooks",
    ".claude/hooks/pre-bash-deny.sh",
]
FIND_GENERIC = [
    "src/x.py",
    "a",
    "README.md",
    "docs/b/c.txt",
    "node_modules/p/index.js",
    "build/out.o",
]


def find_protected_samples(start):
    """The protected paths a find started at `start` would visit, spelled as find prints them."""
    s = start.rstrip("/") or "/"
    out = []
    for q in candidates(start):
        if (
            q == "."
            or DOTDOT.fullmatch(q)
            or q.startswith("/")
            and any(r.lower().startswith(q.rstrip("/") + "/") for r in project_roots())
        ):
            out += [
                s + "/" + p for p in FIND_PROTECTED
            ]  # the project, or a directory above it
            continue
        for p in FIND_PROTECTED:
            if p == q:
                out.append(s)
            elif p.startswith(q.rstrip("/") + "/"):
                out.append(s + "/" + p[len(q.rstrip("/")) + 1 :])
    return out


def find_pattern_matches(test, pat, path):
    """Does find's `test pat` match `path`? -name/-iname look at the basename, the -i forms fold
    case, -regex/-iregex must match the whole path. An unreadable regex counts as a match."""
    import fnmatch

    fold = test in ("-iname", "-ipath", "-iwholename", "-iregex")
    subject = os.path.basename(path) if test in ("-name", "-iname") else path
    if test in ("-regex", "-iregex"):
        try:
            return re.fullmatch(pat, subject, re.I if fold else 0) is not None
        except re.error:
            return True
    if fold:
        return fnmatch.fnmatchcase(subject.lower(), pat.lower())
    return fnmatch.fnmatchcase(subject, pat)


def check_find_starts(starts, expr):
    """A deleting find is judged by the directories it walks, like `rm -r` (blueprint#168): `find / -delete`
    and `find ~ -delete` are `rm -rf /` and `rm -rf ~`. The project itself (`.`) is allowed only
    with a name test (`find . -name '*.pyc' -delete`), and a scratch root likewise."""
    # A test narrows only when nothing can widen it again (`!`, -not, -o, -or) and its pattern does
    # not match everything (blueprint#168 security review: `find . ! -name x -delete`). Patterns are judged
    # by testing them against sample paths, the way find applies them (blueprint#168 round 2: `-path './*'`,
    # `-regex '.+'`, `-iname .GIT`, `-path './[.]git'`).
    widened = any(a in ("!", "-not", "-o", "-or", ",") for a in expr)
    tests = [
        (a, expr[i + 1])
        for i, a in enumerate(expr)
        if a in FIND_NAME_TESTS and a != "-empty" and i + 1 < len(expr)
    ]
    starts = starts or ["."]  # GNU find walks . when no start point is given
    narrowing = False
    for s in starts:
        prot = find_protected_samples(s)
        generic = [s.rstrip("/") + "/" + g for g in FIND_GENERIC] + [s]
        for a, v in tests:
            if any(find_pattern_matches(a, v, p) for p in prot):
                deny(
                    "`find "
                    + s
                    + " "
                    + a
                    + " "
                    + v
                    + "` that deletes or rewrites what it finds can reach .git, the hooks or the settings; ask the user."
                )
            narrowing = narrowing or not all(
                find_pattern_matches(a, v, g) for g in generic
            )
    filtered = not widened and ("-empty" in expr or narrowing)
    tmp = os.environ.get("TMPDIR", "").rstrip("/")
    safe = SAFE_ROOTS + ((os.path.normpath(tmp),) if tmp.startswith("/") else ())
    roots = [r.lower() for r in project_roots()]
    ev = STATE["event_cwd"] if STATE["event_cwd"].startswith("/") else ""

    def absolute_bad(tt):
        if filtered and os.path.normpath(tt) in safe:
            return False  # find /tmp -name 'blueprint-*' -delete
        if (
            tt in ("/", "~")
            or re.fullmatch(r"~/[^/]*", tt)
            or re.fullmatch(r"/[^/]*", tt)
        ):
            return True
        if os.path.normpath(tt).lower() in roots:
            return not filtered  # the project itself, like `.`
        return broad_rm_target(tt)

    for s in starts:
        tt = s.replace("${HOME}", "~").replace("$HOME", "~").rstrip("/") or "/"
        bad = False
        if tt.startswith(("/", "~")):
            bad = absolute_bad(tt)
        else:
            for c in STATE["cwds"]:
                # After `cd /tmp/build`, `find . -delete` walks /tmp/build, not the project.
                base = (
                    None
                    if c in (None, UNKNOWN)
                    else c
                    if c.startswith("/")
                    else os.path.join(ev, c)
                    if ev
                    else None
                )
                if base is not None:
                    bad = bad or absolute_bad(os.path.normpath(os.path.join(base, tt)))
                    continue
                n = os.path.normpath(tt)
                if n in (".", "*") or re.fullmatch(
                    r"\$\{?(?:PWD|CLAUDE_PROJECT_DIR)\}?", n
                ):
                    bad = bad or not filtered
                elif ".." in n.split("/") or any(
                    q == ".git" or q.startswith(".git/") for q in candidates(tt)
                ):
                    bad = True
        if bad:
            deny(
                "`find "
                + s
                + "` that deletes or rewrites what it finds (-delete, -exec rm, -exec sed -i, ...) walks a root, home, project, parent or .git directory; that is `rm -rf` of it. Name the exact subdirectory you created, or add a -name test."
                + cd_hint()
            )


def copy_operands(args):
    """(sources, destinations) of cp/install/ln/mv: the -t/--target-directory value, else the last operand."""
    dests, pos, k = [], [], 0
    while k < len(args):
        a = args[k]
        if a == "--":
            pos.extend(args[k + 1 :])
            break
        if a.startswith("--"):
            if a.startswith("--target-directory="):
                dests.append(a.split("=", 1)[1])
            elif abbrev(a, "--target-directory", 4) and k + 1 < len(args):
                dests.append(args[k + 1])
                k += 1
            elif a in (
                "--suffix",
                "--backup",
                "--mode",
                "--owner",
                "--group",
            ) and k + 1 < len(args):
                k += 1
        elif a.startswith("-") and len(a) > 1:
            for idx, ch in enumerate(a[1:], 1):
                if ch == "t":
                    if a[idx + 1 :]:
                        dests.append(a[idx + 1 :])
                    elif k + 1 < len(args):
                        dests.append(args[k + 1])
                        k += 1
                    break
                if ch == "S":
                    if not a[idx + 1 :]:
                        k += 1
                    break
        else:
            pos.append(a)
        k += 1
    if not dests and pos:
        return pos[:-1], [pos[-1]]
    return pos, dests


def tamper_target(p, kind=""):
    """kind: "" an operand the command writes; "rm" one it removes or moves away; "dest" a copy,
    move or link destination."""
    if (
        kind == "extract"
    ):  # an archive unpacked into this directory can land on anything below it
        return protected(p, parent=True, git=True)
    return protected(p, parent=kind == "rm", git=kind == "dest", tree=kind == "rm")


RSYNC_VALUE_OPTS = {
    "-e",
    "--rsh",
    "--exclude",
    "--include",
    "--exclude-from",
    "--include-from",
    "-f",
    "--filter",
    "--files-from",
    "--chmod",
    "--chown",
    "--link-dest",
    "--compare-dest",
    "--copy-dest",
    "--backup-dir",
    "--suffix",
    "-T",
    "--temp-dir",
    "--partial-dir",
    "--log-file",
    "--password-file",
    "--port",
    "--timeout",
    "--max-size",
    "--min-size",
    "--bwlimit",
    "-M",
    "--remote-option",
    "--rsync-path",
    "--out-format",
    "--usermap",
    "--groupmap",
    "--iconv",
    "-B",
    "--block-size",
    "--max-delete",
    "--modify-window",
    "--sockopts",
    "--info",
    "--debug",
    "--contimeout",
    "--address",
    "--outbuf",
    "--log-file-format",
}
SCP_VALUE_OPTS = {"-P", "-i", "-o", "-F", "-l", "-c", "-J", "-S", "-D", "-X"}


def positionals(args, value_opts):
    """Operands of a command, skipping the values of options that take one."""
    out, skip = [], False
    for k, a in enumerate(args):
        if skip:
            skip = False
        elif a == "--":
            out.extend(args[k + 1 :])
            break
        elif a in value_opts:
            skip = True
        elif not a.startswith("-") or a == "-":
            out.append(a)
    return out


def write_hit(name, args, target):
    """The single writer table (blueprint#168), shared by the tamper guard and by `find -exec`, so the two
    can no longer drift apart. Returns the operand that `name args` writes, removes or moves for
    which target(path, kind) holds, else None."""
    name = TOOL_ALIASES.get(name, name)
    if name == "tar":
        return tar_hit(args, target)
    if name == "unzip":
        dval, pos, skip = None, [], False
        for i, a in enumerate(args):
            if skip:
                skip = False
            elif a == "-d" and i + 1 < len(args):
                dval, skip = args[i + 1], True
            elif a in ("-x", "-P") and i + 1 < len(args):
                skip = a == "-P"
            elif not a.startswith("-"):
                pos.append(a)
        if target(dval if dval is not None else ".", "extract"):
            return dval if dval is not None else "."
        return next(
            (m for m in pos[1:] if dval is None and target(m)), None
        )  # named members
    if name == "cpio":
        if any(
            a == "--pass-through" or re.fullmatch(r"-[A-Za-z]*p[A-Za-z]*", a)
            for a in args
        ):
            # `cpio -pd DEST`: copies the names on stdin into DEST (blueprint#168 round 2).
            d = next((a for a in args if not a.startswith("-")), None)
            return d if d is not None and target(d, "extract") else None
        if any(
            a in ("-i", "--extract") or re.fullmatch(r"-[A-Za-z]*i[A-Za-z]*", a)
            for a in args
        ):
            d = next(
                (
                    args[i + 1]
                    for i, a in enumerate(args)
                    if a in ("-D", "--directory") and i + 1 < len(args)
                ),
                ".",
            )
            return d if target(d, "extract") else None
        return None
    if name in COMPRESSORS:
        # They replace each operand with its (de)compressed file, unless writing to stdout.
        if any(
            a in ("-c", "--stdout", "-k", "--keep", "-t", "--test", "-l", "--list")
            or re.fullmatch(r"-[A-Za-z]*[ckt][A-Za-z]*", a)
            for a in args
        ):
            return None
        return next((a for a in args if not a.startswith("-") and target(a)), None)
    if name == "base64":
        outs = [
            args[i + 1]
            for i, a in enumerate(args)
            if a in ("-o", "--output") and i + 1 < len(args)
        ] + [a.split("=", 1)[1] for a in args if a.startswith("--output=")]
        return next((o for o in outs if target(o)), None)
    if name in ("xxd", "uniq"):
        pos = [a for a in args if not a.startswith("-")]
        return pos[1] if len(pos) > 1 and target(pos[1]) else None  # INFILE OUTFILE
    if name == "awk":
        inplace = (
            any(
                args[i] == "-i" and i + 1 < len(args) and args[i + 1] == "inplace"
                for i in range(len(args))
            )
            or "-iinplace" in args
        )
        return next(
            (a for a in args if inplace and not a.startswith("-") and target(a)), None
        )
    if name in ("cp", "install", "rsync", "ln", "mv", "ditto", "scp"):
        # Only the destination is written; the sources of a copy or link are read, and the
        # sources of a move are removed.
        if name in ("rsync", "scp"):
            # The destination is the last operand once option values are skipped (blueprint#168 round 2:
            # `rsync -a --delete /tmp/e/ . --exclude node_modules` lands on `.`, not node_modules).
            pos = positionals(
                args, RSYNC_VALUE_OPTS if name == "rsync" else SCP_VALUE_OPTS
            )
            srcs, dests = pos[:-1], pos[-1:]
        else:
            srcs, dests = copy_operands(args)
        for d in dests:
            if target(d, "dest"):
                return d
            # Copying a .git directory onto the project root or its .git replaces the repository.
            if (
                name in ("cp", "rsync", "mv", "scp", "ditto")
                and any(os.path.basename(os.path.normpath(s)) == ".git" for s in srcs)
                and target(d, "rm")
            ):
                return d
            # `rsync --delete SRC/ DEST` removes whatever DEST has that SRC lacks: onto the project
            # root, a parent of it, .git or .claude, that is `rm -rf` of it (blueprint#168 completeness round).
            if (
                name == "rsync"
                and any(a.startswith("--del") for a in args)
                and target(d, "rm")
            ):
                return d
        if name == "rsync" and "--remove-source-files" in args:
            for s in srcs:
                if target(s, "rm"):
                    return s
        if name in ("mv", "ln"):
            # A move removes its sources; a link to the project, its .git or a hook is a second
            # writable path to it (`ln -s $PWD /tmp/p && cd /tmp/p && echo x > hooks/y`).
            for s in srcs:
                if target(s, "rm"):
                    return s
        return None
    kind = "rm" if name in REMOVERS else ""
    hits = [a for a in args if target(a, kind)]
    if not hits:
        return None
    flags = [a for a in args if a.startswith("-")]
    if name in ("sed", "perl", "ruby"):
        ok = inplace_flag(name, args)
    elif name == "dd":
        hits = [a for a in hits if a.startswith("of=")]
        ok = bool(hits)
    elif name in ("curl", "wget"):
        ok = any(
            a in ("-o", "-O", "-P", "--output", "--output-dir", "--directory-prefix")
            or a.startswith(("--output=", "--output-document", "--directory-prefix="))
            or re.match(r"-[A-Za-z]*[oOP]$", a) is not None
            for a in flags
        )
    elif name == "sort":
        ok = any(a == "-o" or a.startswith("--output") for a in flags)
    else:
        ok = name in WRITERS_ANY
    return hits[0] if ok else None


# Single-dash letters after which the rest of the cluster (or the next argument) is a value.
INPLACE_VALUE_LETTERS = {"sed": "efl", "perl": "MmIeExFCdDV", "ruby": "rIeECxKF"}


def inplace_flag(name, args):
    """True when sed/perl/ruby is invoked with -i[SUFFIX] or --in-place."""
    for a in args:
        if a == "--":
            break
        if a.startswith("--"):
            if name == "sed" and abbrev(a, "--in-place", 4):
                return True
            continue
        if re.fullmatch(r"-[A-Za-z0-9].*", a):
            for ch in a[1:]:
                if ch == "i":
                    return True
                if ch in INPLACE_VALUE_LETTERS[name]:
                    break  # -Mstrict, -rtime, -e script: the rest is a value, not more flags
    return False


def tamper_one(name, args):
    if name == "find":
        starts, expr = find_parts(args)
        if find_removes(expr) or find_rewrites_visited(expr):
            check_find_starts(starts, expr)
        if any(protected(a) for a in args) and find_writes(expr):
            deny(
                "`find` would delete or modify a protected file (settings, hooks); ask the user."
                + cd_hint()
            )
        return
    hit = write_hit(name, args, tamper_target)
    if hit is None:
        return
    if not protected(hit, parent=True) and protected(hit, tree=True, git=True):
        deny(
            "`"
            + name
            + " "
            + hit
            + "` moves, removes or overwrites the repository (.git, the project root or a directory above it); that is as final as `rm -rf .git`. Ask the user."
            + cd_hint()
        )
    deny(
        "`"
        + name
        + "` would modify "
        + hit
        + ", a protected file (settings, hooks, the installed .git/hooks or .git/config); the Edit/Write deny rules cover it and so does this hook. Ask the user."
        + cd_hint()
    )


# --- GitLab quick actions in posted text (blueprint#165) ---
QUICK_MERGE = re.compile(
    r"/merge(?:_when_pipeline_succeeds|_when_build_succeeds)?(?![A-Za-z0-9_/.-])", re.I
)
QUICK_AT_LINE_START = re.compile(
    r"(?:^|\n|\\n|\\u000a|[=\"']|^-[A-Za-z])[ \t]*" + QUICK_MERGE.pattern, re.I
)
QUICK_HEREDOC = re.compile(r"^[ \t]*" + QUICK_MERGE.pattern, re.I)
QUICK_MSG = "is a GitLab quick action that merges the MR; a coding agent never merges (CLAUDE.md). Rephrase the text."


def decode_escapes(s):
    """printf/echo -e escapes: \\xHH, \\NNN / \\0NNN octal, \\n (blueprint#168: `printf '\\057merge'`)."""

    def one(m):
        if m.group(1):
            return chr(int(m.group(1), 16))
        if m.group(2):
            return chr(int(m.group(2), 8) % 256)
        return "\n"

    return re.sub(r"\\x([0-9a-fA-F]{1,2})|\\0?([0-7]{1,3})|\\n", one, s)


def quick_variants(a):
    """The text GitLab ends up with: a URL-encoded (%2Fmerge, %0A) or JSON-escaped (\\/merge,
    \\u002fmerge) body, or printf escapes (\\x2f, \\057), decode to the same /merge (blueprint#168)."""
    out = [a]
    if "%" in a:
        out.append(unquote_plus(a))
    if "\\" in a:
        out.append(re.sub(r"\\u002[fF]", "/", a.replace("\\/", "/")))
        out.append(decode_escapes(a))
    return out


def printed_text(name, args):
    """Roughly what echo or printf prints: printf's format with %s/%b/%d filled in order, and
    escapes decoded, so `printf '/m%s' erge` and `printf 'x\\n%s' /merge` are seen as printed."""
    if name == "echo":
        words = [a for a in args if not re.fullmatch(r"-[neE]+", a)]
        return decode_escapes(" ".join(words))
    if not args:
        return ""
    fmt, rest = args[0], list(args[1:])
    out = re.sub(
        r"%[-0-9.]*[sbdiq]",
        lambda m: rest.pop(0) if rest else "",
        fmt.replace("%%", "\x01"),
    )
    return decode_escapes(out.replace("\x01", "%")) + (
        "\n" + " ".join(rest) if rest else ""
    )


def body_has_quick(text):
    return any(
        QUICK_AT_LINE_START.search(v)
        or any(QUICK_HEREDOC.match(line) for line in v.splitlines())
        for v in quick_variants(text)
    )


def check_quick_action(args):
    for a in args:
        if any(QUICK_AT_LINE_START.search(v) for v in quick_variants(a)):
            deny(
                "a note, description or API body with a line starting `/merge` "
                + QUICK_MSG
            )


def file_paths(f):
    """The places file operand f may name: resolved against $HOME, and $PWD or a relative path
    against every directory the segment may run in."""
    home = os.environ.get("HOME", "")
    if home.startswith("/"):
        f = re.sub(r"^(?:~|\$HOME|\$\{HOME\})(?=/|$)", home.replace("\\", "\\\\"), f)
    f = re.sub(r"^\$\{?PWD\}?(?=/|$)", ".", f)
    if f.startswith("/"):
        return [os.path.normpath(f)]
    return [os.path.normpath(os.path.join(b, f)) for b in bases() if b] + [
        os.path.normpath(f)
    ]


def record_file(p, texts):
    """Remember what this command line writes into p, under every spelling that names it."""
    for key in file_paths(p):
        STATE["heredoc_files"][key] = list(texts)


BODY_CAP = 1 << 20


def body_texts(f, strict=False):
    """What file f holds: the text an earlier segment of this command wrote there, else the file
    on disk. strict: a body file over BODY_CAP is denied rather than skipped."""
    for key in file_paths(f):
        if key in STATE["heredoc_files"]:
            return list(STATE["heredoc_files"][key])
    for path in file_paths(f):
        try:
            if os.path.isfile(
                path
            ):  # a regular file: never a FIFO or a device, which could block
                if os.path.getsize(path) > BODY_CAP:
                    if strict:
                        deny(
                            "the body file "
                            + f
                            + " is too large to inspect for a `/merge` quick action (fail closed)."
                        )
                    return []
                with open(path, encoding="utf-8", errors="replace") as fh:
                    return [fh.read()]
        except OSError:
            pass
    return []


def check_body_file(f, strict=True):
    """A body read from a file (`-d @f`, `-F body=@f`, `--input f`, `< f`, `$(cat f)`): check the text
    an earlier segment of this command wrote there (a heredoc, echo or printf, or a tee fed by
    one), else the file on disk (blueprint#168). A file some other program writes earlier on the same line
    stays unseen."""
    if any(body_has_quick(t) for t in body_texts(f, strict)):
        deny("the body file " + f + " has a line starting `/merge`, which " + QUICK_MSG)


def render_substitutions(a):
    """`a` with each $( ) / backtick / collapsed substitution replaced by what it prints, when
    it is a plain echo or printf; other substitutions become empty."""

    def printed(inner):
        try:
            words = shlex.split(re.sub(r"\x03[0-9]+", " ", inner))
        except ValueError:
            return ""
        return (
            printed_text(os.path.basename(words[0]), words[1:])
            if words and os.path.basename(words[0]) in ("echo", "printf")
            else ""
        )

    out = SUBST_WORD.sub(lambda m: printed(STATE["subst"][int(m.group(1))]), a)
    out = re.sub(r"\$\(([^()]*)\)", lambda m: printed(m.group(1)), out)
    return re.sub(r"`([^`]*)`", lambda m: printed(m.group(1)), out)


def post_files(args, glab=False):
    """Files a glab/curl/wget post reads its body from (for glab also `-F FILE` / `--file FILE`)."""
    out = []
    for i, a in enumerate(args):
        if (
            glab
            and a in ("-F", "--file")
            and i + 1 < len(args)
            and args[i + 1] != "-"
            and "=" not in args[i + 1]
        ):
            out.append(args[i + 1])
            continue
        if (
            a in ("--input", "-T", "--upload-file")
            and i + 1 < len(args)
            and args[i + 1] != "-"
        ):
            out.append(args[i + 1])
            continue
        if a.startswith(("--input=", "--upload-file=")) and a.split("=", 1)[1] != "-":
            out.append(a.split("=", 1)[1])
            continue
        m = re.fullmatch(r"(?:[^=@<\s]+=|[A-Za-z0-9_.-]+(?=@))?[@<](.+)", a)
        if m and m.group(1) != "-":
            out.append(m.group(1))
    return out


def check_sub_text(text, ids):
    """The text of a command substitution that a post uses as a body: a heredoc line, what an echo
    or printf prints (anywhere, since printf can start a line), or any file a word names, whatever
    reads it (cat, tac, head, sed, a glob) (blueprint#168)."""
    import glob

    if any(QUICK_HEREDOC.match(line) for h in ids for line in HEREDOC_BODIES[h]):
        deny(
            "a heredoc in a command substitution with a line starting `/merge` "
            + QUICK_MSG
        )
    text = re.sub(r"\x03[0-9]+", " ", text)
    try:
        words = shlex.split(text)
    except ValueError:
        words = text.split()
    printed = [text]
    for k, w in enumerate(words):
        if os.path.basename(w) in ("printf", "echo"):
            printed.append(
                printed_text(
                    os.path.basename(w),
                    [x for x in words[k + 1 :] if x not in (";", "&&", "||", "|")],
                )
            )
    if any(QUICK_MERGE.search(v) for p in printed for v in quick_variants(p)):
        deny(
            "a command substitution that prints `/merge` into a note or description "
            + QUICK_MSG
        )
    for w in words:
        if w.startswith("-") or w in (";", "&&", "||", "|", "<"):
            continue
        names = glob.glob(w)[:20] if any(ch in w for ch in "*?[") else [w.lstrip("<")]
        for f in names:
            check_body_file(f)


def check_sub_body(inner_raw):
    start = len(HEREDOC_BODIES)
    pre = preprocess(inner_raw, nested=True)
    check_sub_text(pre, range(start, len(HEREDOC_BODIES)))


MERGE_ENDPOINT = re.compile(
    r"merge_requests/[^\s/]+/(merge|cancel_merge_when_pipeline_succeeds)\b"
)


def endpoint_text(args):
    """API paths as GitLab resolves them: percent-decoded, with `//` and `/./` collapsed (blueprint#168)."""
    blob = " ".join(args)
    dec = unquote_plus(blob)
    return blob + "\n" + re.sub(r"/(?:\./)+|/{2,}", "/", dec)


def has_ansi_c_quote(cmd):
    """True when `$'` appears outside single quotes. A regex anchor such as grep '^x$' is
    inside single quotes (the `$` is literal there), so it must not trip the check."""
    in_single = False
    i = 0
    while i < len(cmd):
        c = cmd[i]
        if in_single:
            in_single = c != "'"
        elif c == "\\":
            i += 1
        elif c == "'":
            in_single = True
        elif c == "$" and cmd[i + 1 : i + 2] == "'":
            return True
        i += 1
    return False


def fetch_in_substitution(text):
    if re.search(r"\b(curl|wget)\b", text) and ("$(" in text or "`" in text):
        deny(
            'running downloaded text (`sh -c "$(curl ...)"`, `eval`) is the curl-to-shell pattern; download, read, then run.'
        )


def on_timeout(signum, frame):
    deny("command took too long to inspect (fail closed).")


def real_command_word(toks):
    """(index of the command word behind simple wrappers, env -S split string or None) (blueprint#168)."""
    k = 0
    while k < len(toks) and os.path.basename(toks[k]) in SIMPLE_WRAPPER_VALUE_OPTS:
        w = os.path.basename(toks[k])
        k += 1
        positionals = WRAPPER_POSITIONALS.get(w, 0)
        while k < len(toks):
            a = toks[k]
            if w == "flock" and a in ("-c", "--command") and k + 1 < len(toks):
                return k, (toks[k + 1], [])  # `flock /tmp/l -c 'git push -f'`
            if (
                re.fullmatch(r"-[A-Za-z]{2,}", a)
                and "-" + a[-1] in SIMPLE_WRAPPER_VALUE_OPTS[w]
                and k + 1 < len(toks)
            ):
                k += 2  # a cluster ending in a value option: `sudo -nu root`
                continue
            if positionals and not a.startswith("-"):
                positionals -= 1
                k += 1
                continue
            if w == "env":
                # `env -S 'git push -f'` re-splits a string into a command line.
                if (
                    a in ("-S", "--split-string") or re.fullmatch(r"-[A-Za-z]*S", a)
                ) and k + 1 < len(toks):
                    return k, (toks[k + 1], toks[k + 2 :])
                if a.startswith("--split-string="):
                    return k, (a.split("=", 1)[1], toks[k + 1 :])
                if re.fullmatch(r"-[A-Za-z]*S.+", a):
                    return k, (a[a.index("S") + 1 :], toks[k + 1 :])
            if a in SIMPLE_WRAPPER_VALUE_OPTS[w] and k + 1 < len(toks):
                k += 2
            elif (
                (a.startswith("-") and a != "-")
                or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", a)
                or (w == "timeout" and re.fullmatch(r"[0-9.]+[smhd]?", a))
            ):
                k += 1
            else:
                break
    return k, None


# The `;` after `cd` trap (blueprint#168): commands that change files, run after a cd that may have failed.
# Built from the writer table, so the two lists cannot drift (blueprint#168 round 2).
MUTATING = TAMPER_NAMES | {"make"}
GIT_READONLY = {
    "status",
    "log",
    "diff",
    "show",
    "rev-parse",
    "ls-files",
    "ls-tree",
    "cat-file",
    "grep",
    "blame",
    "describe",
    "shortlog",
    "fetch",
    "help",
    "version",
    "--version",
}


def is_mutating(word, args):
    name = os.path.basename(word)
    if name == "git":
        sub = next((a for a in args if not a.startswith("-")), "")
        return sub not in GIT_READONLY
    if name in ("sed", "perl", "ruby"):
        return inplace_flag(name, args)
    if name == "find":
        return find_writes(find_parts(args)[1])
    if name in SHELLS:
        return any(not a.startswith("-") for a in args)
    return (
        name in MUTATING
        or word.startswith(("./", "../", "scripts/", "bin/"))
        or word.endswith(".sh")
    )


def cd_target(args):
    """Where `cd ARGS` goes: an absolute or relative path, or None when it is not known from the text."""
    pos = [a for a in args if a not in ("-L", "-P", "-e", "-@", "--")]
    if not pos:
        t = "~"
    else:
        t = pos[0]
    home = os.environ.get("HOME", "")
    if re.match(r"^(?:~|\$HOME|\$\{HOME\})(?=/|$)", t):
        if not home.startswith("/"):
            return None
        t = re.sub(r"^(?:~|\$HOME|\$\{HOME\})", home.replace("\\", "\\\\"), t)
    t = re.sub(
        r"^\$\{?CLAUDE_PROJECT_DIR\}?(?=/|$)",
        (os.environ.get("CLAUDE_PROJECT_DIR", "") or "$").replace("\\", "\\\\"),
        t,
    )
    if (
        t == "-"
        or t.startswith("~")
        or "$" in t
        or "`" in t
        or any(ch in t for ch in "*?[")
    ):
        return None  # `~user`, `~-`, a variable or a glob: not known from the text
    return t


def moved(old, t):
    """The cwd after `cd t` from `old` (None is the session's own working directory)."""
    if t.startswith("/"):
        return os.path.normpath(t)
    if old == UNKNOWN:
        return UNKNOWN
    if old is None:
        return os.path.normpath(
            t
        )  # relative to the session cwd; bases() makes it absolute
    return os.path.normpath(os.path.join(old, t))


def unglue(t):
    """A substitution glued after other text adds only to it: `--force$(true)` is --force to the
    shell, so the option checks see --force. A word that starts with one is left alone."""
    if t.startswith(("$__SUBSTX", "$(", "`")):
        return t
    u = re.sub(r"\$__SUBSTX[0-9]+__|\$\([^()]*\)|`[^`]*`", "", t)
    return u or t


def is_substituted(word):
    return "__SUBSTX" in word or "`" in word or "$(" in word


def find_exec_words(args):
    return [sub[0] for sub in find_exec_cmds(find_parts(args)[1])]


def analyze(cmd, depth=0):
    if depth > 5:
        deny("command nests too deeply to inspect (fail closed).")
    saved_cwds = list(
        STATE["cwds"]
    )  # a nested command is a subshell: its cd ends with it
    start = len(HEREDOC_BODIES)
    pre = preprocess(cmd, nested=depth > 0)
    if has_ansi_c_quote(pre):
        deny(
            "ANSI-C quoting ($'...') hides command words from this hook; spell the command out."
        )
    # Substitutions run where the shell runs them: in the command text, and in the body of a
    # heredoc whose delimiter is unquoted. A quoted heredoc (<<'EOF') is literal, so a commit
    # message that quotes `git push --force` in backticks is not a command (blueprint#168).
    bodies = [
        "\n".join(HEREDOC_BODIES[h])
        for h in range(start, len(HEREDOC_BODIES))
        if not HEREDOC_QUOTED[h]
    ]
    for text, body in [(pre, False)] + [(b, True) for b in bodies]:
        for inner in substitutions(text, body):
            analyze(inner, depth + 1)
    segs, seps, hds, rds = split_segments(pre)
    prev_fetch = False
    parens = []  # state saved at each "(": a `( ... )`, `$( ... )` or `<( ... )` is a subshell
    pending = None  # after `cd X ||`: the cwds that hold if the next segment exits
    semi_cd = None  # a `cd X` that may have failed while the line runs on
    chain_start = list(STATE["cwds"])  # the cwds when the current `&&` list began
    chain_cd = None  # a `cd X &&` inside the current `&&` list
    cond = []  # (cwds before, target) for each `if cd X; then` still open
    hist = []  # cwds before each cd, for `cd -` and `popd`
    prev_content = None  # what the previous segment printed, for `echo x | tee f`
    # `case WORD in PAT) cmd;; esac`: WORD and the patterns are data, not commands, and the `)`
    # after a pattern closes no subshell (blueprint#168 completeness round).
    case_depth, expect_pattern, skip_close = 0, False, False
    for idx, toks in enumerate(segs):
        sep_before = seps[idx - 1] if idx > 0 else ""
        sep_after = seps[idx] if idx < len(seps) else ""
        if case_depth and (";;" in sep_before or ";&" in sep_before):
            expect_pattern = True
        for ch in sep_before:
            if ch == "(" and expect_pattern:
                continue  # the optional `(` of `(pat)`
            if ch == ")" and skip_close:
                skip_close = False
                continue
            if ch == "(":
                parens.append((list(STATE["cwds"]), chain_start, chain_cd))
            elif ch == ")" and parens:
                # The subshell's own cds end here, but a `cd X &&` from before it still may have failed.
                STATE["cwds"], chain_start, chain_cd = parens.pop()
        # A `&&` list ends at `;`, `&`, a newline or `||`: what follows runs even if a `cd X &&`
        # inside it failed, so the directories from before the list come back (blueprint#168:
        # `cd /tmp/s && echo hi ; mv .git x`).
        if sep_before == "||" or (
            sep_before not in ("&&", "|&") and any(c in ";&" for c in sep_before)
        ):
            if chain_cd is not None:
                STATE["cwds"] = list(dict.fromkeys(STATE["cwds"] + chain_start))
                if sep_before != "||":
                    semi_cd = chain_cd
            chain_start, chain_cd = list(STATE["cwds"]), None
        if len(STATE["cwds"]) > 8:
            STATE["cwds"] = [
                None,
                UNKNOWN,
            ]  # bounded work: many `cd X ;` collapse to "unknown"
        toks = list(toks)
        # Words inside an array literal (`files=($(git ls-files))`) are not commands.
        in_array = (
            idx > 0
            and sep_before == "("
            and bool(segs[idx - 1])
            and segs[idx - 1][-1].endswith("=")
        )
        if any(t.startswith("CDPATH=") for t in toks):
            STATE["cdpath"] = True  # a relative cd no longer resolves against the cwd
        # GIT_CONFIG_* anywhere in a segment (export, env, a leading assignment) can set
        # core.hooksPath or alias.* without `git -c`; GIT_CONFIG_GLOBAL/SYSTEM=<file> point git at a
        # config file that can (blueprint#168; /dev/null, the usual test isolation, cannot).
        for t in toks:
            m = re.fullmatch(r"GIT_CONFIG(?:_GLOBAL|_SYSTEM)?=(.*)", t)
            if re.match(r"GIT_CONFIG_(COUNT|PARAMETERS|KEY_|VALUE_)", t) or (
                m and m.group(1) not in ("", "/dev/null")
            ):
                deny(
                    "GIT_CONFIG_* environment overrides can disable hooks or smuggle denied git behavior; use real flags."
                )
        if WORKER["root"]:
            worker_env(toks)
        toks = strip_redirects(toks)
        STATE["tokens"].extend(toks)
        if toks[:1] == ["case"]:
            case_depth += 1
            expect_pattern = True
        if (
            case_depth
            and expect_pattern
            and toks[:1] != ["esac"]
            and (toks[:1] == ["case"] or sep_after.startswith(")"))
        ):
            # The case header, or a pattern: skip it, and the `)` that ends the pattern.
            check_redirects(rds[idx])
            if sep_after.startswith(")"):
                skip_close, expect_pattern = True, False
            prev_fetch, prev_content = False, None
            continue
        if toks[:1] == ["esac"]:
            case_depth, expect_pattern = max(0, case_depth - 1), False
        elif toks:
            expect_pattern = False
        # drop leading VAR=value assignments
        condition = (
            False  # `if cd x; then ...`: the body runs only when the cd succeeded
        )
        while toks and (
            re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", toks[0]) or toks[0] in KEYWORDS
        ):
            if toks[0] == "function" and len(toks) > 1:
                toks.pop(0)  # also drop the function's name
            condition = condition or toks[0] in ("if", "elif", "while", "until")
            if cond and toks[0] in ("else", "elif", "fi", "done"):
                # The else branch, and whatever follows fi/done, run when the cd failed too.
                before, target = cond[-1] if toks[0] in ("else", "elif") else cond.pop()
                STATE["cwds"] = list(dict.fromkeys(STATE["cwds"] + before))
                if toks[0] in ("fi", "done"):
                    semi_cd = target
            toks.pop(0)
            toks = strip_redirects(toks)
        # Only a real `exit` ends the line: `return` outside a function does not, and an exit in a
        # pipeline or in the background runs in a subshell.
        exits = (
            bool(toks[:1]) and toks[0] == "exit" and sep_after not in ("|", "|&", "&")
        )
        if pending is not None:
            # `cd X || exit 1`: the exit runs where the failed cd left it; past it, the cd succeeded.
            if exits:
                check_redirects(rds[idx])
                STATE["cwds"] = pending
                pending = None
                continue
            STATE["cwds"] = list(dict.fromkeys(STATE["cwds"] + pending))
            pending = None
        check_redirects(rds[idx])
        if not toks:
            prev_fetch = False
            prev_content = None
            continue
        cw, split = real_command_word(toks)
        word = toks[cw] if cw < len(toks) else ""
        # A command word produced by a substitution is known only once the shell has run it (blueprint#168).
        # `$(npm bin)/eslint` is fine: split_segments() turns a substitution that only prints a
        # directory into $__SUBST__, and the literal basename is inspected as usual.
        if not in_array and (
            is_substituted(word)
            or (word.endswith("$") and cw == len(toks) - 1 and sep_after == "(")
        ):
            deny(
                "a command word produced by a command substitution (`$(which git) push`, `$(echo rm) -rf`) cannot be inspected by this hook; spell the command out."
            )
        if not in_array and re.fullmatch(r"\$\{?[A-Za-z_][A-Za-z0-9_]*\}?", word):
            deny(
                "a command word taken from a variable cannot be inspected by this hook; spell the command out."
            )
        if os.path.basename(word) == "find" or os.path.basename(toks[0]) == "find":
            fargs = toks[toks.index(word) + 1 :] if word in toks else toks[1:]
            if any(
                is_substituted(w) or re.fullmatch(r"\$\{?[A-Za-z_][A-Za-z0-9_]*\}?", w)
                for w in find_exec_words(fargs)
            ):
                deny(
                    "a `find -exec` command produced by a substitution or a variable cannot be inspected by this hook; spell it out."
                )
        if split is not None:
            analyze(
                split[0] + (" " + shlex.join(split[1]) if split[1] else ""), depth + 1
            )
        toks = [unglue(t) for t in toks]
        check_tamper(
            toks
        )  # after the keyword strip: `do cp x hooks/y`, `{ sed -i ...; }`, `! rm ...`
        name = os.path.basename(toks[0])
        if WORKER["root"] and not (
            name in ("cd", "pushd", "popd")
            or (name == "builtin" and toks[1:2] == ["cd"])
        ):
            worker_segment(toks)
        if name in ("cd", "pushd", "popd") or (
            name == "builtin" and toks[1:2] == ["cd"]
        ):
            cargs = toks[2:] if name == "builtin" else toks[1:]
            ok_only = (
                sep_after == "&&" or condition
            )  # what follows runs only if the cd succeeded
            plain = [a for a in cargs if a not in ("--", "-L", "-P", "-e", "-@")]
            STATE["oldpwd"] = list(STATE["cwds"])
            if WORKER["root"]:
                worker_cd(
                    name,
                    plain,
                    None
                    if name == "popd"
                    or plain[:1] in (["-"], ["~-"])
                    or not plain
                    and name == "pushd"
                    else cd_target(cargs),
                )
            if name == "popd" or plain[:1] in (["-"], ["~-"]):
                new = (
                    hist.pop() if hist else [None]
                )  # back where the line was before the cd
                if name != "popd":
                    hist.append(list(STATE["cwds"]))
            else:
                t = cd_target(cargs)
                if t is not None and not t.startswith("/") and STATE["cdpath"]:
                    t = None  # CDPATH decides where a relative cd lands
                hist.append(list(STATE["cwds"]))
                new = list(
                    dict.fromkeys(
                        UNKNOWN if t is None else moved(c, t) for c in STATE["cwds"]
                    )
                )
            label = toks[-1] if len(toks) > 1 else "~"
            if condition and sep_after != "&&":
                cond.append((list(STATE["cwds"]), label))
                STATE["cwds"] = new
            elif sep_after == "&&":
                if chain_cd is None:
                    chain_cd = label
                STATE["cwds"] = new
            elif sep_after == "||":
                pending = new
            elif sep_after in ("|", "|&"):
                if hist and name != "popd":
                    hist.pop()  # a cd in a pipeline runs in a subshell
            else:
                STATE["cwds"] = list(dict.fromkeys(STATE["cwds"] + new))
            if sep_after in (";", "&") and not ok_only:
                # Armed even when the target is unknown (`cd "$WT" ;`): that is the failed-cd shape.
                semi_cd = label
            prev_fetch = False
            prev_content = None
            continue
        if (
            (name in SHELLS or name in ("source", "."))
            and idx < len(seps)
            and seps[idx] == "<("
        ):
            deny(
                "running a shell or `source` on a process substitution hides the commands from this hook; write them out."
            )
        if (name in SHELLS or name in ("source", ".")) and any(
            a in ("/dev/stdin", "-")
            or re.fullmatch(r"/dev/fd/[0-9]+|/proc/self/fd/[0-9]+", a)
            for a in toks[1:]
        ):
            deny(
                "running a shell or `source` on /dev/stdin or a file descriptor hides the commands from this hook; write them out."
            )
        if toks[0] not in ("[", "[[") and re.search(r"[\[\]*?{]", toks[0]):
            deny(
                "a glob or brace expansion in the command word hides the command from this hook; spell it out."
            )
        # Remember what this segment writes into a file, so a later post that reads the file is
        # checked against it (blueprint#168): `cat > b.md <<EOF ... EOF; glab mr note 1 -m "$(cat b.md)"`.
        content = [line for hid in hds[idx] for line in HEREDOC_BODIES[hid]]
        if name in ("echo", "printf"):
            content.append(printed_text(name, toks[1:]))
        if name == "tee" and prev_content and sep_before in ("|", "|&"):
            content.append(prev_content)
        if content:
            text = "\n".join(content)
            targets = [(op, p) for op, p in rds[idx] if op in (">", ">>")]
            if name == "tee":
                targets += [
                    (">>" if any(a in ("-a", "--append") for a in toks[1:]) else ">", a)
                    for a in toks[1:]
                    if not a.startswith("-")
                ]
            for op, p in targets:
                # An append keeps what the file already holds (on disk, or written earlier on the line).
                record_file(p, (body_texts(p) if op == ">>" else []) + [text])
        prev_content = "\n".join(content) if content else None
        if (
            semi_cd is not None
            and is_mutating(word, toks[cw + 1 :])
            and not STATE["warn"]
        ):
            STATE["warn"].append(
                "pre-bash-deny: `cd "
                + semi_cd
                + "` may fail while this line goes on (it is followed by `;`, a newline, `fi` or `done`), "
                "and then `"
                + os.path.basename(word)
                + "` and the rest run in the directory the line started in. "
                "Chain with `&&` (`cd DIR && ...`) so a failed cd stops the line (CLAUDE.md, Shell and git traps)."
            )
        while toks and name in WRAPPERS:
            k = 1
            while k < len(toks) and os.path.basename(toks[k]) not in WATCHED:
                k += 1
            toks = toks[k:]
            name = os.path.basename(toks[0]) if toks else ""
        if not toks:
            prev_fetch = False
            continue
        args = toks[1:]
        if name in ("glab", "curl", "wget"):
            STATE["posts"] = True
            if any(
                QUICK_HEREDOC.match(line)
                for hid in hds[idx]
                for line in HEREDOC_BODIES[hid]
            ):
                deny(
                    "a heredoc body with a line starting `/merge` fed to glab/curl "
                    + QUICK_MSG
                )
            if any(x == "-" or x.endswith("@-") for x in args):
                STATE["stdin_post"] = (
                    True  # the body arrives on stdin from an earlier segment
                )
                j = idx - 1
                while j >= 0 and seps[j] in ("|", "|&"):  # what feeds this pipeline
                    if any(
                        QUICK_HEREDOC.match(line)
                        for hid in hds[j]
                        for line in HEREDOC_BODIES[hid]
                    ):
                        deny(
                            "a piped heredoc body with a line starting `/merge` fed to glab/curl "
                            + QUICK_MSG
                        )
                    # `cat f | curl -d @-`: the files the feeding command reads.
                    for f in [w for w in segs[j][1:] if not w.startswith("-")] + [
                        p for op, p in rds[j] if op == "<"
                    ]:
                        check_body_file(f, strict=False)
                    j -= 1
            check_quick_action(args)
            # A body built by a command substitution, read from a file, or redirected in (blueprint#168).
            for a in toks[1:] + [t for t in segs[idx] if SUBST_WORD.search(t)]:
                if "$(" in a or "`" in a:
                    try:
                        for inner in substitutions(a):
                            check_sub_body(inner)
                    except Parse:
                        # `a` is a shlex word: a `"` in a heredoc body inside `"$(cat <<'EOF' ...)"`
                        # split it, so the substitution is cut short here. The full command text was
                        # scanned above; check every line of the piece as a possible body line.
                        if any(QUICK_HEREDOC.match(line) for line in a.split("\n")):
                            deny(
                                "a heredoc in a command substitution with a line starting `/merge` "
                                + QUICK_MSG
                            )
                for m in SUBST_WORD.finditer(a):
                    inner = STATE["subst"][int(m.group(1))]
                    check_sub_text(
                        inner, [int(h) for h in re.findall(r"\x03([0-9]+)", inner)]
                    )
                # A substitution glued to literal text: `"$(echo /mer)ge"` posts /merge (blueprint#168 round 2).
                rendered = render_substitutions(a)
                if rendered != a:
                    check_quick_action([rendered])
            for f in post_files(args, name == "glab") + [
                p for op, p in rds[idx] if op == "<"
            ]:
                check_body_file(f)
        piped = idx > 0 and seps[idx - 1] in ("|", "|&")
        if name in SHELLS and piped and prev_fetch:
            deny(
                "piping a download into a shell (`curl | sh`) runs unreviewed code; download, read, then run."
            )
        prev_fetch = name in ("curl", "wget")
        if name == "git":
            check_git(args)
        elif name == "glab":
            check_glab(args)
        elif name == "rm":
            check_rm(args)
        elif name in ("curl", "wget"):
            if MERGE_ENDPOINT.search(endpoint_text(args)):
                deny(
                    "merging through a raw API call is forbidden: a coding agent never merges an MR (CLAUDE.md)."
                )
        elif name == "eval":
            fetch_in_substitution(" ".join(args))
            analyze(" ".join(args), depth + 1)
        elif name == "trap":
            # Round 4 (every session): a trap action runs later, so check it like eval.
            # `trap 'git push --force origin main' EXIT` slipped past.
            targs = args[1:] if args[:1] == ["--"] else args
            if targs and targs[0] not in ("-", "-p", "-l", "-P"):
                fetch_in_substitution(targs[0])
                analyze(targs[0], depth + 1)
        elif name in SHELLS:
            has_c = any(re.fullmatch(r"-[A-Za-z]*c[A-Za-z]*", a) for a in args)
            has_script = any(
                not a.startswith("-")
                and not re.fullmatch(r"[0-9]*[<>&]+", a)
                and (k == 0 or not re.fullmatch(r"[0-9]*[<>&]+", args[k - 1]))
                for k, a in enumerate(args)
            )
            if (
                not has_c
                and not has_script
                and (
                    piped
                    or "<<" in cmd
                    or hds[idx]
                    or any(re.fullmatch(r"[0-9]*<", a) for a in args)
                )
            ):
                deny(
                    "feeding a shell through stdin (pipe, heredoc, here-string) hides the commands from this hook; write the commands out directly."
                )
            if has_c and re.fullmatch(r"-[A-Za-z]*c[A-Za-z]*", args[-1]):
                deny(
                    "`sh -c` with no command string takes its script from elsewhere (xargs, stdin); write the commands out directly."
                )
            for k, a in enumerate(args):
                if re.fullmatch(r"-[A-Za-z]*c[A-Za-z]*", a) and k + 1 < len(args):
                    fetch_in_substitution(args[k + 1])
                    analyze(args[k + 1], depth + 1)
                    break
    if depth:
        STATE["cwds"] = saved_cwds


try:
    event = json.load(sys.stdin)
except Exception:
    deny("could not read the hook event from stdin (fail closed).")
try:
    if not isinstance(event, dict) or event.get("tool_name") != "Bash":
        sys.exit(0)
    tool_input = event.get("tool_input")
    if tool_input is not None and not isinstance(tool_input, dict):
        deny("the Bash tool input has an unexpected shape (fail closed).")
    command = (tool_input or {}).get("command")
    if command is not None and not isinstance(command, str):
        deny("the Bash command is not a string (fail closed).")
    if not command or not command.strip():
        sys.exit(0)
    if len(command) > 65536:
        deny("command is too large to inspect (fail closed).")
    signal.signal(signal.SIGALRM, on_timeout)
    signal.alarm(
        5
    )  # the harness kills a hook at its timeout and that does not block: deny first
    STATE["event_cwd"] = event.get("cwd") if isinstance(event.get("cwd"), str) else ""
    set_worker(event)
    load_unlock(event)
    if WORKER["root"]:
        worker_scan_text(command)
    analyze(command)
    if STATE["stdin_post"] and any(
        QUICK_AT_LINE_START.search(t) for t in STATE["tokens"]
    ):
        deny(
            "a body piped into glab/curl with a line starting `/merge` is a GitLab quick action that merges the MR; a coding agent never merges (CLAUDE.md)."
        )
    if STATE["warn"]:
        # A warning, not a block: exit 0 with additionalContext and no permissionDecision, which
        # would skip the user's permission prompt (docs/harness/pre-bash-deny.md).
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "additionalContext": "\n".join(STATE["warn"]),
                    }
                }
            )
        )
except Parse as e:
    deny(
        "could not parse the command ("
        + str(e)
        + "); rewrite it more simply (fail closed)."
    )
except (
    Exception
):  # an uncaught traceback exits 1, which the harness treats as a non-blocking error
    deny(
        "internal error while inspecting the command (fail closed); rewrite it more simply."
    )
sys.exit(0)
