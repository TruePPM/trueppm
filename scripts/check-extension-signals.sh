#!/usr/bin/env bash
# Guard the two properties of an OSS→Enterprise extension-signal dispatch that
# nothing else can observe: that it is ROBUST, and that its SENDER is one a
# receiver can actually register against.
#
# Part 1 (#2606) fails a signal dispatched with plain `.send()`.
# Part 2 (#3777) fails a `dispatch_extension_signal()` whose sender is not a
# model class or None. Both failure modes are silent by construction — one
# breaks the OSS write path from enterprise code, the other leaves an enterprise
# receiver that never fires — so neither has any tell but this script.
#
# The Apache 2.0 boundary promises that OSS keeps working regardless of what
# enterprise code does. `Signal.send()` breaks that promise at the dispatch site:
# a receiver's exception propagates back to the sender, so a bug in enterprise
# code fails the OSS write path that fired the signal. `history_record_created`
# is wired to the post_save of every Historical* row for Project, Task and
# Dependency, which made it a single receiver away from breaking every task save
# in the product (#2606).
#
# The invariant was documented in five skills and honored at 7 of 15 sites. This
# is the check that makes it mechanical rather than conventional.
#
# ## What counts
#
# The signal set is discovered, not hardcoded: every `<name> = Signal()` or
# `<name> = django.dispatch.Signal()` under packages/api/src. So a signal added
# tomorrow is covered without touching this script — which matters, because the
# failure mode here is a NEW extension point written in the old style.
#
# Allowed dispatch: `dispatch_extension_signal(<name>, ...)` (send_robust plus a
# log line) or a direct `<name>.send_robust(...)`.
#
# ## The fail-closed exception
#
# A veto signal — one where a receiver raising is the MECHANISM, not a fault —
# must keep `.send()`. `agent_action_prune_requested` is the legal-hold veto on
# agent-action pruning: making it robust would swallow a hold that failed to
# register and let the prune proceed, inverting the safety property. Mark such a
# site with `FAIL-CLOSED` in a comment within 12 lines above the call and this
# gate allows it. The marker is deliberately explicit — the whole point is that
# the next audit reads the reason instead of "fixing" it.
#
# Usage:
#   check-extension-signals.sh [ROOT]     # ROOT defaults to packages/api/src
#   check-extension-signals.sh --self-test
#
# Exit codes:
#   0  every extension signal is dispatched robustly (or annotated FAIL-CLOSED)
#      and every sender is a model class or None
#   1  at least one bare .send(), or at least one bad sender, found
#   2  invocation error

set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=lib/git-ignored.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/git-ignored.sh"

if [ "${1:-}" = "--self-test" ]; then
  # Prove this gate can still fail, in the job that runs it (#3195).
  #
  # `boundary:imports` passed a real enterprise import for its entire life
  # (#3172) while a test suite for it passed too — in a different image. So
  # every case below runs the REAL script against a fixture root, in this job,
  # on this image. There is no second copy of the detection patterns to drift.
  #
  # Both directions are asserted, and by EXACT exit code rather than
  # pass/non-pass. That distinction is load-bearing here: a fixture with no
  # `= Signal()` declaration at all exits 2 ("no signals found"), which a
  # non-zero-means-rejected probe would score as a successful detection while
  # the detector never ran. `reject` therefore means exit 1 specifically.
  st_tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand now, not at trap time
  trap "rm -rf '$st_tmp'" EXIT
  st_rc=0
  st_probe() { # <name> <accept|reject|error> <dir>
    case "$2" in
      accept) want=0 ;;
      reject) want=1 ;;
      error)  want=2 ;;
      *) echo "SELF-TEST: bad expectation '$2'" >&2; st_rc=1; return ;;
    esac
    got=0
    bash "$0" "$3" >/dev/null 2>&1 || got=$?
    if [ "$got" -eq "$want" ]; then
      echo "SELF-TEST OK: $1 — $2 (exit $got)."
    else
      echo "SELF-TEST FAILED: $1 — expected $2 (exit $want), got exit $got." >&2
      st_rc=1
    fi
  }

  # Every fixture declares its signal the way the discovery grep expects, so an
  # expect-reject case that finds nothing to check is a self-test failure rather
  # than a silent pass.
  st_sig() { printf 'from django.dispatch import Signal\n\nthing_happened = Signal()\n' > "$1/signals.py"; }

  d="$st_tmp/robust"; mkdir -p "$d"; st_sig "$d"
  printf 'from trueppm_api.core.extension_signals import dispatch_extension_signal\nfrom .signals import thing_happened\n\n\ndef go():\n    dispatch_extension_signal(thing_happened, sender=None)\n' > "$d/services.py"
  st_probe "dispatch_extension_signal()" accept "$d"

  d="$st_tmp/send_robust"; mkdir -p "$d"; st_sig "$d"
  printf 'from .signals import thing_happened\n\n\ndef go():\n    thing_happened.send_robust(sender=None)\n' > "$d/services.py"
  st_probe "direct .send_robust()" accept "$d"

  # The violation this gate exists to catch.
  d="$st_tmp/bare_send"; mkdir -p "$d"; st_sig "$d"
  printf 'from .signals import thing_happened\n\n\ndef go():\n    thing_happened.send(sender=None)\n' > "$d/services.py"
  st_probe "bare Signal().send()" reject "$d"

  # The other declaration style, which the discovery grep must also find — a new
  # extension point written `django.dispatch.Signal()` is exactly the case that
  # would otherwise be invisible to the whole gate.
  d="$st_tmp/dotted_decl"; mkdir -p "$d"
  printf 'import django.dispatch\n\nthing_happened = django.dispatch.Signal()\n' > "$d/signals.py"
  printf 'from .signals import thing_happened\n\n\ndef go():\n    thing_happened.send(sender=None)\n' > "$d/services.py"
  st_probe "bare .send() on a django.dispatch.Signal()" reject "$d"

  # The documented exemption has to hold too, or the gate becomes noisy enough
  # to get disabled -- which is how the protection is really lost.
  d="$st_tmp/fail_closed"; mkdir -p "$d"; st_sig "$d"
  printf 'from .signals import thing_happened\n\n\ndef go():\n    # FAIL-CLOSED: a hold that failed to register must abort the prune.\n    thing_happened.send(sender=None)\n' > "$d/services.py"
  st_probe "FAIL-CLOSED annotated .send()" accept "$d"

  # ...and the exemption has to be a WINDOW, not a file-wide keyword. A marker
  # 13 lines up is a different call site's reason.
  d="$st_tmp/fail_closed_far"; mkdir -p "$d"; st_sig "$d"
  { printf 'from .signals import thing_happened\n\n\ndef go():\n    # FAIL-CLOSED: this reason belongs to a call further down.\n'
    i=0; while [ "$i" -lt 13 ]; do printf '    pass\n'; i=$((i + 1)); done
    printf '    thing_happened.send(sender=None)\n'
  } > "$d/services.py"
  st_probe "FAIL-CLOSED marker 13 lines above the call" reject "$d"

  # --- Part 2: the sender convention (#3777) ---------------------------------
  #
  # Same discipline as above: the real script, this job, this image. The reject
  # cases are the two spellings that actually shipped (`type(task).__name__` and
  # a bare task-name string), plus the omission, because a sender= that is
  # simply absent is the same silent never-fires with less to grep for.

  d="$st_tmp/sender_class"; mkdir -p "$d"; st_sig "$d"
  printf 'from trueppm_api.core.extension_signals import dispatch_extension_signal\nfrom .signals import thing_happened\n\n\ndef go(obj):\n    dispatch_extension_signal(thing_happened, sender=TheModel, thing_id="1")\n' > "$d/services.py"
  st_probe "sender=<class-cased name>" accept "$d"

  d="$st_tmp/sender_type_call"; mkdir -p "$d"; st_sig "$d"
  printf 'from trueppm_api.core.extension_signals import dispatch_extension_signal\nfrom .signals import thing_happened\n\n\ndef go(obj):\n    dispatch_extension_signal(thing_happened, sender=type(obj), thing=obj)\n' > "$d/services.py"
  st_probe "sender=type(obj)" accept "$d"

  # The bug this half of the gate exists to catch.
  d="$st_tmp/sender_dunder_name"; mkdir -p "$d"; st_sig "$d"
  printf 'from trueppm_api.core.extension_signals import dispatch_extension_signal\nfrom .signals import thing_happened\n\n\ndef go(task):\n    dispatch_extension_signal(thing_happened, sender=type(task).__name__, task=task)\n' > "$d/services.py"
  st_probe "sender=type(task).__name__" reject "$d"

  d="$st_tmp/sender_lowercase"; mkdir -p "$d"; st_sig "$d"
  printf 'from trueppm_api.core.extension_signals import dispatch_extension_signal\nfrom .signals import thing_happened\n\n\ndef go(task_name):\n    dispatch_extension_signal(thing_happened, sender=task_name)\n' > "$d/services.py"
  st_probe "sender=<lowercase name>" reject "$d"

  d="$st_tmp/sender_string_literal"; mkdir -p "$d"; st_sig "$d"
  printf 'from trueppm_api.core.extension_signals import dispatch_extension_signal\nfrom .signals import thing_happened\n\n\ndef go():\n    dispatch_extension_signal(thing_happened, sender="TheModel")\n' > "$d/services.py"
  st_probe "sender=<string literal>" reject "$d"

  d="$st_tmp/sender_missing"; mkdir -p "$d"; st_sig "$d"
  printf 'from trueppm_api.core.extension_signals import dispatch_extension_signal\nfrom .signals import thing_happened\n\n\ndef go():\n    dispatch_extension_signal(thing_happened, thing_id="1")\n' > "$d/services.py"
  st_probe "no sender= argument" reject "$d"

  # A root with no `= Signal()` at all must be an invocation error, never a
  # quiet OK. This is the guard that keeps the reject cases above honest.
  d="$st_tmp/no_signals"; mkdir -p "$d"
  printf 'def go():\n    return 1\n' > "$d/services.py"
  st_probe "root with no Signal() declarations" error "$d"

  [ "$st_rc" -eq 0 ] && echo "SELF-TEST: all cases passed."
  exit "$st_rc"
fi

ROOT="${1:-packages/api/src}"

if [ ! -d "$ROOT" ]; then
  echo "ERROR: '$ROOT' is not a directory. Run from the repository root." >&2
  exit 2
fi

# Discover the extension-signal names.
#
# `|| true` on the pipeline: grep exits 1 when it matches nothing and 2 when it
# rejects an option, and under `set -euo pipefail` either killed the script
# right here — at exit 1, with no output at all. That made the empty-set alarm
# below unreachable, which is the #3172 shape exactly: the case the author wrote
# a diagnostic for was the one case that could never print it. Swallow the
# status and let the explicit check answer.
signals=$(grep -rhE '^[a-z_]+ = (django\.dispatch\.)?Signal\(\)' "$ROOT" --include='*.py' 2>/dev/null \
  | sed -E 's/^([a-z_]+) = .*/\1/' | sort -u || true)

if [ -z "$signals" ]; then
  echo "ERROR: no Signal() definitions found under $ROOT — has the declaration" >&2
  echo "       style changed? A silent empty set would pass this gate forever." >&2
  exit 2
fi

violations=0
checked=0

for sig in $signals; do
  # Bare `.send(` on this signal, excluding `.send_robust(`.
  hits=$(grep -rn "${sig}\.send(" "$ROOT" --include='*.py' 2>/dev/null || true)
  hits="$(printf '%s\n' "$hits" | drop_ignored_lines)"
  [ -z "$hits" ] && continue
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    file="${hit%%:*}"
    rest="${hit#*:}"
    lineno="${rest%%:*}"
    checked=$((checked + 1))
    # FAIL-CLOSED marker in the 12 lines above the call?
    start=$((lineno > 12 ? lineno - 12 : 1))
    if grep -q 'FAIL-CLOSED' <<<"$(sed -n "${start},${lineno}p" "$file" 2>/dev/null)"; then
      continue
    fi
    echo "VIOLATION: $file:$lineno — ${sig}.send() is not robust"
    violations=$((violations + 1))
  done <<< "$hits"
done

if [ "$violations" -gt 0 ]; then
  cat <<'MSG'

An OSS→Enterprise extension signal is dispatched with plain .send(), so an
exception raised by ANY receiver propagates to the sender. Enterprise registers
receivers against these signals; with .send(), a bug in enterprise code breaks
the OSS write path that fired it. That inverts the boundary contract — OSS must
work regardless of what enterprise does.

Fix:
  from trueppm_api.core.extension_signals import dispatch_extension_signal
  dispatch_extension_signal(the_signal, sender=..., **payload)

UNLESS the signal is a deliberate fail-closed veto, where a receiver raising is
the mechanism rather than a fault. In that case keep .send() and write a comment
containing FAIL-CLOSED, within 12 lines above the call, saying why — see
agent_action_prune_requested in apps/agents/services.py.
MSG
  exit 1
fi

echo "OK: all extension signals dispatch robustly (${checked} annotated fail-closed site(s) allowed)."

# ---------------------------------------------------------------------------
# Part 2: the sender convention (#3777)
# ---------------------------------------------------------------------------
#
# `sender` must be a model CLASS, or None where the signal is not about a model
# row. Django filters receivers on sender IDENTITY and has no notion of a wrong
# one: `@receiver(sig, sender=SomeClass)` against a dispatch that sends the
# string "SomeClass" simply never runs. No error, no warning, and nothing on the
# Enterprise side that could notice — which is how ten sites ended up sending a
# class and six a string.
#
# mypy --strict already rejects a non-class at a call site whose sender
# expression it can type. This pass exists for the ones it cannot: every Celery
# bridge argument in scheduling/apps.py is `Any`, and `Any` is assignable to
# `type[Any] | None`, so `sender=type(task).__name__` type-checked clean for the
# whole life of the bug. Shape is checkable where type is not.
#
# Allowed sender expressions (an ALLOWLIST — a denylist of known-bad spellings
# would pass the next one somebody invents):
#   None                  the signal is not about a model row
#   SomeClass             a class-cased bare name
#   module.SomeClass      a dotted path ending in a class-cased name
#   type(expr)            a genuinely dynamic model class
# Rejected: string literals, f-strings, `.__name__`, lowercase names, and any
# other call. A missing `sender=` is rejected too — it is a required kwarg.
#
# python3 is required for the AST walk below. A missing interpreter must be an
# invocation error, never a silent no-op — `xargs -0 python3` failing under the
# `2>/dev/null` redirect otherwise leaves sender_hits empty and every reject
# case above passes as an accept, exactly as happened when the job's image
# installed bash/grep/sed but not python3 (#3777 self-test failure in CI).
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required to check the dispatch_extension_signal() sender convention" >&2
  exit 2
fi

sender_hits=$(find "$ROOT" -name '*.py' -type f -print0 2>/dev/null \
  | xargs -0 python3 -c '
import ast
import re
import sys

CLASS_CASED = re.compile(r"^_?[A-Z][A-Za-z0-9_]*$")


def allowed(node):
    """True when this sender= expression is class-shaped or an explicit None."""
    if isinstance(node, ast.Constant) and node.value is None:
        return True
    if isinstance(node, ast.Name):
        return bool(CLASS_CASED.match(node.id))
    if isinstance(node, ast.Attribute):
        # A dotted path: only the final segment names the class.
        return bool(CLASS_CASED.match(node.attr))
    if isinstance(node, ast.Call):
        # type(x) — the one dynamic form that still yields a class.
        return isinstance(node.func, ast.Name) and node.func.id == "type"
    return False


for path in sys.argv[1:]:
    try:
        with open(path, encoding="utf-8") as fh:
            tree = ast.parse(fh.read(), filename=path)
    except (OSError, SyntaxError, UnicodeDecodeError):
        # Unreadable or not parseable as Python: not this gate to report.
        continue
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")
        if name != "dispatch_extension_signal":
            continue
        # A **splat could carry sender in a way no static pass can see.
        if any(kw.arg is None for kw in node.keywords):
            continue
        sender = next((kw.value for kw in node.keywords if kw.arg == "sender"), None)
        if sender is None:
            print("%s:%d: no sender= argument" % (path, node.lineno))
            continue
        if not allowed(sender):
            try:
                shown = ast.unparse(sender)
            except Exception:  # pragma: no cover - unparse is total in 3.12
                shown = "<unparseable>"
            print("%s:%d: sender=%s" % (path, node.lineno, shown))
' 2>/dev/null || true)

sender_hits="$(printf '%s\n' "$sender_hits" | drop_ignored_lines)"
sender_violations=0
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  echo "VIOLATION: $hit — sender must be a model class or None"
  sender_violations=$((sender_violations + 1))
done <<< "$sender_hits"

if [ "$sender_violations" -gt 0 ]; then
  cat <<'MSG'

An OSS→Enterprise extension signal is dispatched with a sender that is not a
model class. Django's dispatcher filters receivers on sender IDENTITY, so an
enterprise receiver written `@receiver(the_signal, sender=TheModel)` against a
string sender NEVER FIRES — silently, with nothing logged on either side (#3777).

Fix — pass the model class the signal is about:
  dispatch_extension_signal(the_signal, sender=TheModel, **payload)

Or, where the signal is genuinely not about a model row (the Celery worker-run
signals are the only such family today), pass None and put the discriminator in
the payload:
  dispatch_extension_signal(the_signal, sender=None, task_name=name, ...)

The convention, and the kwarg rule that goes with it, are in the module
docstring of packages/api/src/trueppm_api/core/extension_signals.py.
MSG
  exit 1
fi

echo "OK: every dispatch_extension_signal() sender is a model class or None."
